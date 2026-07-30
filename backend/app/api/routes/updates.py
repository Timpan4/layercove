"""Read-only application update routes."""

import logging
import os
import re
import time

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.config import APP_VERSION, GITHUB_REPO
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.settings import Settings
from backend.app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/updates", tags=["updates"])

_GITHUB_RATE_LIMIT_FALLBACK_SECONDS = 3600
_github_rate_limit_until: float = 0.0


def _seconds_until_github_unblocked() -> float:
    """Return seconds remaining until GitHub backoff lifts, or zero."""
    remaining = _github_rate_limit_until - time.time()
    return remaining if remaining > 0 else 0.0


def _record_github_rate_limit(response: httpx.Response) -> None:
    """Set the backoff window from a GitHub rate-limit response."""
    global _github_rate_limit_until
    reset_header = response.headers.get("X-RateLimit-Reset")
    reset_at: float | None = None
    if reset_header:
        try:
            reset_at = float(reset_header)
        except ValueError:
            pass
    if reset_at is None:
        reset_at = time.time() + _GITHUB_RATE_LIMIT_FALLBACK_SECONDS
    reset_at = max(reset_at, time.time() + 60)
    if reset_at > _github_rate_limit_until:
        _github_rate_limit_until = reset_at
    logger.warning(
        "GitHub rate limit hit; suppressing update checks for %.0fs (reset header=%s)",
        _seconds_until_github_unblocked(),
        reset_header,
    )


def _is_github_rate_limit_response(response: httpx.Response) -> bool:
    """Detect a rate-limit response from GitHub."""
    if response.status_code not in (403, 429):
        return False
    if response.headers.get("X-RateLimit-Remaining") == "0":
        return True
    try:
        body = response.text or ""
    except Exception:
        body = ""
    return "rate limit" in body.lower()


def _is_ha_addon() -> bool:
    """Detect a Home Assistant Supervisor add-on container."""
    return bool(os.environ.get("SUPERVISOR_TOKEN"))


def parse_version(version: str) -> tuple:
    """Parse a release version into a comparison tuple."""
    version = version.lstrip("v")
    version = re.sub(r"-daily\.\d+$", "", version)
    match = re.match(r"(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:b|beta|alpha|rc)?(\d+)?", version)
    if match:
        major = int(match.group(1))
        minor = int(match.group(2))
        patch = int(match.group(3))
        micro = int(match.group(4)) if match.group(4) else 0
        prerelease_num = int(match.group(5)) if match.group(5) else 0
        is_prerelease = 1 if re.search(r"[a-zA-Z]", version) else 0
        return (major, minor, patch, micro, is_prerelease, prerelease_num)

    parts = []
    for part in version.split("."):
        try:
            parts.append(int(part))
        except ValueError:
            number = "".join(character for character in part if character.isdigit())
            parts.append(int(number) if number else 0)
    return tuple(parts) + (0, 0, 0)


def is_newer_version(latest: str, current: str) -> bool:
    """Return whether ``latest`` is newer than ``current``."""
    try:
        latest_parsed = parse_version(latest)
        current_parsed = parse_version(current)
        latest_base = latest_parsed[:4]
        current_base = current_parsed[:4]
        if latest_base != current_base:
            return latest_base > current_base

        latest_is_prerelease = latest_parsed[4] if len(latest_parsed) > 4 else 0
        current_is_prerelease = current_parsed[4] if len(current_parsed) > 4 else 0
        if latest_is_prerelease != current_is_prerelease:
            return latest_is_prerelease < current_is_prerelease

        latest_prerelease_num = latest_parsed[5] if len(latest_parsed) > 5 else 0
        current_prerelease_num = current_parsed[5] if len(current_parsed) > 5 else 0
        return latest_prerelease_num > current_prerelease_num
    except Exception:
        return False


@router.get("/version")
async def get_version():
    """Get the current application version without authentication."""
    return {"version": APP_VERSION, "repo": GITHUB_REPO}


@router.get("/check")
async def check_for_updates(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SYSTEM_READ),
):
    """Check GitHub for a newer container release."""
    result = await db.execute(select(Settings).where(Settings.key == "check_updates"))
    setting = result.scalar_one_or_none()
    if setting and setting.value.lower() == "false":
        return {
            "update_available": False,
            "current_version": APP_VERSION,
            "latest_version": None,
            "message": "Update checks are disabled",
        }

    result = await db.execute(select(Settings).where(Settings.key == "include_beta_updates"))
    beta_setting = result.scalar_one_or_none()
    include_beta = beta_setting and beta_setting.value.lower() == "true"

    backoff_remaining = _seconds_until_github_unblocked()
    if backoff_remaining > 0:
        return {
            "update_available": False,
            "current_version": APP_VERSION,
            "latest_version": None,
            "error": "GitHub rate limit reached; retry later",
            "retry_after_seconds": int(backoff_remaining),
        }

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"https://api.github.com/repos/{GITHUB_REPO}/releases?per_page=20",
                headers={"Accept": "application/vnd.github.v3+json"},
                timeout=10.0,
            )

        if _is_github_rate_limit_response(response):
            _record_github_rate_limit(response)
            return {
                "update_available": False,
                "current_version": APP_VERSION,
                "latest_version": None,
                "error": "GitHub rate limit reached; retry later",
                "retry_after_seconds": int(_seconds_until_github_unblocked()),
            }

        if response.status_code == 404:
            return {
                "update_available": False,
                "current_version": APP_VERSION,
                "latest_version": None,
                "message": "No releases found",
            }

        response.raise_for_status()
        releases = response.json()
        release_data = None
        for release in releases:
            tag = release.get("tag_name", "")
            if include_beta or parse_version(tag)[4] == 0:
                release_data = release
                break

        if not release_data:
            return {
                "update_available": False,
                "current_version": APP_VERSION,
                "latest_version": None,
                "message": "No releases found",
            }

        latest_version = release_data.get("tag_name", "").lstrip("v")
        is_ha_addon = _is_ha_addon()
        return {
            "update_available": is_newer_version(latest_version, APP_VERSION),
            "current_version": APP_VERSION,
            "latest_version": latest_version,
            "release_name": release_data.get("name", latest_version),
            "release_notes": release_data.get("body", ""),
            "release_url": release_data.get("html_url", ""),
            "published_at": release_data.get("published_at", ""),
            "is_docker": not is_ha_addon,
            "is_ha_addon": is_ha_addon,
            "update_method": "ha_addon" if is_ha_addon else "docker",
        }
    except httpx.HTTPError as exc:
        logger.error("Failed to check for updates: %s", exc)
        return {
            "update_available": False,
            "current_version": APP_VERSION,
            "latest_version": None,
            "error": "Failed to check for updates",
        }
