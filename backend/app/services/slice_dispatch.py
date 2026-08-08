"""Durable background dispatcher for slice jobs."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from sqlalchemy import delete, select, update

from backend.app.core import database
from backend.app.models.slice_job import SliceJobRecord

logger = logging.getLogger(__name__)

SliceJobStatus = Literal[
    "pending",
    "running",
    "completed",
    "failed",
    "cancel-requested",
    "cancelled",
]

_RETENTION = timedelta(minutes=30)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SliceDispatchService:
    """Run jobs in-process while persisting API-visible state in the database."""

    def __init__(self) -> None:
        self._tasks: dict[int, asyncio.Task] = {}
        self._progress_tasks: set[asyncio.Task] = set()

    async def enqueue(
        self,
        *,
        kind: Literal["library_file", "archive"],
        source_id: int,
        source_name: str,
        run: Callable[[int], Awaitable[dict[str, Any]]],
        owner_id: int | None = None,
        request_snapshot: dict[str, Any] | None = None,
        schema_hash: str | None = None,
    ) -> SliceJobRecord:
        now = _now()
        request_fingerprint = None
        if request_snapshot is not None:
            canonical_request = json.dumps(
                request_snapshot,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode()
            request_fingerprint = hashlib.sha256(canonical_request).hexdigest()
        async with database.async_session() as db:
            await db.execute(
                delete(SliceJobRecord).where(
                    SliceJobRecord.expires_at.is_not(None),
                    SliceJobRecord.expires_at <= now,
                )
            )
            job = SliceJobRecord(
                owner_id=owner_id,
                source_kind=kind,
                source_id=source_id,
                source_name=source_name,
                request_snapshot=request_snapshot,
                request_fingerprint=request_fingerprint,
                schema_hash=schema_hash,
                status="pending",
                created_at=now,
                expires_at=None,
            )
            db.add(job)
            await db.commit()
            await db.refresh(job)

        task = asyncio.create_task(self._run_job(job.id, run), name=f"slice-job-{job.id}")
        self._tasks[job.id] = task
        return job

    async def _run_job(
        self,
        job_id: int,
        run: Callable[[int], Awaitable[dict[str, Any]]],
    ) -> None:
        await self._set_running(job_id)
        try:
            result = await run(job_id)
            await self._set_completed(job_id, result)
        except _SliceJobError as exc:
            await self._set_failed(job_id, exc.status_code, exc.code, exc.detail)
        except Exception as exc:
            logger.exception("Slice job %s failed unexpectedly", job_id)
            await self._set_failed(job_id, 500, "unexpected_error", f"Unexpected error: {exc}")
        finally:
            self._tasks.pop(job_id, None)

    async def _set_running(self, job_id: int) -> None:
        async with database.async_session() as db:
            await db.execute(
                update(SliceJobRecord)
                .where(SliceJobRecord.id == job_id, SliceJobRecord.status == "pending")
                .values(status="running", started_at=_now(), sidecar_request_id=str(job_id))
            )
            await db.commit()

    async def _set_completed(self, job_id: int, result: dict[str, Any]) -> None:
        now = _now()
        artifact_kind = None
        artifact_id = None
        if isinstance(result.get("library_file_id"), int):
            artifact_kind = "library_file"
            artifact_id = result["library_file_id"]
        elif isinstance(result.get("archive_id"), int):
            artifact_kind = "archive"
            artifact_id = result["archive_id"]
        async with database.async_session() as db:
            await db.execute(
                update(SliceJobRecord)
                .where(
                    SliceJobRecord.id == job_id,
                    SliceJobRecord.status.not_in(("completed", "failed", "cancelled")),
                )
                .values(
                    status="completed",
                    result=result,
                    result_artifact_kind=artifact_kind,
                    result_artifact_id=artifact_id,
                    completed_at=now,
                    expires_at=now + _RETENTION,
                )
            )
            await db.commit()

    async def _set_failed(self, job_id: int, status: int, code: str, detail: str) -> None:
        now = _now()
        async with database.async_session() as db:
            await db.execute(
                update(SliceJobRecord)
                .where(
                    SliceJobRecord.id == job_id,
                    SliceJobRecord.status.not_in(("completed", "failed", "cancelled")),
                )
                .values(
                    status="failed",
                    error_status=status,
                    error_code=code,
                    error_detail=detail,
                    completed_at=now,
                    expires_at=now + _RETENTION,
                )
            )
            await db.commit()

    async def get(self, job_id: int) -> SliceJobRecord | None:
        async with database.async_session() as db:
            return await db.scalar(
                select(SliceJobRecord).where(
                    SliceJobRecord.id == job_id,
                    (SliceJobRecord.expires_at.is_(None) | (SliceJobRecord.expires_at > _now())),
                )
            )

    def set_progress(self, job_id: int, progress: dict[str, Any] | None) -> None:
        task = asyncio.create_task(self._persist_progress(job_id, progress), name=f"slice-progress-{job_id}")
        self._progress_tasks.add(task)
        task.add_done_callback(self._progress_tasks.discard)

    async def _persist_progress(self, job_id: int, progress: dict[str, Any] | None) -> None:
        try:
            async with database.async_session() as db:
                await db.execute(
                    update(SliceJobRecord)
                    .where(SliceJobRecord.id == job_id, SliceJobRecord.status == "running")
                    .values(progress=progress)
                )
                await db.commit()
        except Exception:
            logger.warning("Failed to persist progress for slice job %s", job_id, exc_info=True)

    async def mark_interrupted_jobs_failed(self) -> int:
        """Fail jobs left non-terminal by a previous process."""
        now = _now()
        async with database.async_session() as db:
            result = await db.execute(
                update(SliceJobRecord)
                .where(SliceJobRecord.status.in_(("pending", "running", "cancel-requested")))
                .values(
                    status="failed",
                    error_status=503,
                    error_code="worker_restarted",
                    error_detail="Slicer worker restarted before the job completed",
                    completed_at=now,
                    expires_at=now + _RETENTION,
                )
            )
            await db.commit()
            return result.rowcount or 0


class _SliceJobError(Exception):
    def __init__(self, status_code: int, detail: str, code: str = "slice_failed") -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code


def http_exception_to_job_error(exc) -> _SliceJobError:
    detail = exc.detail
    if isinstance(detail, dict):
        return _SliceJobError(
            exc.status_code,
            str(detail.get("detail") or detail.get("message") or detail),
            str(detail.get("code") or "slice_failed"),
        )
    return _SliceJobError(exc.status_code, str(detail))


slice_dispatch = SliceDispatchService()
