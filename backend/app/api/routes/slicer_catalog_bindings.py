"""Physical-printer bindings, compatibility, and derived readiness APIs."""

from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.models.printer import Printer
from backend.app.models.slicer_profile_catalog import (
    PrinterSlicerBinding,
    SlicerCompatibilityMapping,
    SlicerFilamentRule,
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileRevision,
    SlicerSelectionEvaluation,
    UserSlicerPreference,
)
from backend.app.models.user import User
from backend.app.services.printer_manager import printer_manager
from backend.app.services.slicer_catalog import catalog_profile_references
from backend.app.services.slicer_compatibility import (
    BindingEvidence,
    Classification,
    NozzleEvidence,
    ProfileEvidence,
    classify_profile,
    evaluate_nozzle,
    shadow_evaluate,
    suggest_p1s_binding,
)

router = APIRouter(prefix="/slicer/catalog", tags=["Slicer Catalog Bindings"])


class BindingRequest(BaseModel):
    printer_id: int
    profile_id: int
    expected_nozzle_diameter: Decimal = Field(gt=0)
    tool_index: int = Field(default=0, ge=0)
    default_process_profile_id: int | None = None
    default_filament_profile_id: int | None = None
    enforcement_state: Literal["shadow", "enforced"] = "shadow"


class BindingUpdate(BaseModel):
    profile_id: int | None = None
    expected_nozzle_diameter: Decimal | None = Field(default=None, gt=0)
    tool_index: int | None = Field(default=None, ge=0)
    default_process_profile_id: int | None = None
    default_filament_profile_id: int | None = None
    enforcement_state: Literal["shadow", "enforced"] | None = None
    is_active: bool | None = None


class MappingRequest(BaseModel):
    profile_id: int
    printer_id: int


class FilamentRuleRequest(BaseModel):
    scope: Literal["exact_external", "signature"]
    filament_profile_id: int
    binding_id: int | None = None
    external_source: str | None = Field(default=None, max_length=64)
    external_identity: str | None = Field(default=None, max_length=255)
    material_type: str | None = Field(default=None, max_length=128)
    vendor: str | None = Field(default=None, max_length=255)
    nozzle_diameter_min: Decimal | None = Field(default=None, gt=0)
    nozzle_diameter_max: Decimal | None = Field(default=None, gt=0)


class PreferenceRequest(BaseModel):
    binding_id: int
    profile_id: int
    profile_type: Literal["process", "filament"]


class RetirementRequest(BaseModel):
    replacement_profile_id: int | None = Field(default=None, gt=0)
    disable_references: bool = False


class EvaluationRequest(BaseModel):
    binding_id: int
    profile_id: int
    acknowledgement: dict[str, Any] | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _metadata(revision: SlicerProfileRevision | None) -> dict[str, Any]:
    raw = revision.resolved_metadata if revision is not None else None
    return dict((raw or {}).get("metadata") or {})


async def _printer(db: AsyncSession, printer_id: int) -> Printer:
    printer = await db.get(Printer, printer_id)
    if printer is None or not printer.is_active:
        raise HTTPException(404, "Active printer not found")
    return printer


async def _profile_revision(
    db: AsyncSession,
    profile_id: int,
    profile_type: str | None = None,
    *,
    require_active: bool = False,
    require_shared: bool = False,
    owner_id: int | None = None,
) -> tuple[SlicerProfile, SlicerProfileRevision | None, bool]:
    profile = await db.get(SlicerProfile, profile_id)
    if profile is None or (profile_type is not None and profile.profile_type != profile_type):
        raise HTTPException(422, f"Active {profile_type or 'catalog'} profile is required")
    activation = await db.scalar(
        select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == profile.id)
    )
    revision = await db.get(SlicerProfileRevision, activation.revision_id) if activation is not None else None
    if revision is None:
        revision = await db.scalar(
            select(SlicerProfileRevision)
            .where(SlicerProfileRevision.profile_id == profile.id)
            .order_by(SlicerProfileRevision.id.desc())
        )
    active = activation is not None and revision is not None and revision.id == activation.revision_id
    account = await db.get(SlicerProfileAccount, profile.account_id)
    visible = account is not None and (
        account.sharing_state == "shared" or (owner_id is not None and account.user_id == owner_id)
    )
    available = (
        active
        and revision is not None
        and revision.review_state == "approved"
        and profile.tombstoned_at is None
        and visible
    )
    if require_active and not available:
        raise HTTPException(422, "Profile must have an active approved visible revision")
    if require_shared and (account is None or account.sharing_state != "shared"):
        raise HTTPException(422, "Profile account must be shared before installation binding")
    return profile, revision, available


