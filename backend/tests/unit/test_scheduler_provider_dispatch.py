import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.main as main_module
import backend.app.models  # noqa: F401
import backend.app.services.print_scheduler as scheduler_module
from backend.app.api.routes.print_queue import stop_queue_item
from backend.app.core.database import Base, _migrate_print_queue_provider_identity
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_backend import BackendError, JobLifecycle
from backend.app.services.printer_manager import PrinterManager
from backend.app.services.printer_types import (
    NormalizedPrinterState,
    PrinterCapabilities,
    PrinterProvider,
    PrinterSnapshot,
)


@pytest.fixture
async def moonraker_queue(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'queue.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    source = tmp_path / "cube.gcode"
    source.write_bytes(b"G28\n")
    async with sessions() as db:
        printer = Printer(name="Klipper", provider="moonraker", model="Voron")
        db.add(printer)
        await db.flush()
        archive = PrintArchive(
            printer_id=printer.id,
            filename=source.name,
            file_path=source.name,
            file_size=source.stat().st_size,
            status="archived",
            print_name="Cube",
            extra_data={"destination_artifact_kind": "klipper_gcode", "source": "library"},
        )
        db.add(archive)
        await db.flush()
        item = PrintQueueItem(printer_id=printer.id, archive_id=archive.id, status="pending")
        db.add(item)
        await db.commit()
        ids = SimpleNamespace(printer=printer.id, archive=archive.id, item=item.id)
    try:
        yield sessions, tmp_path, source, ids
    finally:
        await engine.dispose()


def _backend(*, upload=None, start=None):
    return SimpleNamespace(
        provider=PrinterProvider.MOONRAKER,
        capabilities=PrinterCapabilities(upload_gcode=True, start_print=True),
        upload_gcode=upload or AsyncMock(return_value="queue/cube.gcode"),
        start_print=start or AsyncMock(return_value=True),
        bind_queued_job=MagicMock(),
        clear_queued_job_binding=MagicMock(),
    )


@pytest.mark.asyncio
async def test_moonraker_upload_claim_start_has_no_bambu_options(moonraker_queue):
    sessions, base_dir, source, ids = moonraker_queue
    backend = _backend()
    scheduler = PrintScheduler()
    with (
        patch.object(scheduler_module.settings, "base_dir", base_dir),
        patch.object(scheduler_module.printer_manager, "is_connected", return_value=True),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=backend),
        patch.object(scheduler, "_propagate_owner_to_printer_manager", AsyncMock()),
        patch.object(scheduler_module.notification_service, "on_queue_job_started", AsyncMock()),
    ):
        async with sessions() as db:
            await scheduler._start_print(db, await db.get(PrintQueueItem, ids.item))

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        archive = await db.get(PrintArchive, ids.archive)
        assert item.status == "printing"
        assert item.provider_job_id == "queue/cube.gcode"
        assert item.start_reconcile_after is None
        assert archive.status == "printing"
    handle = backend.upload_gcode.await_args.args[0]
    assert handle.closed
    upload_kwargs = backend.upload_gcode.await_args.kwargs
    assert upload_kwargs["filename"].startswith("queued-")
    assert upload_kwargs["filename"].endswith(".gcode")
    assert "cube" not in upload_kwargs["filename"]
    assert upload_kwargs["start"] is False
    assert upload_kwargs["size"] == source.stat().st_size
    backend.start_print.assert_awaited_once_with("queue/cube.gcode")
    backend.bind_queued_job.assert_called_once_with(
        item.provider_correlation_id, "queue/cube.gcode", "queue/cube.gcode"
    )


