"""Polling endpoint for durable, owner-scoped slice jobs."""

from fastapi import APIRouter, Depends, HTTPException

from backend.app.core.auth import require_ownership_permission
from backend.app.core.permissions import Permission
from backend.app.models.user import User
from backend.app.schemas.slicer_contract import SliceJobStateResponse
from backend.app.services.slice_dispatch import slice_dispatch

router = APIRouter(prefix="/slice-jobs", tags=["slice-jobs"])


@router.get("/{job_id}", response_model=SliceJobStateResponse)
async def get_slice_job(
    job_id: int,
    auth_result: tuple[User | None, bool] = Depends(
        require_ownership_permission(
            Permission.LIBRARY_READ_ALL,
            Permission.LIBRARY_READ_OWN,
        )
    ),
):
    job = await slice_dispatch.get(job_id)
    user, can_read_all = auth_result
    if (
        job is None
        or (not can_read_all and user is None)
        or (not can_read_all and (job.owner_id is None or job.owner_id != user.id))
    ):
        raise HTTPException(status_code=404, detail="Slice job not found or expired")

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
    }
    if job.status == "completed":
        body["result"] = job.result
    elif job.status in ("failed", "cancelled"):
        body["error_status"] = job.error_status
        body["error_code"] = job.error_code
        body["error_detail"] = job.error_detail
    return body
