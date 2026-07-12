import asyncio
import io
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

import backend.app.services.print_scheduler as scheduler_module
from backend.app.models.archive import PrintArchive
from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.services.moonraker_backend import MoonrakerBackend
from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError
from backend.app.services.moonraker_websocket import MoonrakerWebSocketTransport
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_backend import JobLifecycle
from backend.app.services.printer_backend_registry import PrinterBackendRegistry
from backend.app.services.printer_manager import PrinterManager
from backend.app.services.printer_types import NormalizedPrinterState, PrinterProvider
from backend.tests._fixtures.moonraker import FakeMoonraker


def _printer(fake: FakeMoonraker, *, api_key: str | None = None):
    return SimpleNamespace(
        moonraker_config=SimpleNamespace(
            base_url=fake.base_url,
            websocket_url_override=None,
            api_key=api_key,
            authorization=None,
            tls_verify=True,
        )
    )


def _allow_test_peer(monkeypatch):
    from backend.app.services import moonraker_http, moonraker_websocket

    monkeypatch.setattr(moonraker_http, "_is_safe_peer", lambda _: True)
    monkeypatch.setattr(moonraker_websocket, "_is_safe_peer", lambda _: True)


def _http_client(fake: FakeMoonraker, **options) -> MoonrakerHTTPClient:
    return MoonrakerHTTPClient(base_url=fake.base_url, resolver=fake.resolver, **options)


def _backend(fake: FakeMoonraker, monkeypatch, events, *, sleep=asyncio.sleep) -> MoonrakerBackend:
    _allow_test_peer(monkeypatch)
    emit = events if callable(events) else events.append

    def transport_factory(**options):
        return MoonrakerWebSocketTransport(**options, resolver=fake.resolver, heartbeat=60)

    def http_client_factory(**options):
        return MoonrakerHTTPClient(**options, resolver=fake.resolver)

    return MoonrakerBackend(
        _printer(fake),
        emit=emit,
        transport_factory=transport_factory,
        http_client_factory=http_client_factory,
        sleep=sleep,
        jitter=lambda: 0,
        bootstrap_timeout=0.2,
    )


async def _wait_for(predicate, *, timeout: float = 1.0):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_fake_moonraker_contract_uses_isolated_ports_and_cleans_up():
    first = await FakeMoonraker().start()
    second = await FakeMoonraker().start()
    try:
        assert first.port != second.port
        assert first.base_url != second.base_url
    finally:
        await first.close()
        await second.close()
    assert first.port is None
    assert second.port is None


@pytest.mark.asyncio
async def test_fake_websocket_methodless_request_uses_unsupported_method_error(fake_moonraker, monkeypatch):
    _allow_test_peer(monkeypatch)
    transport = MoonrakerWebSocketTransport(
        base_url=fake_moonraker.base_url,
        resolver=fake_moonraker.resolver,
        heartbeat=60,
    )
    connection = await transport.connect()
    try:
        await connection.send_json({"jsonrpc": "2.0", "id": 7})
        response = await connection.receive_json()
        assert response == {
            "jsonrpc": "2.0",
            "id": 7,
            "error": {"code": -32601, "message": "unsupported method None"},
        }
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_real_http_client_covers_upload_and_mvp_commands(fake_moonraker, monkeypatch):
    _allow_test_peer(monkeypatch)
    client = _http_client(fake_moonraker)

    assert await client.test_connection() is True
    path = await client.upload_gcode(io.BytesIO(b"G28\n"), filename="cube.gcode", size=4)
    await client.start_print(path)
    await client.pause_print()
    await client.resume_print()
    await client.cancel_print()
    await client.emergency_stop()

    assert fake_moonraker.uploads == [("cube.gcode", b"G28\n")]
    assert fake_moonraker.commands == [
        ("start", "queue/cube.gcode"),
        ("pause", None),
        ("resume", None),
        ("cancel", None),
        ("emergency_stop", None),
    ]


@pytest.mark.asyncio
async def test_fake_auth_and_malformed_http_errors_are_safe(fake_moonraker, monkeypatch):
    _allow_test_peer(monkeypatch)
    fake_moonraker.require_api_key("stored-secret")

    with pytest.raises(MoonrakerHTTPError) as auth_error:
        await _http_client(fake_moonraker, api_key="wrong-secret").get_server_info()
    assert auth_error.value.code == "authentication_failed"
    assert "stored-secret" not in str(auth_error.value)
    assert "wrong-secret" not in str(auth_error.value)

    fake_moonraker.malformed_server_info = True
    response = await _http_client(fake_moonraker, api_key="stored-secret").get_server_info()
    assert response.body == b"{not-json"


