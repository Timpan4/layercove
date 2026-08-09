"""Tests for SliceDispatchService.set_progress.

The dispatcher exposes set_progress so the slice-route's parallel poller
(spawned alongside the blocking sidecar slice request) can publish
``{stage, total_percent, plate_index, plate_count}`` snapshots that the
status-poll endpoint surfaces to the UI's persistent progress toast.
"""

from __future__ import annotations

import asyncio
import hashlib
import json

import pytest

import backend.app.services.slice_dispatch as slice_dispatch_module
from backend.app.services.slice_dispatch import SliceDispatchService


@pytest.mark.asyncio
async def test_set_progress_attaches_snapshot_to_running_job(async_client):
    dispatcher = SliceDispatchService()

    started = asyncio.Event()
    release = asyncio.Event()

    async def runner(job_id: int) -> dict:
        started.set()
        # Hold the job in the running state until the test releases it.
        await release.wait()
        return {"library_file_id": 1}

    job = await dispatcher.enqueue(
        kind="library_file",
        source_id=1,
        source_name="x.stl",
        run=runner,
    )
    await started.wait()

    # Without progress published yet, the job's progress is None.
    assert (await dispatcher.get(job.id)) is not None
    assert (await dispatcher.get(job.id)).progress is None

    # First snapshot lands on the job.
    dispatcher.set_progress(
        job.id,
        {"stage": "Detecting perimeters", "total_percent": 12},
    )
    await asyncio.sleep(0.05)
    snap = (await dispatcher.get(job.id)).progress
    assert snap == {"stage": "Detecting perimeters", "total_percent": 12}

    # Second snapshot replaces, doesn't merge — the dispatcher just
    # holds the latest frame; the sidecar's pipe protocol always emits
    # the full set, so partial-frame merging would be wrong.
    dispatcher.set_progress(
        job.id,
        {"stage": "Generating G-code", "total_percent": 75, "plate_index": 1},
    )
    await asyncio.sleep(0.05)
    snap = (await dispatcher.get(job.id)).progress
    assert snap == {
        "stage": "Generating G-code",
        "total_percent": 75,
        "plate_index": 1,
    }

    # Release the runner so the job completes and the test cleans up.
    release.set()
    # Yield to the event loop so the runner's completion settles.
    await asyncio.sleep(0)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_fast_completed_job_persists_terminal_progress(async_client):
    dispatcher = SliceDispatchService()

    async def runner(_job_id: int) -> dict:
        return {"library_file_id": 1}

    job = await dispatcher.enqueue(
        kind="library_file",
        source_id=1,
        source_name="x.stl",
        run=runner,
    )
    task = dispatcher._tasks[job.id]
    await task

    stored = await dispatcher.get(job.id)
    assert stored.status == "completed"
    assert stored.progress == {"stage": "Completed", "total_percent": 100}


@pytest.mark.asyncio
async def test_set_progress_silently_ignores_unknown_job_id(async_client):
    """A late poll after retention sweep mustn't crash the polling task."""
    dispatcher = SliceDispatchService()
    # Should be a no-op, not an exception.
    dispatcher.set_progress(99999, {"stage": "x", "total_percent": 50})


