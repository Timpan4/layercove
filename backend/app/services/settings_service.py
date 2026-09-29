"""Typed persistence and response helpers for application settings."""

import os
from collections.abc import Awaitable, Callable
from typing import Any, get_args

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.db_dialect import upsert_setting
from backend.app.models.settings import Settings
from backend.app.schemas.settings import AppSettings, AppSettingsUpdate

DEFAULT_SETTINGS = AppSettings()

# Sensitive credential fields blanked for API-key callers.
SENSITIVE_FIELDS_FOR_API_KEY = (
    "mqtt_password",
    "ha_token",
    "prometheus_token",
    "virtual_printer_access_code",
    "ldap_bind_password",
)


def _decode_setting(key: str, value: str) -> Any:
    """Preserve legacy null strings; let AppSettings coerce other values."""
    annotation = AppSettings.model_fields[key].annotation
    return None if type(None) in get_args(annotation) and value in ("", "None") else value


def _encode_setting(value: Any) -> str:
    """Encode application-setting values with legacy null compatibility."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "None"
    return str(value)


async def get_setting(db: AsyncSession, key: str) -> str | None:
    """Get one raw setting value by key."""
    result = await db.execute(select(Settings).where(Settings.key == key))
    setting = result.scalar_one_or_none()
    return setting.value if setting else None


async def set_setting(db: AsyncSession, key: str, value: str) -> None:
    """Set one raw setting value without committing."""
    await upsert_setting(db, Settings, key, value)


async def save_settings(db: AsyncSession, settings_update: AppSettingsUpdate) -> set[str]:
    """Persist only supplied update fields without committing."""
    update_data = settings_update.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        await set_setting(db, key, _encode_setting(value))
    return set(update_data)


async def get_homeassistant_settings(
    db: AsyncSession,
    read_setting: Callable[[AsyncSession, str], Awaitable[str | None]] = get_setting,
) -> dict[str, str | bool]:
    """Get Home Assistant settings, preferring environment configuration."""
    ha_url_env = os.environ.get("HA_URL")
    ha_token_env = os.environ.get("HA_TOKEN")
    ha_url = ha_url_env or await read_setting(db, "ha_url") or ""
    ha_token = ha_token_env or await read_setting(db, "ha_token") or ""
    ha_enabled_db = await read_setting(db, "ha_enabled") or "false"
    ha_url_from_env = bool(ha_url_env)
    ha_token_from_env = bool(ha_token_env)

    return {
        "ha_enabled": True if ha_url_env and ha_token_env else ha_enabled_db.lower() == "true",
        "ha_url": ha_url,
        "ha_token": ha_token,
        "ha_url_from_env": ha_url_from_env,
        "ha_token_from_env": ha_token_from_env,
        "ha_env_managed": ha_url_from_env and ha_token_from_env,
    }


async def get_app_settings(db: AsyncSession, is_api_key: bool = False) -> AppSettings:
    """Load typed application settings and scrub caller-ineligible secrets."""
    values = DEFAULT_SETTINGS.model_dump()
    result = await db.execute(select(Settings))
    for setting in result.scalars():
        if setting.key in values:
            values[setting.key] = _decode_setting(setting.key, setting.value)

    values.update(await get_homeassistant_settings(db))
    values["ldap_bind_password"] = ""
    if is_api_key:
        for key in SENSITIVE_FIELDS_FOR_API_KEY:
            values[key] = ""
    return AppSettings(**values)
