import asyncio
from types import SimpleNamespace

import pytest

from backend.app.services.printer_backend import JobLifecycle, StatusChanged
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

    async def connect(self):
        self.connected = True
        self.calls.append("connect")

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

    manager.set_status_change_callback(on_status)
    manager.set_print_start_callback(on_start)
    printer = SimpleNamespace(id=7, provider="bambu", name="Test", serial_number="S", model="X1C")
    await manager.connect_printer(printer)

    snapshot = backend.snapshot()
    backend.emit(StatusChanged(snapshot))
    backend.emit(JobLifecycle("started", {"name": "cube"}))
    await asyncio.sleep(0)
    await manager._event_queues[7].join()

    assert observed == [(7, "idle"), (7, "cube")]

    backend.disconnect_event = JobLifecycle("started", {"name": "during disconnect"})
    await manager.disconnect_printer_async(7)
    backend.emit(JobLifecycle("started", {"name": "too late"}))
    await asyncio.sleep(0)

    assert observed == [(7, "idle"), (7, "cube"), (7, "during disconnect")]


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
