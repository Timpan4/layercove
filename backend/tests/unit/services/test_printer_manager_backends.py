import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from backend.app.services.printer_backend import JobLifecycle, ProviderEvent, StatusChanged
from backend.app.services.printer_backend_registry import PrinterBackendRegistry
from backend.app.services.printer_manager import PrinterManager, printer_status_to_dict
from backend.app.services.printer_types import (
    NormalizedPrinterState,
    PrinterCapabilities,
    PrinterProvider,
    PrinterSnapshot,
)


class FakeBackend:
    provider = PrinterProvider.BAMBU
    capabilities = PrinterCapabilities(pause=True, resume=True, cancel=True, start_print=True)

    def __init__(self):
        self.connected = False
        self.calls: list[str] = []
        self.emit = None
        self.disconnect_event = None
        self.connect_error = None

    async def connect(self):
        self.connected = True
        self.calls.append("connect")
        if self.connect_error is not None:
            raise self.connect_error

    async def disconnect(self, timeout=0):
        if self.disconnect_event is not None:
            self.emit(self.disconnect_event)
            await asyncio.sleep(0)
        self.connected = False
        self.calls.append(f"disconnect:{timeout}")

    def snapshot(self):
        return PrinterSnapshot(
            provider=self.provider,
            connected=self.connected,
            state=NormalizedPrinterState.IDLE,
        )

    async def start_print(self, filename, *_, **__):
        self.calls.append(f"start:{filename}")
        return True

    async def pause(self):
        self.calls.append("pause")
        return True

    async def resume(self):
        self.calls.append("resume")
        return True

    async def cancel(self):
        self.calls.append("cancel")
        return True


def lifecycle(kind, name, correlation_id="job-1"):
    return JobLifecycle(kind, correlation_id, None, name, datetime.now(timezone.utc), None, {"name": name})


@pytest.mark.asyncio
async def test_manager_uses_backend_for_lifecycle_status_and_common_commands():
    backend = FakeBackend()
    registry = PrinterBackendRegistry()

    def make_backend(printer, emit):
        backend.emit = emit
        return backend

    registry.register(PrinterProvider.BAMBU, make_backend)
    manager = PrinterManager(registry=registry)
    printer = SimpleNamespace(
        id=1,
        provider="bambu",
        name="Test printer",
        serial_number="SERIAL",
        model="X1C",
    )

    assert await manager.connect_printer(printer) is True
    assert manager.get_status(1).state is NormalizedPrinterState.IDLE
    assert manager.is_connected(1) is True
    assert manager.get_client(1) is None
    assert await manager.start_print_async(1, "cube.3mf") is True
    assert await manager.pause_print_async(1) is True
    assert await manager.resume_print_async(1) is True
    assert await manager.stop_print_async(1) is True

    await manager.disconnect_printer_async(1, timeout=3)

    assert backend.calls == ["connect", "start:cube.3mf", "pause", "resume", "cancel", "disconnect:3"]


@pytest.mark.asyncio
async def test_manager_forwards_events_fifo_and_drops_events_after_disconnect():
    backend = FakeBackend()
    registry = PrinterBackendRegistry()

    def make_backend(printer, emit):
        backend.emit = emit
        return backend

    registry.register(PrinterProvider.BAMBU, make_backend)
    manager = PrinterManager(registry=registry)
    observed = []

    async def on_status(printer_id, state):
        observed.append((printer_id, state.state.value))

    async def on_start(printer_id, data):
        observed.append((printer_id, data["name"]))

    async def on_complete(printer_id, data):
        observed.append((printer_id, data["name"]))

    manager.set_status_change_callback(on_status)
    manager.set_print_start_callback(on_start)
    manager.set_print_complete_callback(on_complete)
    printer = SimpleNamespace(id=7, provider="bambu", name="Test", serial_number="S", model="X1C")
    await manager.connect_printer(printer)

    snapshot = backend.snapshot()
    backend.emit(StatusChanged(snapshot))
    backend.emit(lifecycle("started", "cube"))
    backend.emit(lifecycle("failed", "failed", "job-failed"))
    backend.emit(lifecycle("failed", "failed", "job-failed"))
    await asyncio.sleep(0)
    await manager._event_queues[7].join()

    assert observed == [(7, "idle"), (7, "cube"), (7, "failed")]

    manager.mark_printer_offline(7)
    await asyncio.sleep(0)
    await manager._event_queues[7].join()
    assert observed[-1] == (7, "offline")
    assert manager.get_snapshot(7).state is NormalizedPrinterState.OFFLINE
    assert manager.get_all_snapshots()[7].state is NormalizedPrinterState.OFFLINE
    assert manager.is_connected(7) is False

    backend.emit(StatusChanged(backend.snapshot()))
    await asyncio.sleep(0)
    await manager._event_queues[7].join()
    assert manager.get_snapshot(7).state is NormalizedPrinterState.IDLE
    assert manager.is_connected(7) is True

    backend.disconnect_event = lifecycle("started", "during disconnect", "job-2")
    await manager.disconnect_printer_async(7)
    backend.emit(lifecycle("started", "too late", "job-3"))
    await asyncio.sleep(0)

    assert observed == [
        (7, "idle"),
        (7, "cube"),
        (7, "failed"),
        (7, "offline"),
        (7, "idle"),
        (7, "during disconnect"),
    ]


