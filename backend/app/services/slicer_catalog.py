"""Transactional ingestion for installed slicer profile catalogs."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.slicer_profile_catalog import (
    PrinterSlicerBinding,
    SlicerCompatibilityMapping,
    SlicerFilamentRule,
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileActivationEvent,
    SlicerProfileReviewBatch,
    SlicerProfileRevision,
    UserSlicerPreference,
)

SOURCES = {"local", "orca_cloud", "cloud", "standard"}


@dataclass(frozen=True)
class CatalogProfile:
    """Provider-neutral profile envelope used by every catalog adapter."""

    remote_profile_id: str
    profile_type: str
    display_name: str
    content: Mapping[str, Any] = field(default_factory=dict)
    remote_revision_id: str | None = None
    metadata: Mapping[str, Any] | None = None
    tombstone: bool = False


@dataclass(frozen=True)
class CatalogInput:
    source: str
    remote_account_id: str
    profiles: Sequence[CatalogProfile] = field(default_factory=tuple)
    cursor: str | None = None
    display_name: str | None = None
    user_id: int | None = None
    actor_user_id: int | None = None


@dataclass(frozen=True)
class IngestResult:
    account_id: int
    review_batch_id: int | None
    revision_ids: tuple[int, ...]
    cursor: str | None


@dataclass(frozen=True)
class CatalogProfileReferences:
    bindings: tuple[PrinterSlicerBinding, ...]
    mappings: tuple[SlicerCompatibilityMapping, ...]
    rules: tuple[SlicerFilamentRule, ...]
    preferences: tuple[UserSlicerPreference, ...]

    @property
    def referenced(self) -> bool:
        return bool(self.bindings or self.mappings or self.rules or self.preferences)

    def detail(self) -> dict[str, Any]:
        return {
            "code": "profile_replacement_required",
            "binding_ids": [row.id for row in self.bindings],
            "mapping_ids": [row.id for row in self.mappings],
            "rule_ids": [row.id for row in self.rules],
            "preference_ids": [row.id for row in self.preferences],
        }


async def catalog_profile_references(
    session: AsyncSession, profile_id: int
) -> CatalogProfileReferences:
    bindings = tuple(
        (
            await session.scalars(
                select(PrinterSlicerBinding).where(
                    or_(
                        PrinterSlicerBinding.profile_id == profile_id,
                        PrinterSlicerBinding.default_process_profile_id == profile_id,
                        PrinterSlicerBinding.default_filament_profile_id == profile_id,
                    )
                )
            )
        ).all()
    )
    mappings = tuple(
        (
            await session.scalars(
                select(SlicerCompatibilityMapping).where(SlicerCompatibilityMapping.profile_id == profile_id)
            )
        ).all()
    )
    rules = tuple(
        (
            await session.scalars(
                select(SlicerFilamentRule).where(SlicerFilamentRule.filament_profile_id == profile_id)
            )
        ).all()
    )
    preferences = tuple(
        preference
        for preference in (await session.scalars(select(UserSlicerPreference))).all()
        if (preference.value or {}).get("profile_id") == profile_id
    )
    return CatalogProfileReferences(bindings, mappings, rules, preferences)


def canonical_hash(content: Mapping[str, Any]) -> str:
    """Hash JSON without provider/dict ordering affecting identity."""
    encoded = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return hashlib.sha256(encoded).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _dependency_refs(value: Any) -> set[str]:
    refs: set[str] = set()
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key in {"dependency_id", "profile_id", "remote_profile_id", "source_inherits"} and isinstance(
                item, str
            ):
                refs.add(item)
            elif key in {"dependency_ids", "dependencies"}:
                refs.update(_dependency_refs(item))
            else:
                refs.update(_dependency_refs(item))
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for item in value:
            if isinstance(item, str):
                refs.add(item)
            else:
                refs.update(_dependency_refs(item))
    return refs


async def _in_transaction(session: AsyncSession, operation):
    if session.in_transaction():
        return await operation()
    async with session.begin():
        return await operation()


async def ingest_catalog(session: AsyncSession, catalog: CatalogInput) -> IngestResult:
    """Ingest one cursor page atomically; replaying a page is a no-op."""
    if catalog.source not in SOURCES:
        raise ValueError(f"unsupported catalog source: {catalog.source}")
    if not catalog.remote_account_id:
        raise ValueError("remote_account_id is required")

    async def operation() -> IngestResult:
        account = await session.scalar(
            select(SlicerProfileAccount).where(
                SlicerProfileAccount.source == catalog.source,
                SlicerProfileAccount.remote_account_id == catalog.remote_account_id,
            )
        )
        if account is None:
            installation_source = catalog.source in {"local", "standard"}
            account = SlicerProfileAccount(
                source=catalog.source,
                remote_account_id=catalog.remote_account_id,
                display_name=catalog.display_name,
                user_id=catalog.user_id,
                sharing_state="shared" if installation_source else "private",
                consent_at=_now() if installation_source else None,
            )
            session.add(account)
            await session.flush()
        elif account.sync_frozen:
            raise ValueError("catalog account is frozen")
        elif catalog.display_name is not None:
            account.display_name = catalog.display_name

        before_cursor = account.sync_cursor
        changed = False
        revision_ids: list[int] = []
        pending: list[tuple[SlicerProfileRevision, set[str]]] = []
        for item in catalog.profiles:
            profile = await session.scalar(
                select(SlicerProfile).where(
                    SlicerProfile.account_id == account.id,
                    SlicerProfile.remote_profile_id == item.remote_profile_id,
                    SlicerProfile.profile_type == item.profile_type,
                )
            )
            if profile is None:
                profile = SlicerProfile(
                    account_id=account.id,
                    remote_profile_id=item.remote_profile_id,
                    profile_type=item.profile_type,
                    display_name=item.display_name,
                )
                session.add(profile)
                await session.flush()
                changed = True
            elif profile.display_name != item.display_name:
                profile.display_name = item.display_name
                changed = True

            if item.tombstone:
                if profile.tombstoned_at is None:
                    profile.tombstoned_at = _now()
                    changed = True
                continue
            if profile.tombstoned_at is not None:
                profile.tombstoned_at = None
                changed = True
            content = dict(item.content)
            metadata = dict(item.metadata or {})
            digest = canonical_hash({"content": content, "metadata": metadata})
            revision = await session.scalar(
                select(SlicerProfileRevision).where(
                    SlicerProfileRevision.profile_id == profile.id,
                    SlicerProfileRevision.content_hash == digest,
                )
            )
            if revision is None:
                refs = _dependency_refs(content) | _dependency_refs(metadata)
                revision = SlicerProfileRevision(
                    profile_id=profile.id,
                    remote_revision_id=item.remote_revision_id,
                    created_by_user_id=catalog.actor_user_id,
                    content=content,
                    content_hash=digest,
                    resolved_metadata={"metadata": metadata, "dependency_refs": sorted(refs), "dependency_ids": []},
                    review_state="pending",
                )
                session.add(revision)
                pending.append((revision, refs))
                changed = True

        if pending:
            await session.flush()

        account_profiles = (
            await session.scalars(select(SlicerProfile).where(SlicerProfile.account_id == account.id))
        ).all()
        profile_ids_by_remote = {profile.remote_profile_id: profile.id for profile in account_profiles}
        for revision, refs in pending:
            revision.resolved_metadata = {
                **(revision.resolved_metadata or {}),
                "dependency_ids": sorted({profile_ids_by_remote[ref] for ref in refs if ref in profile_ids_by_remote}),
            }
        for profile in account_profiles:
            profile.stale_at = None

        if before_cursor != catalog.cursor:
            account.sync_cursor = catalog.cursor
            changed = True
        account.last_sync_at = _now()
        account.last_successful_sync_at = account.last_sync_at
        account.last_sync_error = None
        if changed:
            batch = SlicerProfileReviewBatch(
                account_id=account.id,
                sync_cursor_before=before_cursor,
                sync_cursor_after=catalog.cursor,
                summary={"profiles": len(catalog.profiles), "revisions": len(pending)},
            )
            session.add(batch)
            await session.flush()
            for revision, _refs in pending:
                revision.review_batch_id = batch.id
                revision_ids.append(revision.id)
            batch_id = batch.id
        else:
            batch_id = None
        return IngestResult(account.id, batch_id, tuple(revision_ids), catalog.cursor)

    return await _in_transaction(session, operation)


async def approve_review_batch(
    session: AsyncSession,
    batch_id: int,
    user_id: int | None = None,
    revision_ids: Sequence[int] | None = None,
) -> None:
    async def operation() -> None:
        batch = await session.get(SlicerProfileReviewBatch, batch_id)
        if batch is None:
            raise ValueError("review batch not found")
        if batch.status != "pending":
            raise ValueError("review batch is already finalized")
        revisions = (
            await session.scalars(
                select(SlicerProfileRevision).where(SlicerProfileRevision.review_batch_id == batch_id)
            )
        ).all()
        available = {revision.id for revision in revisions}
        selected = available if revision_ids is None else set(revision_ids)
        if not selected:
            raise ValueError("at least one revision must be selected")
        if not selected <= available:
            raise ValueError("selected revision does not belong to review batch")
        batch.status = "approved"
        batch.reviewed_by_user_id = user_id
        batch.reviewed_at = _now()
        batch.summary = {
            **(batch.summary or {}),
            "approved_revision_ids": sorted(selected),
            "rejected_revision_ids": sorted(available - selected),
        }
        for revision in revisions:
            revision.review_state = "approved" if revision.id in selected else "rejected"

    await _in_transaction(session, operation)


async def activate_revision(
    session: AsyncSession,
    revision_id: int,
    user_id: int | None = None,
    *,
    action: str = "activate",
) -> SlicerProfileActivation:
    async def operation() -> SlicerProfileActivation:
        if action not in {"activate", "rollback"}:
            raise ValueError("unsupported activation action")
        revision = await session.get(SlicerProfileRevision, revision_id)
        if revision is None or revision.review_state != "approved":
            raise ValueError("revision must be approved before activation")
        activation = await session.scalar(
            select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == revision.profile_id)
        )
        if activation is None:
            activation = SlicerProfileActivation(profile_id=revision.profile_id, revision_id=revision.id)
            session.add(activation)
        else:
            activation.revision_id = revision.id
        activation.activated_by_user_id = user_id
        activation.activated_at = _now()
        session.add(
            SlicerProfileActivationEvent(
                profile_id=revision.profile_id,
                revision_id=revision.id,
                action=action,
                activated_by_user_id=user_id,
                activated_at=activation.activated_at,
            )
        )
        await session.flush()
        return activation

    return await _in_transaction(session, operation)


async def rollback_revision(session: AsyncSession, profile_id: int, revision_id: int, user_id: int | None = None):
    revision = await session.get(SlicerProfileRevision, revision_id)
    if revision is None or revision.profile_id != profile_id:
        raise ValueError("revision does not belong to profile")
    return await activate_revision(session, revision_id, user_id, action="rollback")


async def mark_account_stale(
    session: AsyncSession,
    account_id: int,
    at: datetime | None = None,
    error: str | None = None,
) -> None:
    async def operation() -> None:
        account = await session.get(SlicerProfileAccount, account_id)
        if account is None:
            raise ValueError("account not found")
        profiles = (await session.scalars(select(SlicerProfile).where(SlicerProfile.account_id == account_id))).all()
        when = at or _now()
        account.last_sync_at = when
        account.last_sync_error = error
        for profile in profiles:
            profile.stale_at = when

    await _in_transaction(session, operation)


async def get_revision_content(session: AsyncSession, revision_id: int) -> dict[str, Any]:
    revision = await session.get(SlicerProfileRevision, revision_id)
    if revision is None:
        raise ValueError("revision not found")
    return dict(revision.content)


async def resolve_dependency_ids(session: AsyncSession, revision_id: int) -> list[int]:
    revision = await session.get(SlicerProfileRevision, revision_id)
    if revision is None:
        raise ValueError("revision not found")
    metadata = revision.resolved_metadata or {}
    ids = {int(value) for value in metadata.get("dependency_ids", [])}
    refs = {str(value) for value in metadata.get("dependency_refs", [])}
    if refs:
        owner = await session.get(SlicerProfile, revision.profile_id)
        if owner is not None:
            dependencies = (
                await session.scalars(
                    select(SlicerProfile).where(
                        SlicerProfile.account_id == owner.account_id,
                        SlicerProfile.remote_profile_id.in_(refs),
                    )
                )
            ).all()
            ids.update(profile.id for profile in dependencies)
    return sorted(ids)