@pytest.mark.asyncio
async def test_moonraker_cancel_wins_after_upload_and_remote_file_is_retained(moonraker_queue):
    sessions, base_dir, _source, ids = moonraker_queue

    async def upload_then_cancel(*args, **kwargs):
        async with sessions() as db:
            item = await db.get(PrintQueueItem, ids.item)
            item.status = "cancelled"
            await db.commit()
        return "queue/cube.gcode"

    backend = _backend(upload=AsyncMock(side_effect=upload_then_cancel))
    scheduler = PrintScheduler()
    with (
        patch.object(scheduler_module.settings, "base_dir", base_dir),
        patch.object(scheduler_module.printer_manager, "is_connected", return_value=True),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=backend),
    ):
        async with sessions() as db:
            await scheduler._start_print(db, await db.get(PrintQueueItem, ids.item))

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        archive = await db.get(PrintArchive, ids.archive)
        assert item.status == "cancelled"
        assert archive.status == "archived"
        assert await db.scalar(select(func.count(PrintLogEntry.id))) == 0
    backend.start_print.assert_not_awaited()


@pytest.mark.asyncio
async def test_moonraker_upload_failure_records_one_queue_archive_log_outcome(moonraker_queue):
    sessions, base_dir, _source, ids = moonraker_queue
    backend = _backend(upload=AsyncMock(side_effect=RuntimeError("secret transport detail")))
    terminal_effects = AsyncMock()
    scheduler = PrintScheduler()
    scheduler.set_moonraker_terminal_effects(terminal_effects)
    with (
        patch.object(scheduler_module.settings, "base_dir", base_dir),
        patch.object(scheduler_module.printer_manager, "is_connected", return_value=True),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=backend),
    ):
        async with sessions() as db:
            await scheduler._start_print(db, await db.get(PrintQueueItem, ids.item))

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        archive = await db.get(PrintArchive, ids.archive)
        logs = list((await db.scalars(select(PrintLogEntry))).all())
        assert item.status == "failed"
        assert item.error_message == "Failed to upload G-code to Moonraker"
        assert archive.status == "failed"
        assert len(logs) == 1
        assert logs[0].failure_reason == "Failed to upload G-code to Moonraker"
    backend.start_print.assert_not_awaited()
    assert terminal_effects.await_args.args[0]["status"] == "failed"


@pytest.mark.asyncio
async def test_moonraker_upload_failure_does_not_overwrite_concurrent_cancel(moonraker_queue):
    sessions, base_dir, _source, ids = moonraker_queue

    async def cancel_then_fail(*args, **kwargs):
        async with sessions() as db:
            item = await db.get(PrintQueueItem, ids.item)
            item.status = "cancelled"
            await db.commit()
        raise RuntimeError("upload failed after cancel")

    backend = _backend(upload=AsyncMock(side_effect=cancel_then_fail))
    with (
        patch.object(scheduler_module.settings, "base_dir", base_dir),
        patch.object(scheduler_module.printer_manager, "is_connected", return_value=True),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=backend),
    ):
        async with sessions() as db:
            await PrintScheduler()._start_print(db, await db.get(PrintQueueItem, ids.item))

    async with sessions() as db:
        assert (await db.get(PrintQueueItem, ids.item)).status == "cancelled"
        assert (await db.get(PrintArchive, ids.archive)).status == "archived"
        assert await db.scalar(select(func.count(PrintLogEntry.id))) == 0


@pytest.mark.asyncio
async def test_moonraker_start_timeout_keeps_bound_printing_state_for_reconciliation(moonraker_queue):
    sessions, base_dir, _source, ids = moonraker_queue
    backend = _backend(start=AsyncMock(side_effect=BackendError("No response", code="timeout")))
    with (
        patch.object(scheduler_module.settings, "base_dir", base_dir),
        patch.object(scheduler_module.printer_manager, "is_connected", return_value=True),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=backend),
    ):
        scheduler = PrintScheduler()
        with (
            patch.object(scheduler, "_propagate_owner_to_printer_manager", AsyncMock()),
            patch.object(scheduler, "_schedule_moonraker_start_reconciliation") as reconcile,
        ):
            async with sessions() as db:
                await scheduler._start_print(db, await db.get(PrintQueueItem, ids.item))

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        assert item.status == "printing"
        assert item.provider_correlation_id
        assert item.start_reconcile_after is not None
        assert await db.scalar(select(func.count(PrintLogEntry.id))) == 0
    backend.bind_queued_job.assert_called_once()
    backend.clear_queued_job_binding.assert_not_called()
    reconcile.assert_called_once()


