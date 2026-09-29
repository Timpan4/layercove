import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.core.websocket import ws_manager
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services import dispatch_progress
from backend.app.services.print_scheduler import PrintScheduler


async def test_queue_read_recovers_live_progress_and_durable_start_phase(async_client, db_session):
    printer = Printer(name="Printer", provider="moonraker")
    db_session.add(printer)
    await db_session.flush()
    item = PrintQueueItem(printer_id=printer.id, status="pending")
    db_session.add(item)
    await db_session.commit()
    await ws_manager.send_queue_item_dispatch_stage(None, item.id, printer.id, printer.name, "cube.gcode", "preparing")
    await ws_manager.send_queue_item_uploading(None, item.id, printer.id, printer.name, "cube.gcode", 100)
    await ws_manager.send_queue_item_upload_progress(None, item.id, 50, 100)
    response = await async_client.get(f"/api/v1/queue/{item.id}")
    assert response.status_code == 200, response.text
    assert response.json()["dispatch_progress"]["stage"] == "uploading"
    assert response.json()["dispatch_progress"]["bytes_transferred"] == 50
    # Cache reset models a process restart. An ambiguous start remains visible from SQL.
    dispatch_progress.clear(item.id)
    item.status = "printing"
    item.started_at = datetime.now(timezone.utc)
    item.start_reconcile_after = item.started_at + timedelta(minutes=2)
    await db_session.commit()
    recovered = (await async_client.get(f"/api/v1/queue/{item.id}")).json()
    assert recovered["dispatch_progress"]["stage"] == "awaiting_printer"
    item.status = "failed"
    item.error_message = "Printer did not confirm start"
    await db_session.commit()
    await ws_manager.send_queue_item_failed(None, item.id, printer.id, item.error_message)
    await ws_manager.send_queue_item_upload_progress(None, item.id, 100, 100)
    failed = (await async_client.get(f"/api/v1/queue/{item.id}")).json()
    assert failed["dispatch_progress"] is None
    assert failed["error_message"] == "Printer did not confirm start"


async def test_dispatch_cache_does_not_regress_from_confirmation_to_bytes():
    item_id = 7654321
    try:
        await ws_manager.send_queue_item_uploading(None, item_id, 1, "Printer", "job.gcode", 100)
        await ws_manager.send_queue_item_dispatch_stage(None, item_id, 1, "Printer", "job.gcode", "awaiting_printer")
        await ws_manager.send_queue_item_upload_progress(None, item_id, 10, 100)
        assert dispatch_progress.snapshot(item_id)["stage"] == "awaiting_printer"
        await ws_manager.send_queue_item_acked(None, item_id, 1)
        await ws_manager.send_queue_item_upload_progress(None, item_id, 100, 100)
        assert dispatch_progress.snapshot(item_id) is None
    finally:
        dispatch_progress.clear(item_id)


async def test_scheduler_wakeup_during_a_pass_is_not_lost(monkeypatch):
    scheduler = PrintScheduler()
    scheduler._check_interval = 3600
    entered = asyncio.Event()
    release = asyncio.Event()
    checked_again = asyncio.Event()
    calls = 0

    async def check():
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            await release.wait()
        else:
            checked_again.set()
            scheduler.stop()

    # Test the real run/wait loop. Dispatch/persistence is covered by the integration test.
    monkeypatch.setattr(scheduler, "check_queue", check)
    task = asyncio.create_task(scheduler.run())
    try:
        await asyncio.wait_for(entered.wait(), 1)
        scheduler.notify_queue_changed()
        release.set()
        await asyncio.wait_for(checked_again.wait(), 1)
        await asyncio.wait_for(task, 1)
    finally:
        scheduler.stop()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert calls == 2
