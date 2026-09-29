"""Create an explicitly shared, active local copy without mutating a pinned revision."""

from __future__ import annotations

import json
import math
import re
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import or_, select
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
from backend.app.services.slicer_catalog import CatalogInput, activate_revision, approve_review_batch, ingest_catalog
from backend.app.services.slicer_catalog_sync import local_preset_adapter

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
) -> dict[str, int]:
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
    if not body.share_local_copy:
        raise HTTPException(400, "Confirm that the local copy will be shared on this installation")
    content = {**revision.content, **body.overrides, "name": body.name}
    if account.source == "standard":
        # Standard revisions already contain the resolved ancestor values.
        content.pop("inherits", None)
    # A cloud revision can omit CLI identity fields. A local copy must be
    # independently sliceable and must not reuse the source's setting identity.
    content.pop("setting_id", None)
    content = materialize_orca_profile(content, slot="filament", stable_id=f"LC{uuid4().hex}", stable_name=body.name)
    # Use the existing local preset adapter (including credential validation).
    preset = LocalPreset(
        name=body.name,
        preset_type="filament",
        source="manual",
        setting=json.dumps(content),
        **extract_core_fields(content),
    )
    try:
        local_preset_adapter(preset)
    except ValueError as exc:
        raise HTTPException(422, "Invalid filament settings; credentials are not allowed") from exc
    local_account = await db.scalar(
        select(SlicerProfileAccount).where(
            SlicerProfileAccount.source == "local", SlicerProfileAccount.remote_account_id == "installation"
        )
    )
    if local_account is not None and local_account.sync_frozen:
        raise HTTPException(409, "The local profile catalog is frozen")
    db.add(preset)
    await db.flush()
    # Ingest ONLY this new identity. Syncing all local presets then approving its
    # batch could accidentally approve/reject unrelated pending administrator edits.
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="local",
            remote_account_id="installation",
            actor_user_id=user_id,
            profiles=[local_preset_adapter(preset)],
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
    return {"profile_id": activation.profile_id, "revision_id": activation.revision_id, "local_preset_id": preset.id}
