"""Exercise the production queue, provider gates and acknowledgement handling."""

import asyncio
import json
import time
import zipfile
from contextlib import ExitStack
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import paho.mqtt.client as mqtt
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
import backend.app.services.print_scheduler as scheduler_module
from backend.app.core.database import Base
from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.slice_job import SliceJobRecord  # noqa: F401
from backend.app.services.bambu_backend import BambuBackend
from backend.app.services.bambu_mqtt import BambuMQTTClient
from backend.app.services.moonraker_backend import MoonrakerBackend
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_manager import PrinterManager
from backend.app.services.printer_types import NormalizedPrinterState, PrinterProvider, PrinterSnapshot


@pytest.fixture
async def pipeline(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'pipeline.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as db:
        bambu = Printer(
            name="Bambu",
            provider="bambu",
            model="P1S",
            serial_number="TEST",
            ip_address="printer.test",
            access_code="test",
        )
        klipper = Printer(name="Klipper", provider="moonraker", model="CoreXY")
        db.add_all([bambu, klipper])
        await db.flush()
        item_ids = []
        for printer, extension, kind in [(bambu, "3mf", "bambu_3mf"), (klipper, "gcode", "klipper_gcode")]:
            name = f"cube.{extension}"
            if kind == "bambu_3mf":
                with zipfile.ZipFile(tmp_path / name, "w") as bundle:
                    bundle.writestr("Metadata/plate_1.gcode", "G28\n")
            else:
                (tmp_path / name).write_bytes(b"G28\n")
            archive = PrintArchive(
                printer_id=printer.id,
                filename=name,
                file_path=name,
                file_size=(tmp_path / name).stat().st_size,
                status="archived",
                extra_data={"destination_artifact_kind": kind},
            )
            db.add(archive)
            await db.flush()
            item = PrintQueueItem(
                printer_id=printer.id, archive_id=archive.id, status="pending", use_ams=False, skip_filament_check=True
            )
            db.add(item)
            await db.flush()
            item_ids.append(item.id)
        await db.commit()

    # Real provider implementations. Only the network boundaries are replaced.
    bambu_backend = BambuBackend(bambu, emit=lambda _event: None)
    bambu_backend.client._client = MagicMock()
    publish_info = mqtt.MQTTMessageInfo(1)
    publish_info.rc = mqtt.MQTT_ERR_SUCCESS
    bambu_backend.client._client.publish.return_value = publish_info
    bambu_backend.client.state.connected = True
    bambu_backend.client.state.state = "IDLE"
    bambu_backend.client._last_message_time = time.time()
    http = SimpleNamespace(upload_gcode=AsyncMock(return_value="queue/cube.gcode"), start_print=AsyncMock())
    config = SimpleNamespace(
        base_url="http://printer.test", websocket_url_override=None, api_key=None, authorization=None, tls_verify=True
    )
    klipper_backend = MoonrakerBackend(
        SimpleNamespace(moonraker_config=config),
        emit=lambda _event: None,
        transport_factory=lambda **_: MagicMock(),
        http_client_factory=lambda **_: http,
    )
    klipper_backend._snapshot = PrinterSnapshot(PrinterProvider.MOONRAKER, True, NormalizedPrinterState.IDLE)
    manager = PrinterManager()
    manager._backends = {bambu.id: bambu_backend, klipper.id: klipper_backend}
    manager._clients = {bambu.id: bambu_backend.client}
    monkeypatch.setattr(scheduler_module, "printer_manager", manager)
    monkeypatch.setattr(scheduler_module, "async_session", sessions)
    monkeypatch.setattr(scheduler_module.settings, "base_dir", tmp_path)
    monkeypatch.setattr(manager, "set_awaiting_plate_clear", MagicMock())
    monkeypatch.setattr(scheduler_module, "delete_file_async", AsyncMock(return_value=True))
    monkeypatch.setattr(scheduler_module, "upload_file_async", AsyncMock(return_value=True))
    monkeypatch.setattr(scheduler_module, "get_ftp_retry_settings", AsyncMock(return_value=(False, 0, 0, 1.0)))
    monkeypatch.setattr(scheduler_module, "cache_3mf_download", MagicMock())
    tasks = []

    def spawn(coroutine, **_kwargs):
        task = asyncio.create_task(coroutine)
        tasks.append(task)
        return task

    monkeypatch.setattr(scheduler_module, "spawn_background_task", spawn)
    with ExitStack() as stack:
        for name in ("on_queue_job_started", "on_queue_job_failed"):
            stack.enter_context(patch.object(scheduler_module.notification_service, name, AsyncMock()))
        scheduler = PrintScheduler()
        monkeypatch.setattr(scheduler_module, "scheduler", scheduler)
        try:
            yield SimpleNamespace(
                sessions=sessions,
                scheduler=scheduler,
                manager=manager,
                bambu=bambu_backend,
                klipper=klipper_backend,
                http=http,
                item_ids=item_ids,
            )
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state", [NormalizedPrinterState.IDLE, NormalizedPrinterState.COMPLETED, NormalizedPrinterState.CANCELLED]
)
async def test_queue_reaches_both_real_provider_dispatchers(pipeline, state):
    pipeline.klipper._snapshot = replace(pipeline.klipper.snapshot(), state=state)
    await pipeline.scheduler.check_queue()
    async with pipeline.sessions() as db:
        for item_id in pipeline.item_ids:
            assert (await db.get(PrintQueueItem, item_id)).status == "printing"
    pipeline.http.upload_gcode.assert_awaited_once()
    pipeline.http.start_print.assert_awaited_once_with("queue/cube.gcode")
    payload = json.loads(pipeline.bambu.client._client.publish.call_args.args[1])
    assert payload["print"]["command"] == "project_file"
    assert payload["print"]["url"] == "ftp://cube.3mf"


