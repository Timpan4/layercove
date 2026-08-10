"""Source adapters and restart-safe catalog synchronization."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.local_preset import LocalPreset
from backend.app.models.slicer_profile_catalog import (
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileRevision,
)
from backend.app.services.orca_cloud import OrcaCloudService, OrcaProfilePull
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    CatalogProfileReferences,
    IngestResult,
    canonical_hash,
    catalog_profile_references,
    ingest_catalog,
    mark_account_stale,
)

_ORCA_PROFILE_TYPES = {"printer": "printer", "print": "process", "process": "process", "filament": "filament"}
_STANDARD_ACCOUNT_ID = "bundled"
_SECRET_KEYS = {"access_token", "refresh_token", "password", "api_key"}

logger = logging.getLogger(__name__)


class LocalCatalogReferenceError(ValueError):
    def __init__(self, references: CatalogProfileReferences):
        super().__init__("Local profile has catalog references")
        self.references = references


def _validate_profile_content(value: Any, path: str = "content") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{path} contains a non-string key")
            if key.lower() in _SECRET_KEYS:
                raise ValueError(f"{path} contains forbidden credential field {key!r}")
            _validate_profile_content(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _validate_profile_content(item, f"{path}[{index}]")
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise ValueError(f"{path} contains unsupported value {type(value).__name__}")


def _string_list(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    items = [item.strip() for item in value if isinstance(item, str) and item.strip()]
    return items or None


def orca_profile_adapter(entry: Mapping[str, Any]) -> CatalogProfile:
    remote_id = entry.get("id")
    content = entry.get("content")
    if not isinstance(remote_id, (str, int)) or not str(remote_id):
        raise ValueError("Orca profile is missing a stable id")
    if len(str(remote_id)) > 512:
        raise ValueError("Orca profile id exceeds catalog limit")
    if not isinstance(content, Mapping):
        raise ValueError(f"Orca profile {remote_id!r} is missing full content")
    _validate_profile_content(content)
    profile_type = _ORCA_PROFILE_TYPES.get(str(content.get("type", "")))
    if profile_type is None:
        raise ValueError(f"Orca profile {remote_id!r} has unsupported type")
    name = str(entry.get("name") or remote_id)
    if len(name) > 512:
        raise ValueError(f"Orca profile {remote_id!r} name exceeds catalog limit")
    metadata = {
        "compatible_printers": _string_list(content.get("compatible_printers")),
        "inherits": content.get("inherits") if isinstance(content.get("inherits"), str) else None,
    }
    return CatalogProfile(
        remote_profile_id=str(remote_id),
        profile_type=profile_type,
        display_name=name,
        content=dict(content),
        remote_revision_id=str(entry["revision_id"])
        if entry.get("revision_id") is not None
        else str(entry["updated_time"])
        if entry.get("updated_time") is not None
        else None,
        metadata=metadata,
    )


def resolve_profile_inheritance(profiles: list[CatalogProfile]) -> list[CatalogProfile]:
    """Resolve one source snapshot using explicit inherits edges within its account."""
    by_id = {(profile.profile_type, profile.remote_profile_id): profile for profile in profiles}
    by_name: dict[tuple[str, str], list[CatalogProfile]] = {}
    for profile in profiles:
        by_name.setdefault((profile.profile_type, profile.display_name), []).append(profile)
    resolved: dict[tuple[str, str], CatalogProfile] = {}
    resolving: set[tuple[str, str]] = set()

    def resolve(profile: CatalogProfile) -> CatalogProfile:
        key = (profile.profile_type, profile.remote_profile_id)
        if key in resolved:
            return resolved[key]
        if key in resolving:
            raise ValueError(f"profile inheritance cycle at {profile.remote_profile_id!r}")
        resolving.add(key)
        parent_ref = profile.content.get("inherits")
        if not isinstance(parent_ref, str) or not parent_ref.strip():
            result = profile
        else:
            parent_ref = parent_ref.strip()
            parent = by_id.get((profile.profile_type, parent_ref))
            if parent is None:
                candidates = by_name.get((profile.profile_type, parent_ref), [])
                if len(candidates) != 1:
                    reason = "missing" if not candidates else "ambiguous"
                    raise ValueError(
                        f"{reason} {profile.profile_type} inheritance parent {parent_ref!r} "
                        f"for {profile.remote_profile_id!r}"
                    )
                parent = candidates[0]
            resolved_parent = resolve(parent)
            content = {**resolved_parent.content, **profile.content}
            content.pop("inherits", None)
            metadata = dict(profile.metadata or {})
            metadata["compatible_printers"] = _string_list(content.get("compatible_printers"))
            metadata["source_inherits"] = parent.remote_profile_id
            metadata["source_content"] = dict(profile.content)
            result = replace(profile, content=content, metadata=metadata)
        resolving.remove(key)
        resolved[key] = result
        return result

    return [resolve(profile) for profile in profiles]


def local_preset_adapter(preset: LocalPreset) -> CatalogProfile:
    if preset.preset_type not in {"printer", "process", "filament"}:
        raise ValueError(f"local preset {preset.id} has unsupported type")
    try:
        content = json.loads(preset.setting)
    except (TypeError, ValueError) as error:
        raise ValueError(f"local preset {preset.id} has invalid content") from error
    if not isinstance(content, Mapping):
        raise ValueError(f"local preset {preset.id} content is not an object")
    _validate_profile_content(content)
    try:
        compatibility = json.loads(preset.compatible_printers) if preset.compatible_printers else None
    except (TypeError, ValueError):
        compatibility = None
    return CatalogProfile(
        remote_profile_id=str(preset.id),
        profile_type=preset.preset_type,
        display_name=preset.name,
        content=dict(content),
        remote_revision_id=preset.version,
        metadata={"compatible_printers": _string_list(compatibility)},
    )


async def sync_local_catalog(
    session: AsyncSession,
    *,
    actor_user_id: int | None = None,
    skip_invalid: bool = False,
    protect_references: bool = True,
) -> IngestResult | None:
    """Mirror current local presets and tombstone identities removed from the source table."""
    profiles: list[CatalogProfile] = []
    for preset in (await session.scalars(select(LocalPreset).order_by(LocalPreset.id))).all():
        try:
            profiles.append(local_preset_adapter(preset))
        except ValueError:
            if not skip_invalid:
                raise
            logger.warning("Skipping invalid local slicer preset id=%s during catalog sync", preset.id)

    account = await session.scalar(
        select(SlicerProfileAccount).where(
            SlicerProfileAccount.source == "local",
            SlicerProfileAccount.remote_account_id == "installation",
        )
    )
    if account is not None and account.sync_frozen:
        return None
    if account is None and not profiles:
        return None
    seen = {(profile.remote_profile_id, profile.profile_type) for profile in profiles}
    if account is not None:
        existing = (await session.scalars(select(SlicerProfile).where(SlicerProfile.account_id == account.id))).all()
        removed = [profile for profile in existing if (profile.remote_profile_id, profile.profile_type) not in seen]
        if protect_references:
            for profile in removed:
                references = await catalog_profile_references(session, profile.id)
                if references.referenced:
                    raise LocalCatalogReferenceError(references)
        profiles.extend(
            CatalogProfile(
                remote_profile_id=profile.remote_profile_id,
                profile_type=profile.profile_type,
                display_name=profile.display_name,
                tombstone=True,
            )
            for profile in removed
        )
    return await ingest_catalog(
        session,
        CatalogInput(
            source="local",
            remote_account_id="installation",
            display_name="LayerCove local presets",
            profiles=profiles,
            actor_user_id=actor_user_id,
        ),
    )


def cloud_profile_adapter(profile_type: str, entry: Mapping[str, Any]) -> CatalogProfile:
    """Normalize another-cloud entry without inventing compatibility metadata."""
    remote_id = entry.get("setting_id") or entry.get("id")
    if not isinstance(remote_id, (str, int)) or not str(remote_id):
        raise ValueError("cloud profile is missing a stable id")
    remote_id = str(remote_id)
    if len(remote_id) > 512:
        raise ValueError("cloud profile id exceeds catalog limit")
    if profile_type not in {"printer", "process", "filament"}:
        raise ValueError("unsupported cloud profile type")
    content = entry.get("content")
    normalized_content = dict(content) if isinstance(content, Mapping) else {}
    _validate_profile_content(normalized_content)
    name = str(entry.get("name") or remote_id)
    if len(name) > 512:
        raise ValueError("cloud profile name exceeds catalog limit")
    return CatalogProfile(
        remote_profile_id=remote_id,
        profile_type=profile_type,
        display_name=name,
        content=normalized_content,
        metadata={"compatible_printers": _string_list(normalized_content.get("compatible_printers"))},
    )


def standard_profile_adapter(profile_type: str, entry: Mapping[str, Any]) -> CatalogProfile:
    """Normalize full sidecar data; refuse display-name-only unstable stubs."""
    stable_id = entry.get("stable_id") or entry.get("content_hash")
    content = entry.get("content")
    if not isinstance(stable_id, str) or not stable_id:
        raise ValueError("standard profile requires sidecar stable_id or content_hash")
    if len(stable_id) > 512:
        raise ValueError("standard profile id exceeds catalog limit")
    if not isinstance(content, Mapping):
        raise ValueError("standard profile requires full resolved content")
    _validate_profile_content(content)
    if profile_type not in {"printer", "process", "filament"}:
        raise ValueError("unsupported standard profile type")
    supplied_hash = entry.get("content_hash")
    if supplied_hash is not None and str(supplied_hash) != canonical_hash(content):
        raise ValueError("standard profile content hash does not match resolved content")
    name = str(entry.get("name") or stable_id)
    if len(name) > 512:
        raise ValueError("standard profile name exceeds catalog limit")
    return CatalogProfile(
        remote_profile_id=stable_id,
        profile_type=profile_type,
        display_name=name,
        content=dict(content),
        remote_revision_id=str(supplied_hash) if supplied_hash is not None else None,
        metadata={"compatible_printers": _string_list(content.get("compatible_printers"))},
    )


async def sync_cloud_account(
    session: AsyncSession,
    snapshot: Mapping[str, Any],
    *,
    remote_account_id: str,
    display_name: str | None,
    user_id: int | None,
) -> IngestResult:
    """Persist one full other-cloud snapshot without inventing metadata."""
    profiles: list[CatalogProfile] = []
    for profile_type in ("printer", "process", "filament"):
        entries = snapshot.get(profile_type, [])
        if not isinstance(entries, list):
            raise ValueError(f"cloud snapshot {profile_type} must be a list")
        profiles.extend(cloud_profile_adapter(profile_type, entry) for entry in entries)
    profiles = resolve_profile_inheritance(profiles)
    cursor = canonical_hash(
        {
            "profiles": [
                {
                    "id": profile.remote_profile_id,
                    "type": profile.profile_type,
                    "name": profile.display_name,
                    "content": profile.content,
                }
                for profile in sorted(profiles, key=lambda item: (item.profile_type, item.remote_profile_id))
            ]
        }
    )
    account = await session.scalar(
        select(SlicerProfileAccount).where(
            SlicerProfileAccount.source == "cloud",
            SlicerProfileAccount.remote_account_id == remote_account_id,
        )
    )
    account_id = account.id if account is not None else None
    existing = (
        (await session.scalars(select(SlicerProfile).where(SlicerProfile.account_id == account.id))).all()
        if account is not None
        else []
    )
    present = {(profile.remote_profile_id, profile.profile_type) for profile in profiles}
    profiles.extend(
        CatalogProfile(
            remote_profile_id=profile.remote_profile_id,
            profile_type=profile.profile_type,
            display_name=profile.display_name,
            tombstone=True,
        )
        for profile in existing
        if (profile.remote_profile_id, profile.profile_type) not in present
    )
    try:
        result = await ingest_catalog(
            session,
            CatalogInput(
                source="cloud",
                remote_account_id=remote_account_id,
                display_name=display_name,
                user_id=user_id,
                profiles=profiles,
                cursor=cursor,
            ),
        )
        await session.commit()
        return result
    except Exception:
        await session.rollback()
        if account_id is not None:
            await mark_account_stale(session, account_id, error="sync_failed")
            await session.commit()
        raise


async def sync_standard_account(
    session: AsyncSession,
    snapshot: Mapping[str, Any],
    *,
    display_name: str = "Standard",
) -> IngestResult:
    """Ingest one authoritative, full bundled-profile snapshot."""
    profiles: list[CatalogProfile] = []
    for profile_type in ("printer", "process", "filament"):
        entries = snapshot.get(profile_type, [])
        if not isinstance(entries, list):
            raise ValueError(f"standard snapshot {profile_type} must be a list")
        profiles.extend(standard_profile_adapter(profile_type, entry) for entry in entries)

    # The cursor is content-derived, so replay and endpoint URL changes are stable.
    snapshot_hash = canonical_hash(
        {
            "profiles": [
                {
                    "id": profile.remote_profile_id,
                    "type": profile.profile_type,
                    "name": profile.display_name,
                    "content": profile.content,
                    "metadata": profile.metadata,
                    "revision": profile.remote_revision_id,
                }
                for profile in sorted(profiles, key=lambda item: (item.profile_type, item.remote_profile_id))
            ]
        }
    )
    account = await session.scalar(
        select(SlicerProfileAccount).where(
            SlicerProfileAccount.source == "standard",
            SlicerProfileAccount.remote_account_id == _STANDARD_ACCOUNT_ID,
        )
    )
    account_id = account.id if account is not None else None
    existing = (
        (
            await session.scalars(
                select(SlicerProfile).where(
                    SlicerProfile.account_id == account.id,
                )
            )
        ).all()
        if account is not None
        else []
    )
    present = {(profile.remote_profile_id, profile.profile_type) for profile in profiles}
    profiles.extend(
        CatalogProfile(
            remote_profile_id=profile.remote_profile_id,
            profile_type=profile.profile_type,
            display_name=profile.display_name,
            tombstone=True,
        )
        for profile in existing
        if (profile.remote_profile_id, profile.profile_type) not in present
    )
    try:
        result = await ingest_catalog(
            session,
            CatalogInput(
                source="standard",
                remote_account_id=_STANDARD_ACCOUNT_ID,
                display_name=display_name,
                profiles=profiles,
                cursor=snapshot_hash,
            ),
        )
        await session.commit()
        return result
    except Exception:
        await session.rollback()
        if account_id is not None:
            await mark_account_stale(session, account_id, error="sync_failed")
            await session.commit()
        raise


async def _deleted_orca_profiles(
    session: AsyncSession,
    account: SlicerProfileAccount | None,
    pull: OrcaProfilePull,
) -> list[CatalogProfile]:
    if account is None or not pull.deletes:
        return []
    profiles = (
        await session.scalars(
            select(SlicerProfile).where(
                SlicerProfile.account_id == account.id,
                SlicerProfile.remote_profile_id.in_(pull.deletes),
            )
        )
    ).all()
    return [
        CatalogProfile(
            remote_profile_id=profile.remote_profile_id,
            profile_type=profile.profile_type,
            display_name=profile.display_name,
            tombstone=True,
        )
        for profile in profiles
    ]


async def _existing_orca_profiles(
    session: AsyncSession,
    account: SlicerProfileAccount,
) -> list[CatalogProfile]:
    profiles = (
        await session.scalars(
            select(SlicerProfile)
            .where(
                SlicerProfile.account_id == account.id,
                SlicerProfile.tombstoned_at.is_(None),
            )
            .order_by(SlicerProfile.id)
        )
    ).all()
    result: list[CatalogProfile] = []
    for profile in profiles:
        revision = await session.scalar(
            select(SlicerProfileRevision)
            .where(SlicerProfileRevision.profile_id == profile.id)
            .order_by(SlicerProfileRevision.id.desc())
        )
        if revision is None:
            continue
        metadata = dict((revision.resolved_metadata or {}).get("metadata") or {})
        source_content = metadata.get("source_content")
        content = source_content if isinstance(source_content, Mapping) else revision.content
        result.append(
            orca_profile_adapter(
                {
                    "id": profile.remote_profile_id,
                    "name": profile.display_name,
                    "revision_id": revision.remote_revision_id,
                    "content": content,
                }
            )
        )
    return result


async def sync_orca_account(
    session: AsyncSession,
    service: OrcaCloudService,
    *,
    remote_account_id: str,
    display_name: str | None,
    user_id: int | None,
) -> IngestResult:
    """Pull and commit one Orca mirror page, freezing active data on failure."""
    account = await session.scalar(
        select(SlicerProfileAccount).where(
            SlicerProfileAccount.source == "orca_cloud",
            SlicerProfileAccount.remote_account_id == remote_account_id,
        )
    )
    account_id = account.id if account is not None else None
    if account is not None and account.sync_frozen:
        raise ValueError("catalog account is frozen")
    cursor = account.sync_cursor if account is not None else None
    try:
        pull = await service.pull_profiles(cursor)
        upserts = [orca_profile_adapter(entry) for entry in pull.upserts]
        if account is not None and not pull.full_snapshot:
            snapshot = {
                (profile.profile_type, profile.remote_profile_id): profile
                for profile in await _existing_orca_profiles(session, account)
                if profile.remote_profile_id not in pull.deletes
            }
            snapshot.update({(profile.profile_type, profile.remote_profile_id): profile for profile in upserts})
            profiles = resolve_profile_inheritance(list(snapshot.values()))
        else:
            profiles = resolve_profile_inheritance(upserts)
        if account is not None and pull.full_snapshot:
            existing = (
                await session.scalars(select(SlicerProfile).where(SlicerProfile.account_id == account.id))
            ).all()
            present = {(profile.remote_profile_id, profile.profile_type) for profile in profiles}
            profiles.extend(
                CatalogProfile(
                    remote_profile_id=profile.remote_profile_id,
                    profile_type=profile.profile_type,
                    display_name=profile.display_name,
                    tombstone=True,
                )
                for profile in existing
                if (profile.remote_profile_id, profile.profile_type) not in present
            )
        else:
            profiles.extend(await _deleted_orca_profiles(session, account, pull))
        result = await ingest_catalog(
            session,
            CatalogInput(
                source="orca_cloud",
                remote_account_id=remote_account_id,
                display_name=display_name,
                user_id=user_id,
                cursor=pull.next_cursor,
                profiles=profiles,
            ),
        )
        await session.commit()
        return result
    except Exception:
        await session.rollback()
        if account_id is not None:
            await mark_account_stale(session, account_id, error="sync_failed")
            await session.commit()
        raise
