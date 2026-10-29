"""Create an active local copy without mutating a pinned revision."""

from __future__ import annotations

import json
import math
import re
from dataclasses import replace
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import or_, select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.local_preset import LocalPreset
from backend.app.models.slicer_profile_catalog import (
    SlicerCompatibilityMapping,
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileRevision,
)
from backend.app.services.orca_profiles import extract_core_fields
from backend.app.services.preset_resolver import materialize_orca_profile
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
    ingest_catalog,
)
from backend.app.services.slicer_catalog_sync import local_preset_adapter, sync_local_catalog

# Editing print parameters must not silently alter identity, inheritance or the
# compatibility evidence whose administrator mappings are copied below.
READ_ONLY_FIELDS = frozenset(
    {
        "name",
        "type",
        "from",
        "inherits",
        "setting_id",
        "filament_id",
        "filament_settings_id",
        "version",
        "instantiation",
        "is_custom_defined",
        "nozzle_diameter",
    }
)


def editable_filament_field(key: str) -> bool:
    return (
        bool(re.fullmatch(r"[a-z][a-z0-9_]*", key))
        and key not in READ_ONLY_FIELDS
        and not key.startswith("compatible_")
    )


class FilamentCopyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_revision_id: int = Field(gt=0)
    name: str = Field(min_length=1, max_length=300)
    overrides: dict[str, Any] = Field(default_factory=dict, max_length=512)
    share_local_copy: bool = False

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError("Enter a nonempty profile name without control characters")
        return value

    @field_validator("overrides")
    @classmethod
    def validate_overrides(cls, value: dict[str, Any]) -> dict[str, Any]:
        # Orca filament options are scalars or arrays of scalars. Preserve array
        # shape and units; do not guess numeric values or erase unknown options.
        def scalar(item: Any) -> bool:
            return item is None or isinstance(item, (str, bool, int)) or isinstance(item, float) and math.isfinite(item)

        for key, item in value.items():
            if not editable_filament_field(key):
                raise ValueError(f"{key} is not an editable filament setting")
            if not scalar(item) and not (isinstance(item, list) and len(item) <= 64 and all(scalar(v) for v in item)):
                raise ValueError(f"{key} must be a scalar or a bounded array of scalars")
        if len(json.dumps(value, allow_nan=False).encode()) > 128 * 1024:
            raise ValueError("Filament changes exceed 128 KiB")
        return value


async def copy_filament_profile(
    db: AsyncSession, profile_id: int, body: FilamentCopyRequest, user_id: int | None
) -> dict[str, int | None]:
    """Save the copy as an installation-wide local preset, or in the user's private account.

    Without authentication there is no other user to hide a copy from, so it is always shared.
    """
    visibility = or_(
        SlicerProfileAccount.sharing_state == "shared",
        SlicerProfileAccount.user_id == user_id if user_id is not None else SlicerProfileAccount.user_id.is_(None),
    )
    row = (
        await db.execute(
            select(SlicerProfile, SlicerProfileAccount, SlicerProfileRevision)
            .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
            .join(SlicerProfileActivation, SlicerProfileActivation.profile_id == SlicerProfile.id)
            .join(SlicerProfileRevision, SlicerProfileRevision.id == SlicerProfileActivation.revision_id)
            .where(SlicerProfile.id == profile_id, visibility)
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(404, "Active filament profile not found")
    profile, account, revision = row
    if profile.profile_type != "filament":
        raise HTTPException(400, "Only filament profiles can be edited here")
    if profile.tombstoned_at is not None or account.sync_frozen or revision.review_state != "approved":
        raise HTTPException(409, "This filament profile is no longer available; reload the catalog")
    if revision.id != body.base_revision_id:
        raise HTTPException(409, "The filament profile changed while editing; reload before saving")
    shared = body.share_local_copy or user_id is None
    content = {**revision.content, **body.overrides, "name": body.name}
    if account.source == "standard":
        # Standard revisions already contain the resolved ancestor values.
        content.pop("inherits", None)
    # A cloud revision can omit CLI identity fields. A local copy must be
    # independently sliceable and must not reuse the source's setting identity.
    content.pop("setting_id", None)
    stable_id = f"LC{uuid4().hex}"
    content = materialize_orca_profile(content, slot="filament", stable_id=stable_id, stable_name=body.name)
    # Use the existing local preset adapter (including credential validation).
    preset = LocalPreset(
        name=body.name,
        preset_type="filament",
        source="manual",
        setting=json.dumps(content),
        **extract_core_fields(content),
    )
    try:
        catalog_profile = local_preset_adapter(preset)
    except ValueError as exc:
        raise HTTPException(422, "Invalid filament settings; credentials are not allowed") from exc
    # Local presets are listed for every user, so a private copy lives only in its owner's account.
    # That account is found by its owner. A random identity keeps a reused user id away from the
    # account of a deleted user.
    local_account = await db.scalar(
        select(SlicerProfileAccount)
        .where(
            SlicerProfileAccount.source == "local",
            SlicerProfileAccount.remote_account_id == "installation"
            if shared
            else (SlicerProfileAccount.user_id == user_id) & (SlicerProfileAccount.sharing_state == "private"),
        )
        .order_by(SlicerProfileAccount.id)
        .limit(1)
    )
    if local_account is not None and local_account.sync_frozen:
        raise HTTPException(409, "The local profile catalog is frozen")
    if shared:
        remote_account_id = "installation"
        db.add(preset)
        await db.flush()
        catalog_profile = local_preset_adapter(preset)
    else:
        if local_account is None:
            # ingest_catalog would create a local account as shared.
            local_account = SlicerProfileAccount(
                source="local",
                remote_account_id=f"user:{uuid4().hex}",
                display_name="Private filament copies",
                user_id=user_id,
                sharing_state="private",
            )
            db.add(local_account)
            await db.flush()
        remote_account_id = local_account.remote_account_id
        catalog_profile = replace(catalog_profile, remote_profile_id=stable_id)
    # Ingest ONLY this new identity. Syncing all local presets then approving its
    # batch could accidentally approve/reject unrelated pending administrator edits.
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="local",
            remote_account_id=remote_account_id,
            actor_user_id=user_id,
            profiles=[catalog_profile],
        ),
    )
    await approve_review_batch(db, result.review_batch_id, user_id=user_id)
    activation = await activate_revision(db, result.revision_ids[0], user_id=user_id)
    mappings = (
        await db.scalars(
            select(SlicerCompatibilityMapping.printer_id).where(SlicerCompatibilityMapping.profile_id == profile_id)
        )
    ).all()
    for printer_id in mappings:
        db.add(
            SlicerCompatibilityMapping(
                profile_id=activation.profile_id, printer_id=printer_id, created_by_user_id=user_id
            )
        )
    await db.flush()
    return {
        "profile_id": activation.profile_id,
        "revision_id": activation.revision_id,
        "local_preset_id": preset.id if shared else None,
    }


