from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend.app.services.bambu_backend import BambuBackend
from backend.app.services.printer_backend import JobLifecycle, ProviderEvent, StatusChanged
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
    client.state.subtask_id = "task-42"
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
    factory.call_args.kwargs["on_print_complete"]({"status": "failed", "filename": "cube.3mf"})

    client.connect.assert_called_once_with()
    assert isinstance(events[0], StatusChanged)
    assert events[0].provider_state is client.state
    assert events[0].snapshot.state is NormalizedPrinterState.PRINTING
    assert isinstance(events[1], JobLifecycle)
    assert events[1].kind == "started"
    assert events[1].correlation_id
    assert events[1].provider_job_id == "task-42"
    assert events[1].data == {"job": "cube"}
    assert events[2].kind == "failed"
    assert events[2].correlation_id == events[1].correlation_id
    assert events[2].reason == "failed"
    backend.mark_offline()
    assert client.state.connected is False
    assert events[3].snapshot.state is NormalizedPrinterState.OFFLINE
    assert events[3].provider_state is client.state
    client.check_staleness.assert_called()
    client.pause_print.assert_called_once_with()
    client.resume_print.assert_called_once_with()
    client.stop_print.assert_called_once_with()
    client.start_print.assert_called_once_with("cube.3mf", 2)


def test_bambu_backend_classifies_aborted_terminal_as_cancelled():
    client = MagicMock()
    client.state.subtask_id = None
    client.state.current_print = "cube.3mf"
    events = []
    factory = MagicMock(return_value=client)
    BambuBackend(
        SimpleNamespace(ip_address="192.168.1.2", serial_number="SERIAL", access_code="code", model="X1C"),
        client_factory=factory,
        emit=events.append,
    )

    factory.call_args.kwargs["on_print_start"]({"filename": "cube.3mf"})
    factory.call_args.kwargs["on_print_complete"]({"status": "aborted", "filename": "cube.3mf"})

    assert events[1].kind == "cancelled"
    assert events[1].correlation_id == events[0].correlation_id
    assert events[1].reason == "aborted"

    factory.call_args.kwargs["on_print_start"]({"filename": "second.3mf"})
    factory.call_args.kwargs["on_print_complete"]({"status": "completed", "filename": "second.3mf"})
    assert events[3].kind == "completed"
    assert events[3].correlation_id == events[2].correlation_id
    assert events[3].reason is None


def test_running_observed_seeds_terminal_correlation_without_synthetic_start():
    client = MagicMock()
    client.state.subtask_id = "bootstrap-7"
    client.state.current_print = "active.3mf"
    events = []
    factory = MagicMock(return_value=client)
    BambuBackend(
        SimpleNamespace(ip_address="192.168.1.2", serial_number="SERIAL", access_code="code", model="X1C"),
        client_factory=factory,
        emit=events.append,
    )

    observed = {"filename": "active.3mf"}
    factory.call_args.kwargs["on_print_running_observed"](observed)
    factory.call_args.kwargs["on_print_complete"]({"status": "failed", "filename": "active.3mf"})

    assert isinstance(events[0], ProviderEvent)
    assert events[0].kind == "print_running_observed"
    assert events[0].data is observed
    assert not any(isinstance(event, JobLifecycle) and event.kind == "started" for event in events)
    assert events[1].correlation_id == "bambu:bootstrap-7"
    assert events[1].provider_job_id == "bootstrap-7"
    assert events[1].filename == "active.3mf"
