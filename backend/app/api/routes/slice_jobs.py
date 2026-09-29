"""Polling endpoint for durable, owner-scoped slice jobs."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import require_caller_identity_if_auth_enabled
from backend.app.core.database import get_db
from backend.app.core.identity import CallerIdentity
from backend.app.core.permissions import Permission
from backend.app.models.slice_job import SliceJobRecord
from backend.app.schemas.slicer import (
    HistoricalReslicePrepareRequest,
    HistoricalReslicePrepareResponse,
)
from backend.app.schemas.slicer_contract import SliceJobStateResponse
from backend.app.services.slice_dispatch import slice_dispatch
from backend.app.services.slicer_catalog_selection import (
    CatalogSelectionError,
    prepare_historical_reslice,
)

router = APIRouter(prefix="/slice-jobs", tags=["slice-jobs"])


def _require_job_access(job: SliceJobRecord | None, caller: CallerIdentity) -> SliceJobRecord:
    if job is None:
        raise HTTPException(status_code=404, detail="Slice job not found or expired")
    permissions = {
        "archive": (Permission.ARCHIVES_READ_ALL, Permission.ARCHIVES_READ_OWN),
        "library_file": (Permission.LIBRARY_READ_ALL, Permission.LIBRARY_READ_OWN),
    }.get(job.source_kind)
    if permissions is None:
        raise HTTPException(status_code=404, detail="Slice job not found or expired")
    decision = caller.require_ownership(*permissions)
    if not decision.can_access_all and job.owner_id != decision.owner_id:
        raise HTTPException(status_code=404, detail="Slice job not found or expired")
    return job


@router.get("/{job_id}", response_model=SliceJobStateResponse)
async def get_slice_job(
    job_id: int,
    caller: CallerIdentity = Depends(require_caller_identity_if_auth_enabled()),
):
    job = _require_job_access(await slice_dispatch.get(job_id), caller)
    provenance = await slice_dispatch.get_provenance(job.id)

    body: dict = {
        "job_id": job.id,
        "status": job.status,
        "kind": job.source_kind,
        "source_id": job.source_id,
        "source_name": job.source_name,
        "schema_hash": job.schema_hash,
        "request_fingerprint": job.request_fingerprint,
        "created_at": job.created_at.isoformat(),
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "progress": job.progress,
        "provenance": (
            {
                "state": provenance.provenance_state,
                "printer_revision_id": provenance.printer_revision_id,
                "process_revision_id": provenance.process_revision_id,
                "filament_revision_ids": provenance.filament_revision_ids,
                "selection_evidence": provenance.selection_evidence,
                "created_at": provenance.created_at,
            }
            if provenance is not None
            else None
        ),
    }
    if job.status == "completed":
        body["result"] = job.result
    elif job.status in ("failed", "cancelled"):
        body["error_status"] = job.error_status
        body["error_code"] = job.error_code
        body["error_detail"] = job.error_detail
    return body


@router.post("/{job_id}/reslice-request", response_model=HistoricalReslicePrepareResponse)
async def prepare_reslice_request(
    job_id: int,
    body: HistoricalReslicePrepareRequest,
    db: AsyncSession = Depends(get_db),
    caller: CallerIdentity = Depends(require_caller_identity_if_auth_enabled()),
):
    source_job = _require_job_access(await slice_dispatch.get(job_id), caller)
    try:
        preview = await prepare_historical_reslice(db, source_job, body)
    except CatalogSelectionError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={
                "code": error.code,
                "message": error.code.replace("_", " "),
                "reason_codes": error.reason_codes,
            },
        ) from error
    return {
        "source_kind": source_job.source_kind,
        "source_id": source_job.source_id,
        "request": preview.request,
        "tombstoned": preview.tombstoned,
        "revision_ids": preview.revision_ids,
    }
