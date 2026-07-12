from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
import backend.app.services.print_scheduler as scheduler_module
from backend.app.api.routes.print_queue import stop_queue_item
from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_backend import JobLifecycle
from backend.app.services.printer_manager import PrinterManager
from backend.app.services.printer_types import PrinterCapabilities, PrinterProvider


@pytest.fixture
async def moonraker_queue(tmp_path):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
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
        assert archive.status == "printing"
    handle = backend.upload_gcode.await_args.args[0]
    assert handle.closed
    assert backend.upload_gcode.await_args.kwargs == {
        "filename": "cube.gcode",
        "start": False,
        "size": source.stat().st_size,
    }
    backend.start_print.assert_awaited_once_with("queue/cube.gcode")


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
        assert (await db.get(PrintQueueItem, ids.item)).status == "cancelled"
    backend.start_print.assert_not_awaited()


@pytest.mark.asyncio
async def test_moonraker_upload_failure_records_one_queue_archive_log_outcome(moonraker_queue):
    sessions, base_dir, _source, ids = moonraker_queue
    backend = _backend(upload=AsyncMock(side_effect=RuntimeError("secret transport detail")))
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
        logs = list((await db.scalars(select(PrintLogEntry))).all())
        assert item.status == "failed"
        assert item.error_message == "Failed to upload G-code to Moonraker"
        assert archive.status == "failed"
        assert len(logs) == 1
        assert logs[0].failure_reason == "Failed to upload G-code to Moonraker"
    backend.start_print.assert_not_awaited()


@pytest.mark.asyncio
async def test_moonraker_terminal_is_idempotent_and_preserves_archive_metadata(moonraker_queue):
    sessions, _base_dir, _source, ids = moonraker_queue
    started = datetime.now(timezone.utc)
    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        item.status = "printing"
        item.started_at = started
        await db.commit()

    event = {"status": "completed", "filename": "queue/cube.gcode", "occurred_at": started}
    with patch.object(scheduler_module, "async_session", sessions):
        assert await PrintScheduler.finalize_moonraker_job(ids.printer, event)
        assert not await PrintScheduler.finalize_moonraker_job(ids.printer, event)

    async with sessions() as db:
        item = await db.get(PrintQueueItem, ids.item)
        archive = await db.get(PrintArchive, ids.archive)
        log_count = await db.scalar(select(func.count(PrintLogEntry.id)))
        assert item.status == "completed"
        assert archive.status == "completed"
        assert archive.extra_data == {"destination_artifact_kind": "klipper_gcode", "source": "library"}
        assert log_count == 1


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
        assert item.status == "failed"
        assert "not compatible" in item.error_message
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
    )
    result = MagicMock()
    result.scalar_one_or_none.return_value = item
    db = AsyncMock()
    db.execute.return_value = result
    db.get.return_value = SimpleNamespace(id=7, provider="moonraker")

    with patch(
        "backend.app.services.printer_manager.printer_manager.stop_print_async",
        AsyncMock(return_value=True),
    ) as stop:
        response = await stop_queue_item(9, db=db, auth_result=(None, True))

    assert response == {"message": "Print stop requested"}
    stop.assert_awaited_once_with(7)
    assert item.status == "printing"
    db.commit.assert_not_awaited()