@pytest.mark.asyncio
async def test_moonraker_terminal_is_idempotent_and_preserves_archive_metadata(moonraker_queue):
    sessions, _base_dir, _source, ids = moonraker_queue
    started = datetime.now(timezone.utc)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.started_at = started
        item.provider_correlation_id = "queue-job"
        item.provider_job_id = "42"
        await db.commit()

    event = {
        "status": "completed",
        "filename": "queue/cube.gcode",
        "occurred_at": started,
        "correlation_id": "queue-job",
        "provider_job_id": "42",
    }
    with patch.object(scheduler_module, "async_session", sessions):
        assert await PrintScheduler.finalize_moonraker_job(ids.printer, event) is not None
        assert await PrintScheduler.finalize_moonraker_job(ids.printer, event) is None

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        archive = await db.get(PrintArchive, ids.archive)
        log_count = await db.scalar(select(func.count(PrintLogEntry.id)))
        assert item.status == "completed"
        assert archive.status == "completed"
        assert archive.extra_data == {"destination_artifact_kind": "klipper_gcode", "source": "library"}
        assert log_count == 1


@pytest.mark.asyncio
async def test_mixed_concurrent_terminals_have_one_atomic_winner(moonraker_queue):
    sessions, _base_dir, _source, ids = moonraker_queue
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.provider_correlation_id = "queue-job"
        item.provider_job_id = "42"
        await db.commit()

    completed = {
        "status": "completed",
        "filename": "cube.gcode",
        "correlation_id": "queue-job",
        "provider_job_id": "42",
    }
    failed = {**completed, "status": "failed", "reason": "heater fault"}
    with patch.object(scheduler_module, "async_session", sessions):
        outcomes = await asyncio.gather(
            PrintScheduler.finalize_moonraker_job(ids.printer, completed),
            PrintScheduler.finalize_moonraker_job(ids.printer, failed),
        )

    assert sum(outcome is not None for outcome in outcomes) == 1
    async with sessions() as db:
        assert await db.scalar(select(func.count(PrintLogEntry.id))) == 1
        item = await db.get(PrintQueueItem, ids.item)
        archive = await db.get(PrintArchive, ids.archive)
        assert item.status == archive.status == next(outcome for outcome in outcomes if outcome)["status"]


@pytest.mark.asyncio
async def test_delayed_terminal_cannot_finalize_newer_queue_job(moonraker_queue):
    sessions, _base_dir, _source, ids = moonraker_queue
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.provider_correlation_id = "job-b"
        item.provider_job_id = "202"
        await db.commit()

    delayed_a = {
        "status": "completed",
        "filename": "a.gcode",
        "correlation_id": "job-a",
        "provider_job_id": "101",
    }
    with patch.object(scheduler_module, "async_session", sessions):
        assert await PrintScheduler.finalize_moonraker_job(ids.printer, delayed_a) is None

    async with sessions() as db:
        assert (await db.get(PrintQueueItem, ids.item)).status == "printing"
        assert await db.scalar(select(func.count(PrintLogEntry.id))) == 0