@pytest.mark.asyncio
async def test_manager_routes_bambu_lifecycle_and_moonraker_terminal_callbacks():
    manager = PrinterManager(registry=PrinterBackendRegistry())
    observed = []

    async def on_start(printer_id, data):
        observed.append((printer_id, "started", data["name"]))

    async def on_complete(printer_id, data):
        observed.append((printer_id, "completed", data["name"]))

    manager.set_print_start_callback(on_start)
    manager.set_print_complete_callback(on_complete)
    manager._backends = {
        1: SimpleNamespace(provider=PrinterProvider.MOONRAKER),
        2: SimpleNamespace(provider=PrinterProvider.BAMBU),
    }

    for printer_id in (1, 2):
        await manager._forward_backend_event(printer_id, lifecycle("started", "cube", f"job-{printer_id}"))
        await manager._forward_backend_event(printer_id, lifecycle("completed", "cube", f"job-{printer_id}"))

    assert observed == [
        (1, "started", "cube"),
        (1, "completed", "cube"),
        (2, "started", "cube"),
        (2, "completed", "cube"),
    ]
    assert manager._seen_lifecycle_events == {
        (1, "job-1", "started"),
        (1, "job-1", "completed"),
        (2, "job-2", "started"),
        (2, "job-2", "completed"),
    }


@pytest.mark.asyncio
async def test_manager_routes_running_observed_callback_for_lifecycle_backends():
    manager = PrinterManager(registry=PrinterBackendRegistry())
    observed = []

    async def on_running(printer_id, data):
        observed.append((printer_id, data["filename"]))

    manager.set_print_running_observed_callback(on_running)
    manager._backends = {
        1: SimpleNamespace(provider=PrinterProvider.MOONRAKER),
        2: SimpleNamespace(provider=PrinterProvider.BAMBU),
    }
    event = ProviderEvent("print_running_observed", {"filename": "cube.gcode"})

    await manager._forward_backend_event(1, event)
    await manager._forward_backend_event(2, event)

    assert observed == [(1, "cube.gcode"), (2, "cube.gcode")]


@pytest.mark.asyncio
async def test_queued_connected_status_cannot_override_later_forced_offline_status():
    backend = FakeBackend()
    registry = PrinterBackendRegistry()

    def make_backend(printer, emit):
        backend.emit = emit
        return backend

    registry.register(PrinterProvider.BAMBU, make_backend)
    manager = PrinterManager(registry=registry)
    printer = SimpleNamespace(id=8, provider="bambu", name="Test", serial_number="S", model="X1C")
    await manager.connect_printer(printer)

    backend.emit(StatusChanged(backend.snapshot()))
    manager.mark_printer_offline(8)
    await manager._event_queues[8].join()

    assert manager.get_snapshot(8).state is NormalizedPrinterState.OFFLINE
    assert manager.is_connected(8) is False


@pytest.mark.asyncio
async def test_manager_logs_unknown_provider_without_attempting_connection(caplog):
    manager = PrinterManager()
    printer = SimpleNamespace(
        id=1,
        provider="unknown",
        name="Unknown printer",
        serial_number="SERIAL",
        model=None,
    )

    assert await manager.connect_printer(printer) is False
    assert "Unsupported printer provider: unknown" in caplog.text


def test_non_bambu_snapshot_serializer_has_no_provider_detail_leak():
    snapshot = PrinterSnapshot(
        provider=PrinterProvider.MOONRAKER,
        connected=True,
        state=NormalizedPrinterState.PRINTING,
        filename="cube.gcode",
        progress=12.5,
        provider_detail={"token": "secret", "raw": object()},
    )

    payload = printer_status_to_dict(snapshot)

    assert payload["provider"] == "moonraker"
    assert payload["current_print"] == "cube.gcode"
    assert "provider_detail" not in payload
    assert "secret" not in repr(payload)


@pytest.mark.asyncio
async def test_connect_failure_stops_started_backend_before_dropping_events():
    backend = FakeBackend()
    backend.connect_error = RuntimeError("connect failed after producer start")
    backend.disconnect_event = lifecycle("cancelled", "cleanup", "cleanup-job")
    registry = PrinterBackendRegistry()

    def make_backend(printer, emit):
        backend.emit = emit
        return backend

    registry.register(PrinterProvider.BAMBU, make_backend)
    manager = PrinterManager(registry=registry)
    completed = []
    manager.set_print_complete_callback(lambda printer_id, data: completed.append((printer_id, data["name"])))
    printer = SimpleNamespace(id=9, provider="bambu", name="Test", serial_number="S", model="X1C")

    with pytest.raises(RuntimeError, match="connect failed"):
        await manager.connect_printer(printer)

    assert backend.calls == ["connect", "disconnect:0"]
    assert completed == [(9, "cleanup")]
    assert manager.get_backend(9) is None