async def _defaults_available(db: AsyncSession, binding: PrinterSlicerBinding) -> bool:
    if binding.default_process_profile_id is None or binding.default_filament_profile_id is None:
        return False
    try:
        await _profile_revision(db, binding.default_process_profile_id, "process", require_active=True)
        await _profile_revision(db, binding.default_filament_profile_id, "filament", require_active=True)
    except HTTPException:
        return False
    return True


def _nozzle(printer_id: int, tool_index: int) -> NozzleEvidence:
    snapshot = printer_manager.get_snapshot(printer_id)
    if snapshot is None:
        return NozzleEvidence("offline", tool_index=tool_index)
    nozzle = next((item for item in snapshot.nozzles if item.tool_index == tool_index), None)
    diameter = Decimal(str(nozzle.diameter)) if nozzle is not None and nozzle.diameter is not None else None
    if not snapshot.connected:
        return NozzleEvidence("offline", diameter, tool_index)
    if snapshot.telemetry_stale:
        return NozzleEvidence("stale", diameter, tool_index)
    if nozzle is None or nozzle.status != "confirmed" or diameter is None:
        return NozzleEvidence("unknown", diameter, tool_index)
    return NozzleEvidence("confirmed", diameter, tool_index)


def _nozzle_json(nozzle: NozzleEvidence) -> dict[str, Any]:
    return {
        "status": nozzle.status,
        "diameter": float(nozzle.diameter) if nozzle.diameter is not None else None,
        "tool_index": nozzle.tool_index,
    }


async def _binding_evidence(
    db: AsyncSession,
    binding: PrinterSlicerBinding,
    profile: SlicerProfile | None = None,
    revision: SlicerProfileRevision | None = None,
) -> BindingEvidence:
    available = False
    if profile is None:
        try:
            profile, revision, available = await _profile_revision(db, binding.profile_id, "printer")
        except HTTPException:
            profile = None
    elif revision is not None:
        _profile, _revision, available = await _profile_revision(db, profile.id, "printer")
    metadata = _metadata(revision)
    aliases = tuple(item for item in metadata.get("aliases", []) if isinstance(item, str))
    return BindingEvidence(
        id=binding.id or 0,
        printer_id=binding.printer_id,
        printer_profile_id=binding.profile_id,
        printer_profile_name=profile.display_name if profile is not None else "Unavailable profile",
        expected_nozzle_diameter=binding.expected_nozzle_diameter,
        aliases=aliases,
        active=binding.is_active,
        profile_available=available,
        defaults_available=await _defaults_available(db, binding),
    )


async def _binding_row(
    db: AsyncSession, binding_id: int
) -> tuple[PrinterSlicerBinding, SlicerProfile | None, SlicerProfileRevision | None]:
    binding = await db.get(PrinterSlicerBinding, binding_id)
    if binding is None:
        raise HTTPException(404, "Binding not found")
    try:
        profile, revision, _available = await _profile_revision(db, binding.profile_id, "printer")
    except HTTPException:
        profile = revision = None
    return binding, profile, revision


async def _binding_json(db: AsyncSession, binding: PrinterSlicerBinding) -> dict[str, Any]:
    printer = await db.get(Printer, binding.printer_id)
    profile, revision, _available = await _profile_revision(db, binding.profile_id, "printer")
    evidence = await _binding_evidence(db, binding, profile, revision)
    nozzle = _nozzle(binding.printer_id, binding.tool_index)
    readiness = evaluate_nozzle(evidence, nozzle)
    return {
        "id": binding.id,
        "printer_id": binding.printer_id,
        "printer_name": printer.name if printer is not None else None,
        "profile_id": binding.profile_id,
        "profile_name": profile.display_name,
        "expected_nozzle_diameter": binding.expected_nozzle_diameter,
        "tool_index": binding.tool_index,
        "default_process_profile_id": binding.default_process_profile_id,
        "default_filament_profile_id": binding.default_filament_profile_id,
        "enforcement_state": binding.enforcement_state,
        "is_active": binding.is_active,
        "confirmed_at": binding.confirmed_at,
        "readiness": {"state": readiness.state, "reason_codes": readiness.reason_codes},
        "nozzle": _nozzle_json(nozzle),
    }