@pytest.mark.asyncio
async def test_real_backend_bootstrap_commands_and_terminal_lifecycle(fake_moonraker, monkeypatch):
    events = []
    backend = _backend(fake_moonraker, monkeypatch, events)
    await backend.connect()
    try:
        await _wait_for(lambda: backend.snapshot().state is NormalizedPrinterState.IDLE)
        await fake_moonraker.wait_for_subscribers()
        await fake_moonraker.set_status(
            {
                "print_stats": {
                    "state": "printing",
                    "filename": "queue/cube.gcode",
                    "job_id": "42",
                    "print_duration": 12.8,
                    "info": {"current_layer": 3, "total_layer": 20},
                },
                "virtual_sdcard": {"progress": 0.25},
                "extruder": {"temperature": 215.0},
                "heater_bed": {"temperature": 60.0},
            }
        )
        await _wait_for(lambda: backend.snapshot().state is NormalizedPrinterState.PRINTING)
        snapshot = backend.snapshot()
        assert snapshot.filename == "queue/cube.gcode"
        assert snapshot.progress == 25.0
        assert snapshot.current_layer == 3
        assert snapshot.total_layers == 20
        assert snapshot.temperatures == {"nozzle": 215.0, "bed": 60.0}

        await fake_moonraker.finish_job(status="completed", filename="queue/cube.gcode", job_id="42")
        await _wait_for(lambda: any(isinstance(event, JobLifecycle) and event.kind == "completed" for event in events))
        lifecycle = [event for event in events if isinstance(event, JobLifecycle)]
        assert [event.kind for event in lifecycle] == ["started", "completed"]
        assert lifecycle[0].correlation_id == lifecycle[1].correlation_id
        assert lifecycle[1].provider_job_id == "42"
    finally:
        await backend.disconnect()


@pytest.mark.asyncio
async def test_real_backend_reconnects_without_real_sleep(fake_moonraker, monkeypatch):
    delays = []

    async def no_sleep(delay):
        delays.append(delay)
        await asyncio.sleep(0)

    events = []
    backend = _backend(fake_moonraker, monkeypatch, events, sleep=no_sleep)
    await backend.connect()
    try:
        await _wait_for(lambda: backend.snapshot().connected)
        await fake_moonraker.disconnect_websockets()
        await _wait_for(lambda: delays == [1])
        await _wait_for(lambda: backend.snapshot().connected)
        assert fake_moonraker.requests.count(("GET", "/websocket")) >= 2
    finally:
        await backend.disconnect()


@pytest.mark.asyncio
async def test_printer_manager_forwards_fake_backed_lifecycle_once(fake_moonraker, monkeypatch):
    _allow_test_peer(monkeypatch)
    registry = PrinterBackendRegistry()

    def factory(printer, *, emit):
        return _backend(fake_moonraker, monkeypatch, emit)

    registry.register(PrinterProvider.MOONRAKER, factory)
    manager = PrinterManager(registry)
    started = []
    completed = []
    manager.set_print_start_callback(lambda printer_id, data: started.append((printer_id, data)))
    manager.set_print_complete_callback(lambda printer_id, data: completed.append((printer_id, data)))
    printer = SimpleNamespace(
        id=7,
        name="Voron",
        serial_number=None,
        model="Voron 2.4",
        provider=PrinterProvider.MOONRAKER,
        moonraker_config=_printer(fake_moonraker).moonraker_config,
    )

    assert await manager.connect_printer(printer) is True
    try:
        await fake_moonraker.wait_for_subscribers()
        await fake_moonraker.set_status(
            {"print_stats": {"state": "printing", "filename": "queue/cube.gcode", "job_id": "42"}}
        )
        await _wait_for(lambda: len(started) == 1)
        await fake_moonraker.finish_job(status="completed", filename="queue/cube.gcode", job_id="42")
        await _wait_for(lambda: len(completed) == 1)

        assert manager.is_connected(7) is True
        assert manager.get_snapshot(7).state is NormalizedPrinterState.COMPLETED
        assert started[0][0] == completed[0][0] == 7
        assert started[0][1]["correlation_id"] == completed[0][1]["correlation_id"]
        assert completed[0][1]["status"] == "completed"
        assert completed[0][1]["provider_job_id"] == "42"
    finally:
        await manager.disconnect_printer_async(7)


