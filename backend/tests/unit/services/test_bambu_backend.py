from types import SimpleNamespace
from unittest.mock import MagicMock

from backend.app.services.bambu_backend import BambuBackend
from backend.app.services.printer_types import NormalizedPrinterState, PrinterProvider


def test_bambu_backend_constructs_client_with_existing_callbacks_and_delegates_commands():
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
    on_state_change = MagicMock()
    on_print_start = MagicMock()

    factory = MagicMock(return_value=client)
    backend = BambuBackend(
        SimpleNamespace(ip_address="192.168.1.2", serial_number="SERIAL", access_code="code", model="X1C"),
        client_factory=factory,
        on_state_change=on_state_change,
        on_print_start=on_print_start,
    )

    backend.connect()
    assert backend.provider is PrinterProvider.BAMBU
    assert backend.snapshot().state is NormalizedPrinterState.PRINTING
    assert backend.snapshot().filename == "cube.3mf"
    assert backend.snapshot().provider_detail == {}
    assert backend.pause() is client.pause_print.return_value
    assert backend.resume() is client.resume_print.return_value
    assert backend.cancel() is client.stop_print.return_value
    assert backend.start_print("cube.3mf", plate_id=2) is client.start_print.return_value

    client.connect.assert_called_once_with()
    assert factory.call_args.kwargs["on_state_change"] is on_state_change
    assert factory.call_args.kwargs["on_print_start"] is on_print_start
    client.check_staleness.assert_called()
    client.pause_print.assert_called_once_with()
    client.resume_print.assert_called_once_with()
    client.stop_print.assert_called_once_with()
    client.start_print.assert_called_once_with("cube.3mf", 2)