async def _mapped_printer_ids(db: AsyncSession, profile_id: int) -> frozenset[int]:
    return frozenset(
        await db.scalars(
            select(SlicerCompatibilityMapping.printer_id).where(SlicerCompatibilityMapping.profile_id == profile_id)
        )
    )


async def _installed_bindings(db: AsyncSession) -> tuple[BindingEvidence, ...]:
    bindings = (
        await db.scalars(
            select(PrinterSlicerBinding)
            .where(PrinterSlicerBinding.is_active.is_(True))
            .order_by(PrinterSlicerBinding.id)
        )
    ).all()
    return tuple([await _binding_evidence(db, binding) for binding in bindings])


def _classification_json(classification: Classification) -> dict[str, Any]:
    result = asdict(classification)
    result["reason_details"] = [reason.replace("_", " ") for reason in classification.reason_codes]
    return result


async def _classify_one(
    db: AsyncSession,
    binding: PrinterSlicerBinding,
    profile: SlicerProfile,
    revision: SlicerProfileRevision,
    active: bool,
) -> tuple[Classification, tuple[BindingEvidence, ...]]:
    selected_profile, selected_revision, _available = await _profile_revision(db, binding.profile_id, "printer")
    installed = await _installed_bindings(db)
    compatible = _metadata(revision).get("compatible_printers")
    classification = classify_profile(
        ProfileEvidence(
            profile_id=profile.id,
            revision_id=revision.id,
            display_name=profile.display_name,
            compatible_printers=tuple(compatible) if compatible else None,
            active=active,
            approved=revision.review_state == "approved",
            tombstoned=profile.tombstoned_at is not None,
        ),
        await _binding_evidence(db, binding, selected_profile, selected_revision),
        installed,
        _nozzle(binding.printer_id, binding.tool_index),
        await _mapped_printer_ids(db, profile.id),
    )
    return classification, installed


async def _validate_default(
    db: AsyncSession,
    binding: PrinterSlicerBinding,
    profile_id: int | None,
    profile_type: str,
    owner_id: int | None = None,
) -> None:
    if profile_id is None:
        return
    profile, revision, active = await _profile_revision(
        db,
        profile_id,
        profile_type,
        require_active=True,
        require_shared=owner_id is None,
        owner_id=owner_id,
    )
    assert revision is not None
    classification, _installed = await _classify_one(db, binding, profile, revision, active)
    if classification.group != "selected_printer":
        raise HTTPException(422, f"Default {profile_type} profile is not compatible with binding")


async def _validate_enforcement(db: AsyncSession, binding: PrinterSlicerBinding) -> None:
    if binding.enforcement_state != "enforced":
        return
    profile, revision, _available = await _profile_revision(db, binding.profile_id, "printer")
    readiness = evaluate_nozzle(
        await _binding_evidence(db, binding, profile, revision), _nozzle(binding.printer_id, binding.tool_index)
    )
    if readiness.state != "ready":
        raise HTTPException(422, {"code": "printer_not_ready", "reason_codes": readiness.reason_codes})