@pytest.mark.asyncio
async def test_one_dispatch_exception_does_not_starve_the_other_provider(pipeline, monkeypatch):
    monkeypatch.setattr(
        scheduler_module, "get_ftp_retry_settings", AsyncMock(side_effect=ValueError("secret-internal-detail"))
    )
    await pipeline.scheduler.check_queue()
    async with pipeline.sessions() as db:
        failed = await db.get(PrintQueueItem, pipeline.item_ids[0])
        assert failed.status == "failed"
        assert str(failed.id) in failed.error_message
        assert "secret-internal-detail" not in failed.error_message
        assert failed.completed_at is not None
        assert (await db.get(PrintQueueItem, pipeline.item_ids[1])).status == "printing"
    pipeline.http.start_print.assert_awaited_once()


@pytest.mark.asyncio
async def test_stale_klipper_state_cannot_start_a_job(pipeline):
    pipeline.klipper._snapshot = replace(pipeline.klipper.snapshot(), telemetry_stale=True)
    await pipeline.scheduler.check_queue()
    pipeline.http.start_print.assert_not_awaited()
    pipeline.http.upload_gcode.assert_not_awaited()


def test_bambu_rejects_a_failed_local_mqtt_publish():
    client = BambuMQTTClient("printer.test", "TEST", "test", model="P1S")
    client.state.connected = True
    client._client = MagicMock()
    result = mqtt.MQTTMessageInfo(1)
    result.rc = mqtt.MQTT_ERR_NO_CONN
    client._client.publish.return_value = result
    assert client.start_print("cube.3mf") is False


@pytest.mark.asyncio
async def test_unacknowledged_bambu_job_fails_instead_of_auto_retrying(pipeline):
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[0])
        item.status = "printing"
        item.started_at = datetime.now(timezone.utc) - timedelta(minutes=10)
        await db.commit()
    with patch("backend.app.core.database.async_session", pipeline.sessions):
        await pipeline.scheduler._watchdog_print_start(pipeline.item_ids[0], 1, "IDLE", timeout=0, phase_b_timeout=0)
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[0])
        assert item.status == "failed"
        assert "confirm" in item.error_message.lower()
        assert item.completed_at is not None


@pytest.mark.asyncio
async def test_local_publish_is_not_reported_as_printer_acceptance(pipeline):
    await pipeline.scheduler.check_queue()
    # Only Moonraker has actually acknowledged the start RPC so far.
    notices = scheduler_module.notification_service.on_queue_job_started
    assert [call.kwargs["printer_id"] for call in notices.await_args_list] == [2]
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[0])
        assert item.start_reconcile_after is not None
        assert item.provider_correlation_id == pipeline.bambu.client.last_dispatch_subtask_id


@pytest.mark.asyncio
async def test_restarted_scheduler_recovers_bambu_acceptance_without_resending(pipeline):
    await pipeline.scheduler.check_queue()
    pipeline.bambu.client.state.state = "RUNNING"
    pipeline.bambu.client.state.subtask_id = pipeline.bambu.client.last_dispatch_subtask_id
    restarted = PrintScheduler()
    await restarted.check_queue()
    await restarted.check_queue()
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[0])
        assert item.status == "printing"
        assert item.start_reconcile_after is None
    assert pipeline.bambu.client._client.publish.call_count == 1
    notices = scheduler_module.notification_service.on_queue_job_started
    assert [call.kwargs["printer_id"] for call in notices.await_args_list].count(1) == 1