async def update_local_filament(
    db: AsyncSession, profile_id: int, base_revision_id: int, overrides: dict[str, Any], user_id: int | None
) -> None:
    """Write overrides into a local preset or the user's private copy as its new active revision.

    Cloud and bundled profiles come from their source, whose next sync would replace the change.
    """
    row = (
        await db.execute(
            select(SlicerProfile, SlicerProfileAccount)
            .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
            .where(SlicerProfile.id == profile_id, SlicerProfile.tombstoned_at.is_(None))
        )
    ).one_or_none()
    if row is None:
        raise HTTPException(409, "This filament profile is no longer available; save a copy instead")
    profile, account = row
    private = account.sharing_state == "private" and account.user_id == user_id
    if account.source != "local" or not (private or account.remote_account_id == "installation"):
        raise HTTPException(409, "Only local presets and your private copies can be updated; save a copy instead")
    if account.sync_frozen:
        raise HTTPException(409, "The local profile catalog is frozen")
    # A conditional write checks the active revision and locks it in one step, so a concurrent save
    # from the same revision waits and then finds the profile changed instead of overwriting it.
    claimed = await db.execute(
        sql_update(SlicerProfileActivation)
        .where(
            SlicerProfileActivation.profile_id == profile_id,
            SlicerProfileActivation.revision_id == base_revision_id,
        )
        .values(revision_id=SlicerProfileActivation.revision_id)
        .execution_options(synchronize_session=False)
    )
    if claimed.rowcount != 1:
        raise HTTPException(409, "The filament profile changed while calibrating; reload before saving")
    if not private:
        preset = await db.get(LocalPreset, int(profile.remote_profile_id))
        content = {**json.loads(preset.setting), **overrides}
        preset.setting = json.dumps(content)
        for key, value in extract_core_fields(content).items():
            setattr(preset, key, value)
        await db.flush()
        try:
            # Editing local presets activates their new revisions without review.
            await sync_local_catalog(db, actor_user_id=user_id)
        except ValueError as exc:
            raise HTTPException(409, f"Could not update the local presets: {exc}") from exc
        return
    revision = await db.get(SlicerProfileRevision, base_revision_id)
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="local",
            remote_account_id=account.remote_account_id,
            actor_user_id=user_id,
            profiles=[
                CatalogProfile(
                    remote_profile_id=profile.remote_profile_id,
                    profile_type="filament",
                    display_name=profile.display_name,
                    content={**revision.content, **overrides},
                    metadata=(revision.resolved_metadata or {}).get("metadata"),
                )
            ],
            partial=True,
        ),
    )
    if result.review_batch_id is not None:
        await approve_review_batch(db, result.review_batch_id, user_id=user_id)
    await activate_revision(db, result.current_revision_ids[0], user_id=user_id)