@router.get("/bindings")
async def list_bindings(
    printer_id: int | None = Query(default=None),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    query = select(PrinterSlicerBinding).order_by(PrinterSlicerBinding.id)
    if printer_id is not None:
        query = query.where(PrinterSlicerBinding.printer_id == printer_id)
    rows = (await db.scalars(query)).all()
    return [await _binding_json(db, row) for row in rows]


@router.get("/printers/{printer_id}/bindings")
async def list_printer_bindings(
    printer_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    await _printer(db, printer_id)
    rows = (
        await db.scalars(
            select(PrinterSlicerBinding)
            .where(PrinterSlicerBinding.printer_id == printer_id)
            .order_by(PrinterSlicerBinding.id)
        )
    ).all()
    return [await _binding_json(db, row) for row in rows]


@router.post("/bindings", status_code=201)
async def create_binding(
    data: BindingRequest,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_UPDATE),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await _printer(db, data.printer_id)
    await _profile_revision(db, data.profile_id, "printer", require_active=True, require_shared=True)
    binding = PrinterSlicerBinding(
        printer_id=data.printer_id,
        profile_id=data.profile_id,
        expected_nozzle_diameter=data.expected_nozzle_diameter,
        tool_index=data.tool_index,
        default_process_profile_id=data.default_process_profile_id,
        default_filament_profile_id=data.default_filament_profile_id,
        enforcement_state=data.enforcement_state,
        is_active=True,
        confirmed_by_user_id=current_user.id if current_user is not None else None,
        confirmed_at=_now(),
    )
    await _validate_default(db, binding, data.default_process_profile_id, "process")
    await _validate_default(db, binding, data.default_filament_profile_id, "filament")
    await _validate_enforcement(db, binding)
    db.add(binding)
    try:
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(409, "Exact binding already exists") from error
    await db.refresh(binding)
    return await _binding_json(db, binding)


@router.put("/bindings/{binding_id}")
async def update_binding(
    binding_id: int,
    data: BindingUpdate,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_UPDATE),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    binding, _profile, _revision = await _binding_row(db, binding_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(binding, key, value)
    await _profile_revision(db, binding.profile_id, "printer", require_active=True, require_shared=True)
    await _validate_default(db, binding, binding.default_process_profile_id, "process")
    await _validate_default(db, binding, binding.default_filament_profile_id, "filament")
    binding.confirmed_by_user_id = current_user.id if current_user is not None else None
    binding.confirmed_at = _now()
    await _validate_enforcement(db, binding)
    try:
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(409, "Exact binding already exists") from error
    await db.refresh(binding)
    return await _binding_json(db, binding)


@router.post("/bindings/{binding_id}/disable")
async def disable_binding(
    binding_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_UPDATE),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    binding, _profile, _revision = await _binding_row(db, binding_id)
    binding.is_active = False
    await db.commit()
    return {"id": binding.id, "is_active": False}


@router.get("/printers/{printer_id}/suggestion")
async def suggest_binding(
    printer_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    printer = await _printer(db, printer_id)
    profiles: list[tuple[int, str, str | None]] = []
    for profile in (
        await db.scalars(
            select(SlicerProfile).where(SlicerProfile.profile_type == "printer").order_by(SlicerProfile.id)
        )
    ).all():
        _profile, revision, available = await _profile_revision(db, profile.id, "printer")
        if not available or revision is None:
            continue
        metadata = _metadata(revision)
        model = metadata.get("model") or metadata.get("printer_model")
        if model is None:
            model = revision.content.get("model") or revision.content.get("printer_model")
        profiles.append((profile.id, profile.display_name, str(model) if model is not None else None))
    bindings = (
        await db.scalars(
            select(PrinterSlicerBinding).where(
                PrinterSlicerBinding.printer_id == printer.id,
                PrinterSlicerBinding.is_active.is_(True),
            )
        )
    ).all()
    return {
        "printer_id": printer.id,
        "suggested_profile_ids": suggest_p1s_binding(
            provider=printer.provider,
            printer_model=printer.model,
            active_printer_profiles=tuple(profiles),
        ),
        "requires_confirmation": True,
        "readiness": "configured" if bindings else "setup_required",
    }


@router.get("/printers/{printer_id}/classification")
async def classify_catalog(
    printer_id: int,
    binding_id: int,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> dict[str, list[dict[str, Any]]]:
    await _printer(db, printer_id)
    binding, _profile, _revision = await _binding_row(db, binding_id)
    if binding.printer_id != printer_id:
        raise HTTPException(422, "Binding does not target printer")
    visibility = SlicerProfileAccount.sharing_state == "shared"
    if current_user is not None:
        visibility = or_(visibility, SlicerProfileAccount.user_id == current_user.id)
    profiles = (
        await db.execute(
            select(SlicerProfile, SlicerProfileAccount)
            .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
            .where(SlicerProfile.profile_type.in_(["process", "filament"]), visibility)
            .order_by(SlicerProfile.display_name, SlicerProfile.id)
        )
    ).all()
    groups: dict[str, list[dict[str, Any]]] = {
        "selected_printer": [],
        "other_installed_printers": [],
        "unclassified": [],
        "incompatible": [],
    }
    for profile, account in profiles:
        _profile, revision, active = await _profile_revision(
            db,
            profile.id,
            owner_id=current_user.id if current_user is not None else None,
        )
        if revision is None:
            continue
        classification, _installed = await _classify_one(db, binding, profile, revision, active)
        groups[classification.group].append(
            {
                "profile_id": profile.id,
                "revision_id": revision.id,
                "profile_type": profile.profile_type,
                "display_name": profile.display_name,
                "source": account.source,
                "account_id": account.id,
                "account_name": account.display_name,
                "stale": profile.stale_at is not None,
                "classification": _classification_json(classification),
            }
        )
    return groups


@router.get("/mappings")
async def list_mappings(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, int]]:
    return [
        {"id": row.id, "profile_id": row.profile_id, "printer_id": row.printer_id}
        for row in (await db.scalars(select(SlicerCompatibilityMapping).order_by(SlicerCompatibilityMapping.id))).all()
    ]


@router.post("/mappings", status_code=201)
async def create_mapping(
    data: MappingRequest,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_UPDATE),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    await _printer(db, data.printer_id)
    profile, revision, _active = await _profile_revision(db, data.profile_id, require_active=True, require_shared=True)
    assert revision is not None
    if _metadata(revision).get("compatible_printers"):
        raise HTTPException(422, "Administrator mappings can only fill unknown compatibility")
    mapping = SlicerCompatibilityMapping(
        profile_id=profile.id,
        printer_id=data.printer_id,
        created_by_user_id=current_user.id if current_user is not None else None,
    )
    db.add(mapping)
    try:
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(409, "Compatibility mapping already exists") from error
    await db.refresh(mapping)
    return {"id": mapping.id, "profile_id": mapping.profile_id, "printer_id": mapping.printer_id}


@router.delete("/mappings/{mapping_id}", status_code=204)
async def delete_mapping(
    mapping_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_UPDATE),
    db: AsyncSession = Depends(get_db),
) -> None:
    mapping = await db.get(SlicerCompatibilityMapping, mapping_id)
    if mapping is None:
        raise HTTPException(404, "Mapping not found")
    await db.delete(mapping)
    await db.commit()


@router.get("/filament-rules")
async def list_filament_rules(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = (await db.scalars(select(SlicerFilamentRule).order_by(SlicerFilamentRule.id))).all()
    return [
        {
            "id": row.id,
            "scope": row.scope,
            "filament_profile_id": row.filament_profile_id,
            "binding_id": row.binding_id,
            "external_source": row.external_source,
            "external_identity": row.external_identity,
            "material_type": row.material_type,
            "vendor": row.vendor,
            "nozzle_diameter_min": row.nozzle_diameter_min,
            "nozzle_diameter_max": row.nozzle_diameter_max,
            "is_active": row.is_active,
        }
        for row in rows
    ]


@router.post("/filament-rules", status_code=201)
async def create_filament_rule(
    data: FilamentRuleRequest,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    external_source = data.external_source.strip() if data.external_source else None
    external_identity = data.external_identity.strip() if data.external_identity else None
    material_type = data.material_type.strip() if data.material_type else None
    vendor = data.vendor.strip() if data.vendor else None
    if data.scope == "exact_external" and (not external_source or not external_identity):
        raise HTTPException(422, "Exact external rules require source and stable identity")
    if data.scope == "signature" and not (material_type or vendor):
        raise HTTPException(422, "Signature rules require vendor or material metadata")
    if (
        data.nozzle_diameter_min is not None
        and data.nozzle_diameter_max is not None
        and data.nozzle_diameter_min > data.nozzle_diameter_max
    ):
        raise HTTPException(422, "Minimum nozzle diameter cannot exceed maximum")
    await _profile_revision(db, data.filament_profile_id, "filament", require_active=True, require_shared=True)
    binding = None
    if data.binding_id is not None:
        binding, _profile, _revision = await _binding_row(db, data.binding_id)
        await _validate_default(db, binding, data.filament_profile_id, "filament")
    duplicate = select(SlicerFilamentRule).where(
        SlicerFilamentRule.scope == data.scope,
        SlicerFilamentRule.binding_id == data.binding_id,
        SlicerFilamentRule.is_active.is_(True),
    )
    if data.scope == "exact_external":
        duplicate = duplicate.where(
            SlicerFilamentRule.external_source == external_source,
            SlicerFilamentRule.external_identity == external_identity,
        )
    else:
        duplicate = duplicate.where(
            SlicerFilamentRule.vendor == vendor,
            SlicerFilamentRule.material_type == material_type,
        )
    if await db.scalar(duplicate) is not None:
        raise HTTPException(409, "Filament rule already exists")
    rule = SlicerFilamentRule(
        scope=data.scope,
        external_source=external_source,
        external_identity=external_identity,
        filament_profile_id=data.filament_profile_id,
        binding_id=data.binding_id,
        printer_profile_id=binding.profile_id if binding is not None else None,
        material_type=material_type,
        vendor=vendor,
        nozzle_diameter_min=data.nozzle_diameter_min,
        nozzle_diameter_max=data.nozzle_diameter_max,
        is_active=True,
        created_by_user_id=current_user.id if current_user is not None else None,
    )
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return {"id": rule.id, "scope": rule.scope, "filament_profile_id": rule.filament_profile_id}


@router.delete("/filament-rules/{rule_id}", status_code=204)
async def delete_filament_rule(
    rule_id: int,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
) -> None:
    rule = await db.get(SlicerFilamentRule, rule_id)
    if rule is None:
        raise HTTPException(404, "Filament rule not found")
    await db.delete(rule)
    await db.commit()


@router.get("/preferences/{binding_id}")
async def list_preferences(
    binding_id: int,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    if current_user is None:
        return []
    rows = (
        await db.scalars(
            select(UserSlicerPreference).where(
                UserSlicerPreference.user_id == current_user.id,
                UserSlicerPreference.binding_id == binding_id,
            )
        )
    ).all()
    return [{"id": row.id, "key": row.preference_key, "value": row.value} for row in rows]


@router.put("/preferences")
async def save_preference(
    data: PreferenceRequest,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if current_user is None:
        raise HTTPException(409, "Per-user preferences require an authenticated user")
    binding, _profile, _revision = await _binding_row(db, data.binding_id)
    await _validate_default(db, binding, data.profile_id, data.profile_type, current_user.id)
    key = f"{data.profile_type}_profile"
    preference = await db.scalar(
        select(UserSlicerPreference).where(
            UserSlicerPreference.user_id == current_user.id,
            UserSlicerPreference.binding_id == data.binding_id,
            UserSlicerPreference.preference_key == key,
        )
    )
    if preference is None:
        preference = UserSlicerPreference(
            user_id=current_user.id,
            binding_id=data.binding_id,
            preference_key=key,
            value={"profile_id": data.profile_id},
        )
        db.add(preference)
    else:
        preference.value = {"profile_id": data.profile_id}
    await db.commit()
    await db.refresh(preference)
    return {"id": preference.id, "key": preference.preference_key, "value": preference.value}


@router.delete("/preferences/{preference_id}", status_code=204)
async def delete_preference(
    preference_id: int,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> None:
    if current_user is None:
        raise HTTPException(404, "Preference not found")
    preference = await db.get(UserSlicerPreference, preference_id)
    if preference is None or preference.user_id != current_user.id:
        raise HTTPException(404, "Preference not found")
    await db.delete(preference)
    await db.commit()


@router.post("/profiles/{profile_id}/retire")
async def retire_profile(
    profile_id: int,
    data: RetirementRequest,
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if data.replacement_profile_id is not None and data.disable_references:
        raise HTTPException(422, "Choose replacement or disable references, not both")
    profile = await db.get(SlicerProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "Catalog profile not found")
    if data.replacement_profile_id == profile.id:
        raise HTTPException(422, "Replacement must be a different profile")

    references = await catalog_profile_references(db, profile.id)
    bindings = references.bindings
    mappings = references.mappings
    rules = references.rules
    preferences = references.preferences
    if references.referenced and data.replacement_profile_id is None and not data.disable_references:
        raise HTTPException(409, references.detail())

    replacement: SlicerProfile | None = None
    replacement_revision: SlicerProfileRevision | None = None
    if data.replacement_profile_id is not None:
        replacement, replacement_revision, _active = await _profile_revision(
            db,
            data.replacement_profile_id,
            profile.profile_type,
            require_active=True,
            require_shared=True,
        )
        assert replacement_revision is not None
        for binding in bindings:
            if binding.default_process_profile_id == profile.id:
                await _validate_default(db, binding, replacement.id, "process")
            if binding.default_filament_profile_id == profile.id:
                await _validate_default(db, binding, replacement.id, "filament")
        for rule in rules:
            if rule.binding_id is not None:
                binding = await db.get(PrinterSlicerBinding, rule.binding_id)
                if binding is not None:
                    await _validate_default(db, binding, replacement.id, "filament")
        for preference in preferences:
            binding = await db.get(PrinterSlicerBinding, preference.binding_id)
            if binding is not None:
                await _validate_default(db, binding, replacement.id, profile.profile_type)

        for binding in bindings:
            if binding.profile_id == profile.id:
                binding.profile_id = replacement.id
            if binding.default_process_profile_id == profile.id:
                binding.default_process_profile_id = replacement.id
            if binding.default_filament_profile_id == profile.id:
                binding.default_filament_profile_id = replacement.id
        replacement_has_authority = bool(_metadata(replacement_revision).get("compatible_printers"))
        for mapping in mappings:
            existing = await db.scalar(
                select(SlicerCompatibilityMapping).where(
                    SlicerCompatibilityMapping.profile_id == replacement.id,
                    SlicerCompatibilityMapping.printer_id == mapping.printer_id,
                )
            )
            if replacement_has_authority or existing is not None:
                await db.delete(mapping)
            else:
                mapping.profile_id = replacement.id
        for rule in rules:
            rule.filament_profile_id = replacement.id
        for preference in preferences:
            preference.value = {**(preference.value or {}), "profile_id": replacement.id}
    elif data.disable_references:
        for binding in bindings:
            binding.is_active = False
        for mapping in mappings:
            await db.delete(mapping)
        for rule in rules:
            rule.is_active = False
        for preference in preferences:
            await db.delete(preference)

    profile.tombstoned_at = _now()
    try:
        await db.commit()
    except IntegrityError as error:
        await db.rollback()
        raise HTTPException(409, "Replacement conflicts with an existing catalog reference") from error
    return {
        "profile_id": profile.id,
        "replacement_profile_id": replacement.id if replacement is not None else None,
        "disabled_binding_ids": sorted(binding.id for binding in bindings if not binding.is_active),
        "retired": True,
    }


@router.post("/evaluations")
async def evaluate_catalog(
    data: EvaluationRequest,
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.PRINTERS_READ),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    binding, _printer_profile, _printer_revision = await _binding_row(db, data.binding_id)
    profile, revision, active = await _profile_revision(
        db,
        data.profile_id,
        owner_id=current_user.id if current_user is not None else None,
    )
    if revision is None or profile.profile_type not in {"process", "filament"}:
        raise HTTPException(422, "Process or filament profile is required")
    classification, _installed = await _classify_one(db, binding, profile, revision, active)
    legacy_eligible = True
    shadow = shadow_evaluate(legacy_eligible, classification)
    nozzle = _nozzle(binding.printer_id, binding.tool_index)
    mappings = sorted(await _mapped_printer_ids(db, profile.id))
    evaluation = SlicerSelectionEvaluation(
        printer_id=binding.printer_id,
        binding_id=binding.id,
        readiness_state=classification.readiness,
        selected_revision_ids={profile.profile_type: revision.id},
        compatibility_evidence={
            "classification": _classification_json(classification),
            "administrator_mapping_printer_ids": mappings,
            "legacy_eligible": legacy_eligible,
            "new_eligible": classification.group == "selected_printer" and classification.selectable,
        },
        nozzle_evidence=_nozzle_json(nozzle),
        acknowledgement=data.acknowledgement,
    )
    db.add(evaluation)
    await db.commit()
    await db.refresh(evaluation)
    return {
        "evaluation_id": evaluation.id,
        "dispatch_eligible": shadow.dispatch_eligible,
        "differs": shadow.differs,
        "classification": _classification_json(classification),
    }
