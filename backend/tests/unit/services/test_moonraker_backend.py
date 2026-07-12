import asyncio
from types import SimpleNamespace

import pytest

from backend.app.services.moonraker_backend import MoonrakerBackend, moonraker_retry_delay
from backend.app.services.printer_backend import JobLifecycle, ProviderEvent, StatusChanged
from backend.app.services.printer_types import NormalizedPrinterState


class FakeConnection:
    def __init__(self, messages):
        self.messages = asyncio.Queue()
        for message in messages:
            self.messages.put_nowait(message)
        self.sent = []
        self.sent_event = asyncio.Event()
        self.closed = False

    async def send_json(self, data):
        self.sent.append(data)
        self.sent_event.set()

    async def receive_json(self):
        message = await self.messages.get()
        if isinstance(message, Exception):
            raise message
        return message

    async def close(self):
        self.closed = True


class FakeTransport:
    def __init__(self, connections):
        self.connections = list(connections)
        self.options = None

    async def connect(self):
        return self.connections.pop(0)


def printer():
    return SimpleNamespace(
        moonraker_config=SimpleNamespace(
            base_url="http://klipper.local:7125",
            websocket_url_override=None,
            api_key=None,
            authorization=None,
            tls_verify=True,
        )
    )


async def wait_for(predicate):
    for _ in range(50):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition did not become true")


@pytest.mark.asyncio
async def test_moonraker_subscribes_normalizes_live_status_and_ignores_partial_payloads():
    connection = FakeConnection(
        [
            {"id": 1, "result": {"status": {"print_stats": {"state": "standby"}}}},
            {"id": 2, "result": {"status": {"print_stats": {"state": "standby"}}}},
            {
                "method": "notify_status_update",
                "params": [
                    {
                        "print_stats": {
                            "state": "printing",
                            "filename": "cube.gcode",
                            "job_id": "history-4",
                            "print_duration": 61.8,
                            "info": {"current_layer": 2, "total_layer": 20},
                        },
                        "virtual_sdcard": {"progress": 0.125},
                        "extruder": {"temperature": 215.5},
                        "heater_bed": {"temperature": 60},
                    },
                    1.0,
                ],
            },
        ]
    )
    transport = FakeTransport([connection])
    events = []

    backend = MoonrakerBackend(printer(), emit=events.append, transport_factory=lambda **_: transport)
    await backend.connect()
    await wait_for(lambda: backend.snapshot().state is NormalizedPrinterState.PRINTING)

    assert [message["method"] for message in connection.sent] == [
        "printer.objects.query",
        "printer.objects.subscribe",
    ]
    assert backend.snapshot().filename == "cube.gcode"
    assert backend.snapshot().progress == 12.5
    assert backend.snapshot().elapsed_seconds == 61
    assert backend.snapshot().current_layer == 2
    assert backend.snapshot().temperatures == {"nozzle": 215.5, "bed": 60.0}
    assert backend.snapshot().provider_detail == {"print_state": "printing"}
    assert any(isinstance(event, JobLifecycle) and event.kind == "started" for event in events)

    before = backend.snapshot()
    backend._process_message({"method": "notify_status_update", "params": [{"extruder": "invalid"}]}, bootstrap=False)
    assert backend.snapshot() == before

    await backend.disconnect()
    assert connection.closed is True


@pytest.mark.asyncio
async def test_moonraker_reconnect_keeps_active_correlation_and_emits_one_terminal_event():
    first = FakeConnection(
        [
            {"id": 1, "result": {"status": {"print_stats": {"state": "standby"}}}},
            {"id": 2, "result": {"status": {"print_stats": {"state": "standby"}}}},
            {
                "method": "notify_status_update",
                "params": [{"print_stats": {"state": "printing", "filename": "cube.gcode"}}],
            },
            RuntimeError("disconnect"),
        ]
    )
    second = FakeConnection(
        [
            {
                "id": 1,
                "result": {"status": {"print_stats": {"state": "error", "filename": "cube.gcode"}}},
            },
            {
                "id": 2,
                "result": {"status": {"print_stats": {"state": "error", "filename": "cube.gcode"}}},
            },
        ]
    )
    transport = FakeTransport([first, second])
    events = []
    delays = []

    async def sleep(delay):
        delays.append(delay)
        await asyncio.sleep(0)

    backend = MoonrakerBackend(
        printer(),
        emit=events.append,
        transport_factory=lambda **_: transport,
        sleep=sleep,
        jitter=lambda: 0,
    )
    await backend.connect()
    await wait_for(lambda: any(isinstance(event, JobLifecycle) and event.kind == "failed" for event in events))

    started = next(event for event in events if isinstance(event, JobLifecycle) and event.kind == "started")
    terminal = next(event for event in events if isinstance(event, JobLifecycle) and event.kind == "failed")
    assert terminal.correlation_id == started.correlation_id
    assert terminal.data["status"] == "failed"
    assert delays == [1]
    assert first.closed is True
    await backend.disconnect()


@pytest.mark.asyncio
async def test_moonraker_connect_owns_one_task_and_disconnect_cancels_its_socket():
    connection = FakeConnection(
        [
            {"id": 1, "result": {"status": {"print_stats": {"state": "standby"}}}},
            {"id": 2, "result": {"status": {"print_stats": {"state": "standby"}}}},
        ]
    )
    transport = FakeTransport([connection])
    backend = MoonrakerBackend(printer(), emit=lambda _: None, transport_factory=lambda **_: transport)

    await backend.connect()
    task = backend._task
    await backend.connect()
    await wait_for(lambda: backend.snapshot().connected)

    assert backend._task is task
    assert len(connection.sent) == 2
    await backend.disconnect()
    assert backend._task is None
    assert connection.closed is True


@pytest.mark.asyncio
async def test_stalled_bootstrap_response_closes_socket_and_retries_without_long_wait():
    stalled = FakeConnection([])
    recovered = FakeConnection(
        [
            {"id": 1, "result": {"status": {"print_stats": {"state": "standby"}}}},
            {"id": 2, "result": {"status": {"print_stats": {"state": "standby"}}}},
        ]
    )
    transport = FakeTransport([stalled, recovered])
    delays = []

    async def sleep(delay):
        delays.append(delay)

    backend = MoonrakerBackend(
        printer(),
        emit=lambda _: None,
        transport_factory=lambda **_: transport,
        sleep=sleep,
        jitter=lambda: 0,
        bootstrap_timeout=0.01,
    )

    await backend.connect()
    await asyncio.wait_for(recovered.sent_event.wait(), timeout=0.2)
    await wait_for(lambda: backend.snapshot().connected)

    assert stalled.closed is True
    assert delays == [1]
    await backend.disconnect()


def test_moonraker_retry_delay_is_bounded_and_deterministic_with_injected_jitter():
    assert moonraker_retry_delay(0, lambda: 0) == 1
    assert moonraker_retry_delay(4, lambda: 1) == 19.2
    assert moonraker_retry_delay(99, lambda: 2) == 36


def test_moonraker_active_bootstrap_observation_does_not_invent_started_event():
    events = []
    backend = MoonrakerBackend(printer(), emit=events.append, transport_factory=lambda **_: None)

    backend._merge_status({"print_stats": {"state": "printing", "filename": "existing.gcode"}}, bootstrap=True)

    assert any(isinstance(event, ProviderEvent) and event.kind == "print_running_observed" for event in events)
    assert not any(isinstance(event, JobLifecycle) and event.kind == "started" for event in events)