@pytest.mark.asyncio
async def test_restart_observation_rebinds_durable_path_then_terminal_job_id(moonraker_queue):
    sessions, _base_dir, _source, ids = moonraker_queue
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.provider_correlation_id = "before-restart"
        item.provider_job_id = "queue/cube.gcode"
        await db.commit()

    observed = {
        "correlation_id": "moonraker:42",
        "provider_job_id": "42",
        "filename": "queue/cube.gcode",
    }
    with (
        patch.object(scheduler_module, "async_session", sessions),
        patch.object(scheduler_module.printer_manager, "stop_print_async", AsyncMock(return_value=False)),
    ):
        assert await PrintScheduler.bind_moonraker_observed(ids.printer, observed)
        assert await PrintScheduler.finalize_moonraker_job(ids.printer, {**observed, "status": "completed"})

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        assert item.provider_correlation_id == "moonraker:42"
        assert item.provider_job_id == "42"
        assert item.status == "completed"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state", "observed_filename", "expected_status"),
    [
        (NormalizedPrinterState.PRINTING, "queue/cube.gcode", "printing"),
        (NormalizedPrinterState.IDLE, None, "failed"),
        (NormalizedPrinterState.PRINTING, "external.gcode", "failed"),
    ],
)
async def test_ambiguous_start_reconciles_once_from_exact_observed_job(
    moonraker_queue, state, observed_filename, expected_status
):
    sessions, _base_dir, _source, ids = moonraker_queue
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.provider_correlation_id = "queue-job"
        item.provider_job_id = "queue/cube.gcode"
        item.start_reconcile_after = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    backend = SimpleNamespace(
        snapshot=lambda: PrinterSnapshot(PrinterProvider.MOONRAKER, True, state, filename=observed_filename),
        current_job_identity=lambda: (
            "42" if observed_filename == "queue/cube.gcode" else "external",
            observed_filename,
        ),
        clear_queued_job_binding=MagicMock(),
    )
    scheduler = PrintScheduler()
    with (
        patch.object(scheduler_module, "async_session", sessions),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=backend),
        patch.object(scheduler_module.printer_manager, "stop_print_async", AsyncMock(return_value=False)),
    ):
        await scheduler._reconcile_moonraker_start(
            ids.item, ids.printer, "queue-job", "queue/cube.gcode", grace_seconds=0
        )

    async with sessions() as db:
        assert (await db.get(PrintQueueItem, ids.item)).status == expected_status
        assert await db.scalar(select(func.count(PrintLogEntry.id))) == (0 if expected_status == "printing" else 1)
    if expected_status == "failed":
        backend.clear_queued_job_binding.assert_called_once_with("queue-job")


@pytest.mark.asyncio
@pytest.mark.parametrize("later_state", [NormalizedPrinterState.IDLE, NormalizedPrinterState.PRINTING])
async def test_persisted_ambiguous_start_retries_after_offline(moonraker_queue, later_state):
    sessions, _base_dir, _source, ids = moonraker_queue
    remote_path = "queue/queued-opaque.gcode"
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.provider_correlation_id = "queue-job"
        item.provider_job_id = remote_path
        item.start_reconcile_after = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    observed = SimpleNamespace(state=NormalizedPrinterState.OFFLINE, connected=False, filename=None)
    backend = SimpleNamespace(
        snapshot=lambda: PrinterSnapshot(
            PrinterProvider.MOONRAKER,
            observed.connected,
            observed.state,
            filename=observed.filename,
        ),
        current_job_identity=lambda: ("42", observed.filename),
        clear_queued_job_binding=MagicMock(),
    )
    scheduler = PrintScheduler()
    with (
        patch.object(scheduler_module, "async_session", sessions),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=backend),
        patch.object(scheduler_module.printer_manager, "stop_print_async", AsyncMock(return_value=False)),
    ):
        assert await scheduler._reconcile_persisted_moonraker_starts() == 0
        async with sessions() as db:
            item = await db.get(PrintQueueItem, ids.item)
            assert item.status == "printing"
            assert item.start_reconcile_after is not None

        observed.connected = True
        observed.state = later_state
        observed.filename = remote_path if later_state is NormalizedPrinterState.PRINTING else None
        assert await scheduler._reconcile_persisted_moonraker_starts() == 1

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        if later_state is NormalizedPrinterState.PRINTING:
            assert item.status == "printing"
            assert item.provider_job_id == "42"
            assert item.start_reconcile_after is None
        else:
            assert item.status == "failed"
            assert await db.scalar(select(func.count(PrintLogEntry.id))) == 1