@pytest.mark.asyncio
async def test_restart_expires_uncertain_starts_even_when_both_printers_are_offline(pipeline):
    await pipeline.scheduler.check_queue()
    async with pipeline.sessions() as db:
        for item_id in pipeline.item_ids:
            item = await db.get(PrintQueueItem, item_id)
            item.started_at = datetime.now(timezone.utc) - timedelta(minutes=10)
            item.start_reconcile_after = datetime.now(timezone.utc) - timedelta(minutes=5)
        await db.commit()
    pipeline.bambu.client.state.connected = False
    pipeline.klipper._snapshot = replace(pipeline.klipper.snapshot(), connected=False)
    await PrintScheduler().check_queue()
    async with pipeline.sessions() as db:
        for item_id in pipeline.item_ids:
            item = await db.get(PrintQueueItem, item_id)
            assert item.status == "failed"
            assert "confirm" in item.error_message.lower()
            assert item.completed_at is not None
    pipeline.http.start_print.assert_awaited_once()
    assert pipeline.bambu.client._client.publish.call_count == 1


@pytest.mark.asyncio
async def test_another_active_bambu_job_does_not_acknowledge_this_submission(pipeline):
    await pipeline.scheduler.check_queue()
    pipeline.bambu.client.state.state = "RUNNING"
    pipeline.bambu.client.state.subtask_id = "unrelated-submission"
    await PrintScheduler().check_queue()
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[0])
        assert item.start_reconcile_after is not None
    notices = scheduler_module.notification_service.on_queue_job_started
    assert [call.kwargs["printer_id"] for call in notices.await_args_list] == [2]


@pytest.mark.asyncio
async def test_concurrent_queue_passes_do_not_double_transfer_or_start(pipeline):
    await asyncio.gather(pipeline.scheduler.check_queue(), pipeline.scheduler.check_queue())
    pipeline.http.upload_gcode.assert_awaited_once()
    pipeline.http.start_print.assert_awaited_once()
    scheduler_module.upload_file_async.assert_awaited_once()
    assert pipeline.bambu.client._client.publish.call_count == 1


@pytest.mark.asyncio
async def test_cancelled_slice_does_not_execute_after_losing_the_claim(pipeline, monkeypatch):
    from backend.app.core import database
    from backend.app.services.slice_dispatch import SliceDispatchService

    monkeypatch.setattr(database, "async_session", pipeline.sessions)
    async with pipeline.sessions() as db:
        job = SliceJobRecord(
            source_kind="library_file",
            source_id=1,
            source_name="cube.stl",
            status="cancelled",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.commit()
    runner = AsyncMock(return_value={"library_file_id": 1})
    service = SliceDispatchService()
    await service._run_job(job.id, runner)
    runner.assert_not_awaited()
    assert (await service.get(job.id)).status == "cancelled"


@pytest.mark.asyncio
async def test_slice_claim_database_error_is_terminal_and_removes_task(pipeline, monkeypatch):
    from sqlalchemy import event

    from backend.app.core import database
    from backend.app.services.slice_dispatch import SliceDispatchService

    monkeypatch.setattr(database, "async_session", pipeline.sessions)
    async with pipeline.sessions() as db:
        job = SliceJobRecord(
            source_kind="library_file",
            source_id=1,
            source_name="cube.stl",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.commit()
    engine = pipeline.sessions.kw["bind"].sync_engine

    def fail_claim(_connection, _cursor, statement, parameters, _context, _many):
        if statement.startswith("UPDATE slice_jobs") and "running" in parameters:
            raise ValueError("secret-database-detail")

    event.listen(engine, "before_cursor_execute", fail_claim)
    runner = AsyncMock(return_value={"library_file_id": 1})
    service = SliceDispatchService()
    service._tasks[job.id] = asyncio.create_task(service._run_job(job.id, runner))
    try:
        await service._tasks[job.id]
    finally:
        event.remove(engine, "before_cursor_execute", fail_claim)
    runner.assert_not_awaited()
    stored = await service.get(job.id)
    assert stored.status == "failed"
    assert "secret-database-detail" not in stored.error_detail
    assert str(job.id) in stored.error_detail
    assert job.id not in service._tasks


@pytest.mark.asyncio
async def test_bambu_qos_disconnect_keeps_the_uncertain_command_for_reconciliation(pipeline):
    # Real Paho queues QoS 1 even when publish returns MQTT_ERR_NO_CONN.
    # There is no socket or network loop, so no printer/network is contacted.
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    pipeline.bambu.client._client = client
    await pipeline.scheduler.check_queue()
    assert len(client._out_messages) == 1
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[0])
        assert item.status == "printing"
        assert item.start_reconcile_after is not None
        assert item.provider_correlation_id == pipeline.bambu.client.last_dispatch_subtask_id
    # The pre-upload replacement deletes once; do not delete the transferred file.
    assert scheduler_module.delete_file_async.await_count == 1
    notices = scheduler_module.notification_service.on_queue_job_started
    assert [call.kwargs["printer_id"] for call in notices.await_args_list] == [2]


@pytest.mark.asyncio
async def test_confirmed_bambu_claim_is_not_failed_as_legacy_work(pipeline):
    await pipeline.scheduler.check_queue()
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[0])
        item.start_reconcile_after = None
        item.started_at = datetime.now(timezone.utc) - timedelta(minutes=10)
        await db.commit()
    # The terminal lifecycle callback owns completion; recovery must not race
    # it by treating a confirmed modern claim as an abandoned legacy upload.
    pipeline.bambu.client.state.state = "FINISH"
    await pipeline.scheduler._reconcile_persisted_bambu_starts()
    async with pipeline.sessions() as db:
        assert (await db.get(PrintQueueItem, pipeline.item_ids[0])).status == "printing"


