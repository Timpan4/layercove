"""Transactional catalog selection validation and durable revision pinning."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.printer import Printer
from backend.app.models.slice_job import SliceJobRecord
from backend.app.models.slicer_profile_catalog import (
    PrinterSlicerBinding,
    SlicerCompatibilityMapping,
    SlicerJobProvenance,
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileRevision,
    SlicerSelectionEvaluation,
)
from backend.app.schemas.slicer import HistoricalReslicePrepareRequest, SliceRequest
from backend.app.services.printer_manager import printer_manager
from backend.app.services.slicer_compatibility import (
    BindingEvidence,
    NozzleEvidence,
    ProfileEvidence,
    classify_profile,
)


class CatalogSelectionError(ValueError):
    def __init__(self, code: str, reason_codes: list[str], status_code: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.reason_codes = reason_codes
        self.status_code = status_code


@dataclass(frozen=True)
class PinnedProfileContent:
    printer: str
    process: str
    filaments: tuple[str, ...]
    process_source: str


@dataclass(frozen=True)
class HistoricalRequestPreview:
    request: SliceRequest
    tombstoned: bool
    revision_ids: dict[str, Any]


ProfileRow = tuple[SlicerProfile, SlicerProfileRevision, SlicerProfileAccount]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _metadata(revision: SlicerProfileRevision) -> dict[str, Any]:
    return dict((revision.resolved_metadata or {}).get("metadata") or {})


async def _active_revision(
    db: AsyncSession,
    profile_id: int,
    profile_type: str,
    owner_id: int | None = None,
) -> ProfileRow:
    row = (
        await db.execute(
            select(SlicerProfile, SlicerProfileRevision, SlicerProfileAccount)
            .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
            .join(SlicerProfileActivation, SlicerProfileActivation.profile_id == SlicerProfile.id)
            .join(SlicerProfileRevision, SlicerProfileRevision.id == SlicerProfileActivation.revision_id)
            .where(
                SlicerProfile.id == profile_id,
                SlicerProfile.profile_type == profile_type,
                SlicerProfileRevision.review_state == "approved",
            )
        )
    ).one_or_none()
    if row is None:
        raise CatalogSelectionError("profile_unavailable", ["profile_unavailable"])
    profile, revision, account = row
    if profile.tombstoned_at is not None:
        raise CatalogSelectionError("profile_tombstoned", ["profile_tombstoned"])
    if account.sharing_state != "shared" and (owner_id is None or account.user_id != owner_id):
        raise CatalogSelectionError("profile_not_shared", ["profile_not_shared"])
    return profile, revision, account


async def _exact_revision(db: AsyncSession, revision_id: int, profile_type: str) -> ProfileRow:
    row = (
        await db.execute(
            select(SlicerProfile, SlicerProfileRevision, SlicerProfileAccount)
            .join(SlicerProfile, SlicerProfile.id == SlicerProfileRevision.profile_id)
            .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
            .where(
                SlicerProfileRevision.id == revision_id,
                SlicerProfile.profile_type == profile_type,
                SlicerProfileRevision.review_state == "approved",
            )
        )
    ).one_or_none()
    if row is None:
        raise CatalogSelectionError(
            "historical_revision_unavailable",
            ["historical_revision_unavailable"],
            status_code=409,
        )
    return row


def _ensure_historical_access(row: ProfileRow, owner_id: int | None) -> None:
    _profile, _revision, account = row
    if account.sharing_state != "shared" and (owner_id is None or account.user_id != owner_id):
        raise CatalogSelectionError("profile_not_shared", ["profile_not_shared"], status_code=403)


def _nozzle(binding: PrinterSlicerBinding) -> NozzleEvidence:
    snapshot = printer_manager.get_snapshot(binding.printer_id)
    if snapshot is None:
        return NozzleEvidence("offline", tool_index=binding.tool_index)
    nozzle = next((item for item in snapshot.nozzles if item.tool_index == binding.tool_index), None)
    diameter = Decimal(str(nozzle.diameter)) if nozzle is not None and nozzle.diameter is not None else None
    if not snapshot.connected:
        return NozzleEvidence("offline", diameter, binding.tool_index)
    if snapshot.telemetry_stale:
        return NozzleEvidence("stale", diameter, binding.tool_index)
    if nozzle is None or nozzle.status != "confirmed" or diameter is None:
        return NozzleEvidence("unknown", diameter, binding.tool_index)
    return NozzleEvidence("confirmed", diameter, binding.tool_index)


def _nozzle_json(nozzle: NozzleEvidence) -> dict[str, Any]:
    return {
        "status": nozzle.status,
        "diameter": float(nozzle.diameter) if nozzle.diameter is not None else None,
        "tool_index": nozzle.tool_index,
        "observed_at": _now().isoformat(),
    }


def _acknowledged(value: dict[str, Any] | None) -> bool:
    return value is not None and value.get("confirmed") is True


async def _mapping_ids(db: AsyncSession, profile_id: int) -> tuple[int, ...]:
    return tuple(
        await db.scalars(
            select(SlicerCompatibilityMapping.printer_id)
            .where(SlicerCompatibilityMapping.profile_id == profile_id)
            .order_by(SlicerCompatibilityMapping.printer_id)
        )
    )


def _profile_provenance(
    profile: SlicerProfile,
    revision: SlicerProfileRevision,
    account: SlicerProfileAccount,
) -> dict[str, Any]:
    return {
        "profile_id": profile.id,
        "revision_id": revision.id,
        "content_hash": revision.content_hash,
        "source": account.source,
        "account_id": account.id,
        "remote_account_id": account.remote_account_id,
        "remote_profile_id": profile.remote_profile_id,
    }


async def _load_history_source(
    db: AsyncSession,
    job: SliceJobRecord,
    history_job_id: int,
) -> tuple[SliceJobRecord, SlicerJobProvenance]:
    source_job = await db.get(SliceJobRecord, history_job_id)
    if (
        source_job is None
        or source_job.owner_id != job.owner_id
        or source_job.source_kind != job.source_kind
        or source_job.source_id != job.source_id
    ):
        raise CatalogSelectionError("historical_job_unavailable", ["historical_job_unavailable"], 404)
    provenance = await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == source_job.id))
    if provenance is None or provenance.provenance_state != "resolved":
        raise CatalogSelectionError(
            "historical_provenance_unknown",
            ["historical_provenance_unknown"],
            status_code=409,
        )
    return source_job, provenance


async def _historical_rows(
    db: AsyncSession,
    provenance: SlicerJobProvenance,
    owner_id: int | None,
) -> tuple[ProfileRow, ProfileRow, list[ProfileRow]]:
    if provenance.printer_revision_id is None or provenance.process_revision_id is None:
        raise CatalogSelectionError(
            "historical_provenance_unknown",
            ["historical_provenance_unknown"],
            status_code=409,
        )
    printer_row = await _exact_revision(db, provenance.printer_revision_id, "printer")
    process_row = await _exact_revision(db, provenance.process_revision_id, "process")
    filament_rows = [
        await _exact_revision(db, revision_id, "filament") for revision_id in provenance.filament_revision_ids or []
    ]
    if not filament_rows:
        raise CatalogSelectionError(
            "historical_provenance_unknown",
            ["historical_provenance_unknown"],
            status_code=409,
        )
    for row in (printer_row, process_row, *filament_rows):
        _ensure_historical_access(row, owner_id)
    return printer_row, process_row, filament_rows


def _history_target(provenance: SlicerJobProvenance) -> tuple[int, int]:
    evidence = provenance.selection_evidence or {}
    printer_id = evidence.get("printer_id")
    binding_id = evidence.get("binding_id")
    if not isinstance(printer_id, int) or not isinstance(binding_id, int):
        raise CatalogSelectionError(
            "historical_provenance_unknown",
            ["historical_provenance_unknown"],
            status_code=409,
        )
    return printer_id, binding_id


async def _persist_profile_rows(
    db: AsyncSession,
    job: SliceJobRecord,
    request: SliceRequest,
    printer_id: int,
    binding_id: int,
    printer_row: ProfileRow,
    process_row: ProfileRow,
    filament_rows: list[ProfileRow],
    *,
    force_validation: bool = False,
    history: dict[str, Any] | None = None,
) -> None:
    printer = await db.get(Printer, printer_id)
    binding = await db.get(PrinterSlicerBinding, binding_id)
    if printer is None or not printer.is_active or binding is None or not binding.is_active:
        raise CatalogSelectionError("binding_unavailable", ["binding_unavailable"])
    if binding.printer_id != printer.id:
        raise CatalogSelectionError("binding_printer_mismatch", ["binding_printer_mismatch"])

    printer_profile, printer_revision, printer_account = printer_row
    process_profile, process_revision, process_account = process_row
    binding_profile, binding_revision = printer_profile, printer_revision
    if binding.profile_id != printer_profile.id:
        if history is None:
            raise CatalogSelectionError("binding_profile_mismatch", ["binding_profile_mismatch"])
        binding_profile, binding_revision, _binding_account = await _active_revision(
            db, binding.profile_id, "printer", job.owner_id
        )

    printer_metadata = _metadata(binding_revision)
    binding_evidence = BindingEvidence(
        id=binding.id,
        printer_id=binding.printer_id,
        printer_profile_id=binding_profile.id,
        printer_profile_name=binding_profile.display_name,
        expected_nozzle_diameter=binding.expected_nozzle_diameter,
        aliases=tuple(item for item in printer_metadata.get("aliases", []) if isinstance(item, str) and item.strip()),
        active=True,
        profile_available=True,
        defaults_available=True,
    )
    nozzle = _nozzle(binding)
    installed = (binding_evidence,)
    classifications: list[dict[str, Any]] = []
    blocked_reasons: list[str] = []
    warning_reasons: list[str] = []

    for profile, revision, _account in [(process_profile, process_revision, process_account), *filament_rows]:
        metadata = _metadata(revision)
        compatibility = metadata.get("compatible_printers")
        mapping_ids = await _mapping_ids(db, profile.id)
        classification = classify_profile(
            ProfileEvidence(
                profile_id=profile.id,
                revision_id=revision.id,
                display_name=profile.display_name,
                compatible_printers=tuple(compatibility) if compatibility else None,
            ),
            binding_evidence,
            installed,
            nozzle,
            frozenset(mapping_ids),
        )
        evidence = {
            "profile_id": profile.id,
            "revision_id": revision.id,
            "profile_type": profile.profile_type,
            "classification": asdict(classification),
            "administrator_mapping_printer_ids": list(mapping_ids),
        }
        classifications.append(evidence)
        if classification.group in {"incompatible", "other_installed_printers"} or not classification.selectable:
            blocked_reasons.extend(classification.reason_codes)
        elif classification.acknowledgement_required:
            warning_reasons.extend(classification.reason_codes)

    readiness_state = "blocked" if blocked_reasons else "acknowledgement_required" if warning_reasons else "ready"
    validation_required = force_validation or binding.enforcement_state == "enforced"
    if validation_required:
        if blocked_reasons:
            raise CatalogSelectionError("slicer_profile_incompatible", sorted(set(blocked_reasons)))
        if warning_reasons and not _acknowledged(request.catalog_acknowledgement):
            raise CatalogSelectionError(
                "slicer_acknowledgement_required",
                sorted(set(warning_reasons)),
                status_code=409,
            )

    revision_ids = {
        "printer": printer_revision.id,
        "process": process_revision.id,
        "filaments": [revision.id for _profile, revision, _account in filament_rows],
    }
    evaluation = SlicerSelectionEvaluation(
        printer_id=printer.id,
        binding_id=binding.id,
        readiness_state=readiness_state,
        selected_revision_ids=revision_ids,
        compatibility_evidence={
            "profiles": classifications,
            "legacy_eligible": True,
            "new_eligible": not blocked_reasons,
            "differs": bool(blocked_reasons),
        },
        nozzle_evidence=_nozzle_json(nozzle),
        acknowledgement=request.catalog_acknowledgement,
    )
    db.add(evaluation)
    await db.flush()
    profile_evidence = {
        "printer": _profile_provenance(printer_profile, printer_revision, printer_account),
        "process": _profile_provenance(process_profile, process_revision, process_account),
        "filaments": [_profile_provenance(profile, revision, account) for profile, revision, account in filament_rows],
    }
    selection_evidence = {
        "printer_id": printer.id,
        "binding_id": binding.id,
        "expected_nozzle_diameter": float(binding.expected_nozzle_diameter),
        "tool_index": binding.tool_index,
        "enforcement_state": binding.enforcement_state,
        "profiles": profile_evidence,
        "compatibility": classifications,
        "readiness": {
            "state": readiness_state,
            "reason_codes": sorted({*blocked_reasons, *warning_reasons}),
        },
        "nozzle": evaluation.nozzle_evidence,
        "acknowledgement": request.catalog_acknowledgement,
        "selection": request.catalog_selection_evidence,
    }
    if history is not None:
        selection_evidence["history"] = history
    db.add(
        SlicerJobProvenance(
            slice_job_id=job.id,
            provenance_state="resolved",
            selection_evaluation_id=evaluation.id,
            printer_revision_id=printer_revision.id,
            process_revision_id=process_revision.id,
            filament_revision_ids=revision_ids["filaments"],
            selection_evidence=selection_evidence,
        )
    )


async def _enforced_profile_requires_binding(db: AsyncSession, request: SliceRequest) -> bool:
    if request.printer_preset is None:
        return False
    matching_states = (
        await db.scalars(
            select(PrinterSlicerBinding.enforcement_state)
            .join(SlicerProfile, SlicerProfile.id == PrinterSlicerBinding.profile_id)
            .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
            .where(
                PrinterSlicerBinding.is_active.is_(True),
                SlicerProfile.profile_type == "printer",
                SlicerProfile.remote_profile_id == request.printer_preset.id,
                SlicerProfileAccount.source == request.printer_preset.source,
            )
        )
    ).all()
    if matching_states:
        return "enforced" in matching_states
    return False


async def persist_catalog_selection(
    db: AsyncSession,
    job: SliceJobRecord,
    request: SliceRequest,
) -> None:
    """Validate and pin one request inside the slice-job transaction."""
    if request.catalog_history_job_id is not None:
        _source_job, source_provenance = await _load_history_source(db, job, request.catalog_history_job_id)
        printer_id, binding_id = _history_target(source_provenance)
        printer_row, process_row, filament_rows = await _historical_rows(db, source_provenance, job.owner_id)
        if request.catalog_history_mode == "upgrade":
            binding = await db.get(PrinterSlicerBinding, binding_id)
            if binding is None:
                raise CatalogSelectionError("binding_unavailable", ["binding_unavailable"])
            printer_row = await _active_revision(db, binding.profile_id, "printer", job.owner_id)
        tombstoned = [
            row[0].id for row in (printer_row, process_row, *filament_rows) if row[0].tombstoned_at is not None
        ]
        if request.catalog_history_mode == "exact":
            if tombstoned and not _acknowledged(request.catalog_tombstone_acknowledgement):
                raise CatalogSelectionError(
                    "historical_tombstone_acknowledgement_required",
                    ["profile_tombstoned"],
                    status_code=409,
                )
            request.catalog_printer_id = printer_id
            request.catalog_binding_id = binding_id
            request.catalog_process_profile_id = process_row[0].id
            request.catalog_filament_profile_ids = [row[0].id for row in filament_rows]
        else:
            process_row = await _active_revision(db, process_row[0].id, "process", job.owner_id)
            filament_rows = [await _active_revision(db, row[0].id, "filament", job.owner_id) for row in filament_rows]
            request.catalog_printer_id = printer_id
            request.catalog_binding_id = binding_id
            request.catalog_process_profile_id = process_row[0].id
            request.catalog_filament_profile_ids = [row[0].id for row in filament_rows]
        await _persist_profile_rows(
            db,
            job,
            request,
            printer_id,
            binding_id,
            printer_row,
            process_row,
            filament_rows,
            force_validation=True,
            history={
                "source_job_id": request.catalog_history_job_id,
                "mode": request.catalog_history_mode,
                "tombstone_acknowledgement": request.catalog_tombstone_acknowledgement,
            },
        )
        return

    if request.catalog_binding_id is None:
        if await _enforced_profile_requires_binding(db, request):
            raise CatalogSelectionError("slicer_binding_required", ["slicer_binding_required"], status_code=409)
        db.add(SlicerJobProvenance(slice_job_id=job.id, provenance_state="provenance_unknown"))
        return

    binding = await db.get(PrinterSlicerBinding, request.catalog_binding_id)
    if binding is None:
        raise CatalogSelectionError("binding_unavailable", ["binding_unavailable"])
    printer_row = await _active_revision(db, binding.profile_id, "printer", job.owner_id)
    process_row = await _active_revision(db, request.catalog_process_profile_id, "process", job.owner_id)
    filament_rows = [
        await _active_revision(db, profile_id, "filament", job.owner_id)
        for profile_id in request.catalog_filament_profile_ids
    ]
    await _persist_profile_rows(
        db,
        job,
        request,
        request.catalog_printer_id,
        request.catalog_binding_id,
        printer_row,
        process_row,
        filament_rows,
    )


async def prepare_historical_reslice(
    db: AsyncSession,
    source_job: SliceJobRecord,
    body: HistoricalReslicePrepareRequest,
) -> HistoricalRequestPreview:
    provenance = await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == source_job.id))
    if provenance is None or provenance.provenance_state != "resolved":
        raise CatalogSelectionError(
            "historical_provenance_unknown",
            ["historical_provenance_unknown"],
            status_code=409,
        )
    printer_id, binding_id = _history_target(provenance)
    printer_row, process_row, filament_rows = await _historical_rows(db, provenance, source_job.owner_id)
    tombstoned = any(row[0].tombstoned_at is not None for row in (printer_row, process_row, *filament_rows))
    if body.mode == "upgrade":
        binding = await db.get(PrinterSlicerBinding, binding_id)
        if binding is None:
            raise CatalogSelectionError("binding_unavailable", ["binding_unavailable"])
        printer_row = await _active_revision(db, binding.profile_id, "printer", source_job.owner_id)
        process_row = await _active_revision(db, process_row[0].id, "process", source_job.owner_id)
        filament_rows = [
            await _active_revision(db, row[0].id, "filament", source_job.owner_id) for row in filament_rows
        ]
        tombstoned = False

    snapshot = dict(source_job.request_snapshot or {})
    if not snapshot:
        raise CatalogSelectionError(
            "historical_request_unavailable",
            ["historical_request_unavailable"],
            status_code=409,
        )
    snapshot.pop("catalog_acknowledgement", None)
    snapshot.pop("catalog_tombstone_acknowledgement", None)
    snapshot.update(
        {
            "printer_preset": {
                "source": printer_row[2].source,
                "id": printer_row[0].remote_profile_id,
            },
            "process_preset": {
                "source": process_row[2].source,
                "id": process_row[0].remote_profile_id,
            },
            "filament_preset": {
                "source": filament_rows[0][2].source,
                "id": filament_rows[0][0].remote_profile_id,
            },
            "filament_presets": [{"source": row[2].source, "id": row[0].remote_profile_id} for row in filament_rows],
            "catalog_printer_id": printer_id,
            "catalog_binding_id": binding_id,
            "catalog_process_profile_id": process_row[0].id,
            "catalog_filament_profile_ids": [row[0].id for row in filament_rows],
            "catalog_history_job_id": source_job.id,
            "catalog_history_mode": body.mode,
        }
    )
    if body.catalog_acknowledgement is not None:
        snapshot["catalog_acknowledgement"] = body.catalog_acknowledgement
    if body.catalog_tombstone_acknowledgement is not None:
        snapshot["catalog_tombstone_acknowledgement"] = body.catalog_tombstone_acknowledgement
    request = SliceRequest.model_validate(snapshot)
    return HistoricalRequestPreview(
        request=request,
        tombstoned=tombstoned,
        revision_ids={
            "printer": printer_row[1].id,
            "process": process_row[1].id,
            "filaments": [row[1].id for row in filament_rows],
        },
    )


async def load_pinned_profile_content(db: AsyncSession, job_id: int | None) -> PinnedProfileContent | None:
    if job_id is None:
        return None
    provenance = await db.scalar(
        select(SlicerJobProvenance).where(
            SlicerJobProvenance.slice_job_id == job_id,
            SlicerJobProvenance.provenance_state == "resolved",
        )
    )
    if provenance is None:
        return None
    revision_ids = [
        provenance.printer_revision_id,
        provenance.process_revision_id,
        *(provenance.filament_revision_ids or []),
    ]
    if any(revision_id is None for revision_id in revision_ids):
        raise RuntimeError("Catalog provenance is missing pinned revisions")
    revision_rows = (
        await db.execute(
            select(SlicerProfileRevision, SlicerProfileAccount.source)
            .join(SlicerProfile, SlicerProfile.id == SlicerProfileRevision.profile_id)
            .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
            .where(SlicerProfileRevision.id.in_(revision_ids))
        )
    ).all()
    revisions = {revision.id: revision for revision, _source in revision_rows}
    sources = {revision.id: source for revision, source in revision_rows}
    if len(revisions) != len(set(revision_ids)):
        raise RuntimeError("Pinned catalog revision is unavailable")
    return PinnedProfileContent(
        printer=json.dumps(revisions[provenance.printer_revision_id].content),
        process=json.dumps(revisions[provenance.process_revision_id].content),
        filaments=tuple(
            json.dumps(revisions[revision_id].content) for revision_id in provenance.filament_revision_ids or []
        ),
        process_source=sources[provenance.process_revision_id],
    )