@pytest.mark.asyncio
async def test_restart_scan_fails_due_start_only_from_connected_idle(moonraker_queue):
    sessions, _base_dir, _source, ids = moonraker_queue
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.provider_correlation_id = "queue-job"
        item.provider_job_id = "queue/queued-opaque.gcode"
        item.start_reconcile_after = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    backend = SimpleNamespace(
        snapshot=lambda: PrinterSnapshot(PrinterProvider.MOONRAKER, True, NormalizedPrinterState.IDLE),
        current_job_identity=lambda: (None, None),
        clear_queued_job_binding=MagicMock(),
    )
    with (
        patch.object(scheduler_module, "async_session", sessions),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=backend),
    ):
        assert await PrintScheduler()._reconcile_persisted_moonraker_starts() == 1

    async with sessions() as db:
        assert (await db.get(PrintQueueItem, ids.item)).status == "failed"


@pytest.mark.asyncio
async def test_same_original_filename_external_job_cannot_bind_unique_queue_path(moonraker_queue):
    sessions, _base_dir, _source, ids = moonraker_queue
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.provider_correlation_id = "queue-job"
        item.provider_job_id = "queue/queued-opaque.gcode"
        await db.commit()

    with patch.object(scheduler_module, "async_session", sessions):
        assert not await PrintScheduler.bind_moonraker_observed(
            ids.printer,
            {
                "correlation_id": "external-correlation",
                "provider_job_id": "external-job",
                "filename": "cube.gcode",
            },
        )

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        assert item.provider_correlation_id == "queue-job"
        assert item.provider_job_id == "queue/queued-opaque.gcode"


@pytest.mark.asyncio
@pytest.mark.parametrize(("terminal_status", "expected_status"), [("completed", "completed"), ("failed", "cancelled")])
async def test_cancel_intent_preserves_definitive_completion(moonraker_queue, terminal_status, expected_status):
    sessions, _base_dir, _source, ids = moonraker_queue
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.provider_correlation_id = "queue-job"
        item.provider_job_id = "42"
        item.cancel_requested_at = datetime.now(timezone.utc)
        await db.commit()

    with patch.object(scheduler_module, "async_session", sessions):
        outcome = await PrintScheduler.finalize_moonraker_job(
            ids.printer,
            {
                "status": terminal_status,
                "correlation_id": "queue-job",
                "provider_job_id": "42",
                "filename": "queue/queued-opaque.gcode",
            },
        )

    assert outcome["status"] == expected_status
    async with sessions() as db:
        assert (await db.get(PrintQueueItem, ids.item)).status == expected_status


@pytest.mark.asyncio
async def test_pre_active_stop_intent_cancels_once_after_started_observation(moonraker_queue):
    sessions, _base_dir, _source, ids = moonraker_queue
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.provider_correlation_id = "queue-job"
        item.provider_job_id = "queue/cube.gcode"
        await db.commit()

    stop = AsyncMock(side_effect=[False, True])
    with (
        patch.object(scheduler_module, "async_session", sessions),
        patch.object(scheduler_module.printer_manager, "stop_print_async", stop),
    ):
        async with sessions() as db:
            assert await stop_queue_item(ids.item, db=db, auth_result=(None, True)) == {
                "message": "Print stop requested"
            }
        observed = {
            "correlation_id": "queue-job",
            "provider_job_id": "42",
            "filename": "queue/cube.gcode",
        }
        assert await PrintScheduler.bind_moonraker_observed(ids.printer, observed)
        assert await PrintScheduler.bind_moonraker_observed(ids.printer, observed)
        outcome = await PrintScheduler.finalize_moonraker_job(
            ids.printer, {**observed, "status": "failed", "reason": "cancelled"}
        )

    assert stop.await_count == 2
    assert outcome["status"] == "cancelled"
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        assert item.status == "cancelled"
        assert item.cancel_requested_at is not None
        assert item.cancel_dispatched_at is not None
        assert await db.scalar(select(func.count(PrintLogEntry.id))) == 1


