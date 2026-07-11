from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend.app.services.bambu_backend import BambuBackend
from backend.app.services.printer_backend import JobLifecycle, StatusChanged
from backend.app.services.printer_types import NormalizedPrinterState, PrinterProvider


@pytest.mark.asyncio
async def test_bambu_backend_emits_typed_events_and_delegates_async_commands():
    client = MagicMock()
    client.state.connected = True
    client.state.state = "RUNNING"
    client.state.current_print = "cube.3mf"
    client.state.progress = 25.0
    client.state.remaining_time = 123
    client.state.layer_num = 3
    client.state.total_layers = 20
    client.state.temperatures = {"nozzle": 220.0}
    client.state.raw_data = {"private": "not in normalized detail"}
    events = []

    factory = MagicMock(return_value=client)
    backend = BambuBackend(
        SimpleNamespace(ip_address="192.168.1.2", serial_number="SERIAL", access_code="code", model="X1C"),
        client_factory=factory,
        emit=events.append,
    )

    await backend.connect()
    assert backend.provider is PrinterProvider.BAMBU
    assert backend.snapshot().state is NormalizedPrinterState.PRINTING
    assert backend.snapshot().filename == "cube.3mf"
    assert backend.snapshot().provider_detail == {}
    assert await backend.pause() is client.pause_print.return_value
    assert await backend.resume() is client.resume_print.return_value
    assert await backend.cancel() is client.stop_print.return_value
    assert await backend.start_print("cube.3mf", plate_id=2) is client.start_print.return_value

    factory.call_args.kwargs["on_state_change"](client.state)
    factory.call_args.kwargs["on_print_start"]({"job": "cube"})

    client.connect.assert_called_once_with()
    assert isinstance(events[0], StatusChanged)
    assert events[0].provider_state is client.state
    assert events[0].snapshot.state is NormalizedPrinterState.PRINTING
    assert events[1] == JobLifecycle("started", {"job": "cube"})
    client.check_staleness.assert_called()
    client.pause_print.assert_called_once_with()
    client.resume_print.assert_called_once_with()
    client.stop_print.assert_called_once_with()
    client.start_print.assert_called_once_with("cube.3mf", 2)