@pytest.mark.asyncio
async def test_confirmation_wins_over_an_expired_bambu_watchdog(pipeline):
    await pipeline.scheduler.check_queue()
    subtask = pipeline.bambu.client.last_dispatch_subtask_id
    pipeline.bambu.client.state.state = "RUNNING"
    pipeline.bambu.client.state.subtask_id = subtask
    await pipeline.scheduler._watchdog_print_start(
        pipeline.item_ids[0], 1, "IDLE", timeout=0.1, poll_interval=0.01, expected_subtask_id=subtask
    )
    pipeline.bambu.client.state.state = "IDLE"
    await pipeline.scheduler._watchdog_print_start(
        pipeline.item_ids[0], 1, "IDLE", timeout=0, expected_subtask_id=subtask
    )
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[0])
        assert item.status == "printing"
        assert item.start_reconcile_after is None


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["RUNNING", "IDLE"])
async def test_stale_bambu_watchdog_cannot_change_a_new_dispatch_attempt(pipeline, state):
    await pipeline.scheduler.check_queue()
    pipeline.bambu.client.state.state = state
    pipeline.bambu.client.state.subtask_id = "previous-attempt"
    await pipeline.scheduler._watchdog_print_start(
        pipeline.item_ids[0], 1, "IDLE", timeout=0.1, poll_interval=0.01, expected_subtask_id="previous-attempt"
    )
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[0])
        assert item.status == "printing"
        assert item.start_reconcile_after is not None
        assert item.provider_correlation_id == pipeline.bambu.client.last_dispatch_subtask_id


@pytest.mark.parametrize("flavor", ["marlin", None])
async def test_unverified_3mf_fails_before_moonraker_io_but_other_printer_dispatches(pipeline, tmp_path, flavor):
    path = tmp_path / "legacy.gcode.3mf"
    with zipfile.ZipFile(path, "w") as bundle:
        bundle.writestr("Metadata/plate_1.gcode", "G28\n")
        if flavor:
            bundle.writestr("Metadata/project_settings.config", json.dumps({"gcode_flavor": flavor}))
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[1])
        archive = await db.get(PrintArchive, item.archive_id)
        archive.file_path = path.name
        archive.filename = path.name
        archive.extra_data = None  # Legacy archives did not record the output contract.
        await db.commit()
    await pipeline.scheduler.check_queue()
    async with pipeline.sessions() as db:
        item = await db.get(PrintQueueItem, pipeline.item_ids[1])
        assert item.status == "failed"
        assert item.completed_at is not None
        assert "Re-slice" in item.error_message
        assert str(item.id) in item.error_message
        assert (await db.get(PrintQueueItem, pipeline.item_ids[0])).status == "printing"
    pipeline.http.upload_gcode.assert_not_awaited()
    pipeline.http.start_print.assert_not_awaited()
    await pipeline.scheduler.check_queue()
    pipeline.http.upload_gcode.assert_not_awaited()


async def test_moonraker_dispatch_is_visible_before_start_acknowledgement(pipeline, monkeypatch):
    messages = []
    entered_start = asyncio.Event()
    release_start = asyncio.Event()

    async def broadcast(_user_id, message):
        messages.append(message)

    async def start(_path):
        entered_start.set()
        await release_start.wait()

    monkeypatch.setattr(scheduler_module.ws_manager, "broadcast_to_user", broadcast)
    pipeline.http.start_print.side_effect = start
    task = asyncio.create_task(pipeline.scheduler.check_queue())
    try:
        await asyncio.wait_for(entered_start.wait(), 2)
        events = [message for message in messages if message.get("queue_item_id") == pipeline.item_ids[1]]
        assert any(event["type"] == "queue_item_uploading" for event in events)
        assert any(event.get("stage") == "awaiting_printer" for event in events)
        assert not any(event["type"] == "queue_item_acked" for event in events)
        release_start.set()
        await asyncio.wait_for(task, 2)
        assert any(
            message["type"] == "queue_item_acked" and message.get("queue_item_id") == pipeline.item_ids[1]
            for message in messages
        )
    finally:
        release_start.set()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