@pytest.mark.asyncio
async def test_moonraker_rejects_3mf_before_provider_io(moonraker_queue):
    sessions, base_dir, _source, ids = moonraker_queue
    wrong = base_dir / "wrong.3mf"
    wrong.write_bytes(b"not gcode")
    async with sessions() as db:
        archive = await db.get(PrintArchive, ids.archive)
        archive.filename = wrong.name
        archive.file_path = wrong.name
        archive.extra_data = {"destination_artifact_kind": "bambu_3mf"}
        await db.commit()

    backend = _backend()
    with (
        patch.object(scheduler_module.settings, "base_dir", base_dir),
        patch.object(scheduler_module.printer_manager, "is_connected", return_value=True),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=backend),
    ):
        async with sessions() as db:
            await PrintScheduler()._start_print(db, await db.get(PrintQueueItem, ids.item))

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        archive = await db.get(PrintArchive, ids.archive)
        assert item.status == "failed"
        assert "not compatible" in item.error_message
        assert archive.status == "failed"
        assert await db.scalar(select(func.count(PrintLogEntry.id))) == 1
    backend.upload_gcode.assert_not_awaited()
    backend.start_print.assert_not_awaited()


@pytest.mark.asyncio
async def test_printer_manager_forwards_one_correlated_moonraker_terminal():
    manager = PrinterManager()
    backend = _backend()
    manager._backends[7] = backend
    callback = AsyncMock()
    manager.set_print_complete_callback(callback)
    occurred_at = datetime.now(timezone.utc)
    event = JobLifecycle(
        "cancelled",
        "moonraker:42",
        "42",
        "cube.gcode",
        occurred_at,
        "cancelled by user",
        {"provider_job_id": "42"},
    )

    await manager._forward_backend_event(7, event)
    await manager._forward_backend_event(7, event)

    callback.assert_awaited_once_with(
        7,
        {
            "provider_job_id": "42",
            "status": "cancelled",
            "filename": "cube.gcode",
            "reason": "cancelled by user",
            "occurred_at": occurred_at,
            "correlation_id": "moonraker:42",
        },
    )


