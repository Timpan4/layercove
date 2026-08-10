"""Owner-scoped durable slice-job provenance API contracts."""

from datetime import datetime, timezone

import pytest

from backend.app.api.routes.slice_jobs import get_slice_job
from backend.app.core.identity import CallerIdentity
from backend.app.models.slice_job import SliceJobRecord
from backend.app.models.slicer_profile_catalog import SlicerJobProvenance
from backend.app.services.slice_dispatch import slice_dispatch


@pytest.mark.asyncio
async def test_get_slice_job_exposes_exact_provenance(monkeypatch):
    created_at = datetime.now(timezone.utc)
    job = SliceJobRecord(
        id=9,
        owner_id=None,
        source_kind="library_file",
        source_id=4,
        source_name="model.3mf",
        status="failed",
        created_at=created_at,
        error_status=500,
        error_code="slice_failed",
        error_detail="failed after enqueue",
    )
    provenance = SlicerJobProvenance(
        slice_job_id=9,
        provenance_state="resolved",
        printer_revision_id=11,
        process_revision_id=12,
        filament_revision_ids=[13, 14],
        selection_evidence={"printer_id": 1, "binding_id": 2},
        created_at=created_at,
    )

    async def get_job(_job_id):
        return job

    async def get_provenance(_job_id):
        return provenance

    monkeypatch.setattr(slice_dispatch, "get", get_job)
    monkeypatch.setattr(slice_dispatch, "get_provenance", get_provenance)

    response = await get_slice_job(9, CallerIdentity.auth_disabled())

    assert response["provenance"] == {
        "state": "resolved",
        "printer_revision_id": 11,
        "process_revision_id": 12,
        "filament_revision_ids": [13, 14],
        "selection_evidence": {"printer_id": 1, "binding_id": 2},
        "created_at": created_at,
    }
    assert response["error_code"] == "slice_failed"