@pytest.mark.asyncio
async def test_set_progress_can_clear_to_none(async_client):
    """Allow clearing — useful when the slice transitions to a final
    state and we want the toast to revert to the elapsed-time fallback
    on subsequent polls."""
    dispatcher = SliceDispatchService()
    started = asyncio.Event()
    release = asyncio.Event()

    async def runner(job_id: int) -> dict:
        started.set()
        await release.wait()
        return {"library_file_id": 1}

    job = await dispatcher.enqueue(
        kind="library_file",
        source_id=1,
        source_name="x.stl",
        run=runner,
    )
    await started.wait()

    dispatcher.set_progress(job.id, {"stage": "x", "total_percent": 50})
    await asyncio.sleep(0.05)
    assert (await dispatcher.get(job.id)).progress is not None
    dispatcher.set_progress(job.id, None)
    await asyncio.sleep(0.05)
    assert (await dispatcher.get(job.id)).progress is None

    release.set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_running_job_does_not_expire(async_client, monkeypatch):
    dispatcher = SliceDispatchService()
    started = asyncio.Event()
    release = asyncio.Event()

    async def runner(_job_id: int) -> dict:
        started.set()
        await release.wait()
        return {"library_file_id": 1}

    job = await dispatcher.enqueue(
        kind="library_file",
        source_id=1,
        source_name="x.stl",
        run=runner,
    )
    await started.wait()
    created_at = job.created_at
    monkeypatch.setattr(
        slice_dispatch_module,
        "_now",
        lambda: created_at + slice_dispatch_module._RETENTION * 2,
    )

    stored = await dispatcher.get(job.id)
    assert stored is not None
    assert stored.status == "running"
    assert stored.expires_at is None

    release.set()
    await asyncio.gather(dispatcher._tasks[job.id])


@pytest.mark.asyncio
async def test_restart_marks_running_job_failed(async_client):
    dispatcher = SliceDispatchService()
    started = asyncio.Event()
    release = asyncio.Event()

    async def runner(_job_id: int) -> dict:
        started.set()
        await release.wait()
        return {"library_file_id": 1}

    job = await dispatcher.enqueue(
        kind="library_file",
        source_id=1,
        source_name="x.stl",
        owner_id=7,
        run=runner,
    )
    await started.wait()

    assert await dispatcher.mark_interrupted_jobs_failed() == 1
    stored = await dispatcher.get(job.id)
    assert stored.status == "failed"
    assert stored.error_code == "worker_restarted"

    dispatcher._tasks[job.id].cancel()
    await asyncio.gather(dispatcher._tasks[job.id], return_exceptions=True)


@pytest.mark.asyncio
async def test_enqueue_fingerprints_unicode_as_utf8_json(async_client):
    dispatcher = SliceDispatchService()

    async def runner(_job_id: int) -> dict:
        return {}

    snapshot = {"name": "café"}
    job = await dispatcher.enqueue(
        kind="library_file",
        source_id=1,
        source_name="x.stl",
        run=runner,
        request_snapshot=snapshot,
    )

    canonical = json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    assert job.request_fingerprint == hashlib.sha256(canonical).hexdigest()
    await asyncio.gather(dispatcher._tasks[job.id])


@pytest.mark.asyncio
async def test_restart_failure_cannot_be_overwritten_by_late_completion(async_client):
    dispatcher = SliceDispatchService()
    started = asyncio.Event()
    release = asyncio.Event()

    async def runner(_job_id: int) -> dict:
        started.set()
        await release.wait()
        return {"library_file_id": 1}

    job = await dispatcher.enqueue(kind="library_file", source_id=1, source_name="x.stl", run=runner)
    await started.wait()
    assert await dispatcher.mark_interrupted_jobs_failed() == 1

    release.set()
    await asyncio.gather(dispatcher._tasks[job.id])
    stored = await dispatcher.get(job.id)
    assert stored.status == "failed"
    assert stored.error_code == "worker_restarted"


@pytest.mark.asyncio
async def test_restart_failure_cannot_be_overwritten_by_late_failure(async_client):
    dispatcher = SliceDispatchService()
    started = asyncio.Event()
    release = asyncio.Event()

    async def runner(_job_id: int) -> dict:
        started.set()
        await release.wait()
        raise slice_dispatch_module._SliceJobError(422, "late failure")

    job = await dispatcher.enqueue(kind="library_file", source_id=1, source_name="x.stl", run=runner)
    await started.wait()
    assert await dispatcher.mark_interrupted_jobs_failed() == 1

    release.set()
    await asyncio.gather(dispatcher._tasks[job.id])
    stored = await dispatcher.get(job.id)
    assert stored.status == "failed"
    assert stored.error_code == "worker_restarted"
    assert stored.error_status == 503