@pytest.mark.asyncio
async def test_queue_lifecycle_runs_through_fake_backed_backend(
    fake_moonraker, monkeypatch, test_engine, db_session, tmp_path
):
    _allow_test_peer(monkeypatch)
    source = tmp_path / "cube.gcode"
    source.write_bytes(b"G28\n")
    config = MoonrakerPrinterConfig(base_url=fake_moonraker.base_url)
    printer = Printer(
        name="Voron",
        provider=PrinterProvider.MOONRAKER,
        model="Voron 2.4",
        moonraker_config=config,
    )
    db_session.add(printer)
    await db_session.flush()
    archive = PrintArchive(
        printer_id=printer.id,
        filename=source.name,
        file_path=source.name,
        file_size=source.stat().st_size,
        status="archived",
        print_name="Cube",
        extra_data={"destination_artifact_kind": "klipper_gcode", "source": "library"},
    )
    db_session.add(archive)
    await db_session.flush()
    item = PrintQueueItem(printer_id=printer.id, archive_id=archive.id, status="pending")
    db_session.add(item)
    await db_session.commit()
    ids = SimpleNamespace(printer=printer.id, archive=archive.id, item=item.id)

    registry = PrinterBackendRegistry()
    registry.register(
        PrinterProvider.MOONRAKER,
        lambda _printer, *, emit: _backend(fake_moonraker, monkeypatch, emit),
    )
    manager = PrinterManager(registry)
    sessions = async_sessionmaker(test_engine, expire_on_commit=False)
    scheduler = PrintScheduler()
    start_outcomes = []
    terminal_outcomes = []

    async def on_started(printer_id, data):
        start_outcomes.append(await scheduler.bind_moonraker_observed(printer_id, data))

    async def on_completed(printer_id, data):
        terminal_outcomes.append(await scheduler.finalize_moonraker_job(printer_id, data))

    manager.set_print_start_callback(on_started)
    manager.set_print_complete_callback(on_completed)
    manager_printer = SimpleNamespace(
        id=ids.printer,
        name=printer.name,
        serial_number=None,
        model=printer.model,
        provider=PrinterProvider.MOONRAKER,
        moonraker_config=config,
    )

    assert await manager.connect_printer(manager_printer) is True
    try:
        with (
            patch.object(scheduler_module, "printer_manager", manager),
            patch.object(scheduler_module, "async_session", sessions),
            patch.object(scheduler_module.settings, "base_dir", tmp_path),
            patch.object(scheduler_module.notification_service, "on_queue_job_started", AsyncMock()),
            patch.object(scheduler, "_propagate_owner_to_printer_manager", AsyncMock()),
        ):
            async with sessions() as db:
                await scheduler._start_print(db, await db.get(PrintQueueItem, ids.item))

            async with sessions() as db:
                queued = await db.get(PrintQueueItem, ids.item)
                remote_path = queued.provider_job_id
                correlation_id = queued.provider_correlation_id
                assert queued.status == "printing"
                assert queued.start_reconcile_after is None
                assert remote_path and remote_path.startswith("queue/queued-")
                assert correlation_id

            assert fake_moonraker.uploads[0][1] == b"G28\n"
            assert fake_moonraker.commands == [("start", remote_path)]

            await fake_moonraker.wait_for_subscribers()
            await fake_moonraker.set_status(
                {"print_stats": {"state": "printing", "filename": remote_path, "job_id": "42"}}
            )
            await _wait_for(lambda: manager.get_snapshot(ids.printer).state is NormalizedPrinterState.PRINTING)
            await _wait_for(lambda: bool(start_outcomes))
            assert start_outcomes == [True]

            async with sessions() as db:
                current = await db.get(PrintQueueItem, ids.item)
                assert current.provider_job_id == "42"

            await fake_moonraker.finish_job(status="completed", filename=remote_path, job_id="42")
            await _wait_for(lambda: bool(terminal_outcomes))
            assert terminal_outcomes[0] is not None

            async def queue_completed():
                async with sessions() as db:
                    current = await db.get(PrintQueueItem, ids.item)
                    return current.status == "completed"

            async with asyncio.timeout(1):
                while not await queue_completed():
                    await asyncio.sleep(0)

            async with sessions() as db:
                queued = await db.get(PrintQueueItem, ids.item)
                stored_archive = await db.get(PrintArchive, ids.archive)
                logs = list((await db.scalars(select(PrintLogEntry))).all())
                assert queued.status == "completed"
                assert queued.provider_correlation_id == correlation_id
                assert queued.provider_job_id == "42"
                assert stored_archive.status == "completed"
                assert len(logs) == 1
                assert logs[0].status == "completed"
                assert logs[0].archive_id == ids.archive
    finally:
        await manager.disconnect_printer_async(ids.printer)


@pytest.mark.asyncio
async def test_malformed_jsonrpc_and_websocket_payloads_reconnect_safely(fake_moonraker, monkeypatch):
    delays = []

    async def no_sleep(delay):
        delays.append(delay)
        fake_moonraker.malformed_jsonrpc_method = None
        fake_moonraker.malformed_websocket_message = False
        await asyncio.sleep(0)

    fake_moonraker.malformed_jsonrpc_method = "printer.objects.query"
    backend = _backend(fake_moonraker, monkeypatch, [], sleep=no_sleep)
    await backend.connect()
    try:
        await _wait_for(lambda: delays == [1])
        await _wait_for(lambda: backend.snapshot().connected)
        await fake_moonraker.wait_for_subscribers()

        await fake_moonraker.send_malformed_notification()
        await _wait_for(lambda: delays == [1, 2])
        await _wait_for(lambda: backend.snapshot().connected)
        assert backend.snapshot().state is NormalizedPrinterState.IDLE
    finally:
        await backend.disconnect()
