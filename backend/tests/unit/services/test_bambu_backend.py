from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend.app.services.bambu_backend import BambuBackend
from backend.app.services.bambu_mqtt import PrinterState
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_backend import JobLifecycle, ProviderEvent, StatusChanged
from backend.app.services.printer_types import NormalizedPrinterState, PrinterProvider


def test_snapshot_preserves_dual_tool_ams_and_external_inventory():
    state = PrinterState(connected=True, state="IDLE")
    state.ams_extruder_map = {"0": 1, "128": 0}
    state.raw_data = {
        "ams": [
            {
                "id": "0",
                "tray": [
                    {"id": "0", "tray_type": "PLA", "tray_color": "FF0000FF", "tray_info_idx": "GFA00", "remain": 50},
                    {"id": "3", "tray_type": "PETG", "tray_color": "00FF00FF", "remain": 70},
                ],
            },
            {"id": "128", "tray": [{"id": "0", "tray_type": "PA", "tray_color": "000000FF", "remain": 30}]},
        ],
        "vt_tray": [
            {"id": "254", "tray_type": "TPU", "tray_color": "FFFFFF", "remain": 20},
            {"id": "255", "tray_type": "PLA", "tray_color": "0000FF", "remain": 90},
        ],
    }
    client = MagicMock(state=state)
    client.is_stale.return_value = False
    backend = BambuBackend(
        SimpleNamespace(ip_address="192.168.1.2", serial_number="SERIAL", access_code="code", model="H2D"),
        client_factory=lambda **kwargs: client,
        emit=lambda event: None,
    )
    loaded = PrintScheduler()._build_loaded_filaments(backend.snapshot())
    assert [(f["global_tray_id"], f["extruder_id"], f["remain"], f["is_external"]) for f in loaded] == [
        (0, 1, 50, False),
        (3, 1, 70, False),
        (128, 0, 30, False),
        (254, 1, 20, True),
        (255, 0, 90, True),
    ]
    assert loaded[0]["tray_info_idx"] == "GFA00"
    assert loaded[0]["color"] == "#FF0000"
    assert loaded[2]["is_ht"] is True


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
    client.state.nozzles = [SimpleNamespace(nozzle_diameter="0.4"), SimpleNamespace(nozzle_diameter="")]
    client.is_stale.return_value = False
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
    assert [(nozzle.tool_index, nozzle.diameter, nozzle.status) for nozzle in backend.snapshot().nozzles] == [
        (0, 0.4, "confirmed"),
        (1, None, "unknown"),
    ]
    assert backend.snapshot().telemetry_stale is False
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
