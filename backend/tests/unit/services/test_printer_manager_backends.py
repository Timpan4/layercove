from types import SimpleNamespace

import pytest

from backend.app.services.printer_backend_registry import PrinterBackendRegistry
from backend.app.services.printer_manager import PrinterManager
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

    def connect(self):
        self.connected = True
        self.calls.append("connect")

    def disconnect(self, timeout=0):
        self.connected = False
        self.calls.append(f"disconnect:{timeout}")

    def snapshot(self):
        return PrinterSnapshot(
            provider=self.provider,
            connected=self.connected,
            state=NormalizedPrinterState.IDLE,
        )

    def start_print(self, filename, *_, **__):
        self.calls.append(f"start:{filename}")
        return True

    def pause(self):
        self.calls.append("pause")
        return True

    def resume(self):
        self.calls.append("resume")
        return True

    def cancel(self):
        self.calls.append("cancel")
        return True


@pytest.mark.asyncio
async def test_manager_uses_backend_for_lifecycle_status_and_common_commands():
    backend = FakeBackend()
    registry = PrinterBackendRegistry()
    registry.register(PrinterProvider.BAMBU, lambda printer, **_: backend)
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
    assert manager.start_print(1, "cube.3mf") is True
    assert manager.pause_print(1) is True
    assert manager.resume_print(1) is True
    assert manager.stop_print(1) is True

    manager.disconnect_printer(1, timeout=3)

    assert backend.calls == ["connect", "start:cube.3mf", "pause", "resume", "cancel", "disconnect:3"]


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