@pytest.mark.asyncio
async def test_moonraker_stop_awaits_cancel_and_leaves_finalization_to_lifecycle():
    item = SimpleNamespace(
        id=9,
        printer_id=7,
        created_by_id=None,
        status="printing",
        auto_off_after=False,
        completed_at=None,
        error_message=None,
        cancel_requested_at=None,
        cancel_dispatched_at=None,
    )
    result = MagicMock()
    result.scalar_one_or_none.return_value = item
    db = AsyncMock()
    db.execute.return_value = result
    db.get.return_value = SimpleNamespace(id=7, provider="moonraker")

    with patch.object(PrintScheduler, "dispatch_moonraker_cancel_intent", AsyncMock(return_value=True)) as stop:
        response = await stop_queue_item(9, db=db, auth_result=(None, True))

    assert response == {"message": "Print stop requested"}
    stop.assert_awaited_once_with(9, 7)
    assert item.cancel_requested_at is not None
    assert item.status == "printing"
    db.commit.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "expected_print_count"),
    [("completed", 1), ("failed", 0), ("cancelled", 0)],
)
async def test_moonraker_terminal_runs_shared_main_effects(moonraker_queue, status, expected_print_count):
    sessions, _base_dir, source, ids = moonraker_queue
    async with sessions() as db:
        library_file = LibraryFile(
            filename="cube.gcode",
            file_path=str(source),
            file_type="gcode",
            file_size=source.stat().st_size,
            print_count=0,
        )
        db.add(library_file)
        await db.flush()
        item = await db.get(PrintQueueItem, ids.item)
        item.library_file_id = library_file.id
        item.status = status
        item.auto_off_after = True
        await db.commit()
        library_id = library_file.id

    outcome = {
        "queue_item_id": ids.item,
        "archive_id": ids.archive,
        "library_file_id": library_id,
        "created_by_id": 17,
        "auto_off_after": True,
        "status": status,
        "printer_name": "Klipper",
        "filename": "queue/cube.gcode",
    }
    with (
        patch.object(main_module.print_scheduler, "finalize_moonraker_job", AsyncMock(return_value=outcome)),
        patch.object(main_module, "async_session", sessions),
        patch.object(main_module.ws_manager, "send_print_complete", AsyncMock()) as ws_complete,
        patch.object(main_module.ws_manager, "send_archive_updated", AsyncMock()) as ws_archive,
        patch.object(main_module.printer_manager, "clear_current_print_user") as clear_user,
        patch.object(main_module.printer_manager, "set_awaiting_plate_clear") as set_plate_clear,
        patch.object(
            main_module.printer_manager,
            "get_printer",
            return_value=SimpleNamespace(name="Klipper", serial_number="moon-1"),
        ),
        patch.object(main_module.mqtt_relay, "on_print_complete", AsyncMock()) as relay_complete,
        patch.object(main_module.mqtt_relay, "on_queue_job_completed", AsyncMock()) as relay_queue,
        patch.object(main_module.mqtt_relay, "on_archive_updated", AsyncMock()) as relay_archive,
        patch.object(main_module.notification_service, "on_print_complete", AsyncMock()) as notify_print,
        patch.object(main_module, "_dispatch_user_print_email", AsyncMock()) as notify_user,
        patch.object(main_module.notification_service, "on_queue_completed", AsyncMock()) as notify_queue,
        patch.object(main_module.smart_plug_manager, "schedule_off_after_queue_job", AsyncMock()) as auto_off,
    ):
        await main_module._on_moonraker_print_complete(ids.printer, {"status": status})

    ws_complete.assert_awaited_once()
    ws_archive.assert_awaited_once_with({"id": ids.archive, "status": status})
    clear_user.assert_called_once_with(ids.printer)
    set_plate_clear.assert_called_once_with(ids.printer, True)
    relay_complete.assert_awaited_once()
    relay_queue.assert_awaited_once()
    relay_archive.assert_awaited_once()
    notify_print.assert_awaited_once()
    assert notify_user.await_args.args[:4] == (status, 17, "Klipper", "queue/cube.gcode")
    notify_queue.assert_awaited_once()
    assert notify_queue.await_args.kwargs["completed_count"] == 1
    auto_off.assert_awaited_once()
    async with sessions() as db:
        library_file = await db.get(LibraryFile, library_id)
        assert library_file.print_count == expected_print_count
        assert (library_file.last_printed_at is not None) is (status == "completed")


@pytest.mark.asyncio
async def test_provider_identity_migration_is_additive_and_idempotent(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy.db'}")
    async with engine.begin() as conn:
        await conn.exec_driver_sql("CREATE TABLE print_queue (id INTEGER PRIMARY KEY, status VARCHAR(20))")
        await _migrate_print_queue_provider_identity(conn)
        await _migrate_print_queue_provider_identity(conn)
        columns = {row[1] for row in (await conn.exec_driver_sql("PRAGMA table_info(print_queue)")).all()}
        indexes = {row[1] for row in (await conn.exec_driver_sql("PRAGMA index_list(print_queue)")).all()}
    await engine.dispose()

    assert {
        "provider_correlation_id",
        "provider_job_id",
        "start_reconcile_after",
        "cancel_requested_at",
        "cancel_dispatched_at",
    } <= columns
    assert "ix_print_queue_provider_correlation_id" in indexes
