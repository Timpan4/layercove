import asyncio
from types import SimpleNamespace

import pytest

from backend.app.services.moonraker_backend import MoonrakerBackend, moonraker_retry_delay
from backend.app.services.moonraker_http import MoonrakerHTTPError
from backend.app.services.printer_backend import BackendError, JobLifecycle, ProviderEvent, StatusChanged
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
        self.messages.put_nowait(RuntimeError("closed"))


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
    await wait_for(lambda: len(connection.sent) == 2)
    await wait_for(lambda: backend.snapshot().connected)

    assert backend._task is task
    assert len(connection.sent) == 2
    await backend.disconnect()
    assert backend._task is None
    assert connection.closed is True


def test_queued_binding_becomes_started_and_terminal_lifecycle_identity():
    events = []
    backend = MoonrakerBackend(printer(), emit=events.append)
    backend._last_state = NormalizedPrinterState.IDLE
    backend.bind_queued_job("queue-correlation", "queue/cube.gcode")

    backend._merge_status(
        {"print_stats": {"state": "printing", "filename": "queue/cube.gcode", "job_id": "42"}},
        bootstrap=False,
    )
    backend._merge_status(
        {"print_stats": {"state": "complete", "filename": "queue/cube.gcode", "job_id": "42"}},
        bootstrap=False,
    )

    lifecycle = [event for event in events if isinstance(event, JobLifecycle)]
    assert [event.kind for event in lifecycle] == ["started", "completed"]
    assert {event.correlation_id for event in lifecycle} == {"queue-correlation"}
    assert {event.provider_job_id for event in lifecycle} == {"42"}


def test_unrelated_external_print_does_not_consume_pending_queue_binding():
    events = []
    backend = MoonrakerBackend(printer(), emit=events.append)
    backend._last_state = NormalizedPrinterState.IDLE
    backend.bind_queued_job("queue-correlation", "queue/cube.gcode", "queue/cube.gcode")

    backend._merge_status(
        {"print_stats": {"state": "printing", "filename": "external.gcode", "job_id": "99"}},
        bootstrap=False,
    )

    started = next(event for event in events if isinstance(event, JobLifecycle))
    assert started.correlation_id == "moonraker:99"
    assert started.provider_job_id == "99"
    assert started.filename == "external.gcode"


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


@pytest.mark.asyncio
async def test_quiet_stable_connection_resets_prior_backoff_when_it_disconnects():
    failed = [FakeConnection([RuntimeError("unavailable")]) for _ in range(4)]
    now = [0.0]

    class QuietStableConnection(FakeConnection):
        async def receive_json(self):
            if not self.messages.empty():
                return await super().receive_json()
            now[0] = 31.0
            raise RuntimeError("disconnect after quiet healthy period")

    quiet = QuietStableConnection(
        [
            {"id": 1, "result": {"status": {"print_stats": {"state": "standby"}}}},
            {"id": 2, "result": {"status": {"print_stats": {"state": "standby"}}}},
        ]
    )
    recovered = FakeConnection(
        [
            {"id": 1, "result": {"status": {"print_stats": {"state": "standby"}}}},
            {"id": 2, "result": {"status": {"print_stats": {"state": "standby"}}}},
        ]
    )
    transport = FakeTransport([*failed, quiet, recovered])
    delays = []

    async def sleep(delay):
        delays.append(delay)

    backend = MoonrakerBackend(
        printer(),
        emit=lambda _: None,
        transport_factory=lambda **_: transport,
        sleep=sleep,
        jitter=lambda: 0,
        clock=lambda: now[0],
    )

    await backend.connect()
    await asyncio.wait_for(recovered.sent_event.wait(), timeout=0.2)

    assert delays == [1, 2, 4, 8, 1]
    assert quiet.closed is True
    await backend.disconnect()


def test_moonraker_retry_delay_is_bounded_and_deterministic_with_injected_jitter():
    assert moonraker_retry_delay(0, lambda: 0) == 1
    assert moonraker_retry_delay(4, lambda: 1) == 19.2
    assert moonraker_retry_delay(99, lambda: 2) == 36


@pytest.mark.asyncio
async def test_moonraker_commands_follow_state_and_map_safe_errors():
    calls = []

    class HTTP:
        async def start_print(self, filename):
            calls.append(("start", filename))

        async def pause_print(self):
            calls.append(("pause", None))

        async def resume_print(self):
            calls.append(("resume", None))

        async def cancel_print(self):
            raise MoonrakerHTTPError("authentication_failed", "Moonraker rejected configured credentials.")

        async def emergency_stop(self):
            calls.append(("emergency", None))

        async def upload_gcode(self, file, *, filename, size):
            calls.append(("upload", filename))
            return "server-name.gcode"

    backend = MoonrakerBackend(
        printer(), emit=lambda _: None, transport_factory=lambda **_: None, http_client_factory=lambda **_: HTTP()
    )
    backend._snapshot = backend._snapshot.__class__(backend.provider, True, NormalizedPrinterState.IDLE)

    assert await backend.start_print("cube.gcode") is True
    assert await backend.upload_gcode(None, filename="upload-only.gcode", start=False, size=0) == "server-name.gcode"
    assert await backend.upload_gcode(None, filename="cube.gcode", start=True, size=0) == "server-name.gcode"
    with pytest.raises(BackendError, match="current printer state"):
        await backend.pause()

    backend._snapshot = backend._snapshot.__class__(backend.provider, True, NormalizedPrinterState.PRINTING)
    with pytest.raises(BackendError) as error:
        await backend.cancel()
    assert error.value.code == "authentication_failed"
    backend._snapshot = backend._snapshot.__class__(backend.provider, False, NormalizedPrinterState.OFFLINE)
    assert await backend.emergency_stop() is True
    assert calls == [
        ("start", "cube.gcode"),
        ("upload", "upload-only.gcode"),
        ("upload", "cube.gcode"),
        ("start", "server-name.gcode"),
        ("emergency", None),
    ]


@pytest.mark.asyncio
async def test_disconnected_emergency_stop_failure_comes_from_http_result():
    class HTTP:
        async def emergency_stop(self):
            raise MoonrakerHTTPError("timeout", "Moonraker did not respond before timeout.")

    backend = MoonrakerBackend(
        printer(), emit=lambda _: None, transport_factory=lambda **_: None, http_client_factory=lambda **_: HTTP()
    )
    assert backend.snapshot().connected is False

    with pytest.raises(BackendError) as error:
        await backend.emergency_stop()

    assert error.value.code == "timeout"


def test_moonraker_active_bootstrap_observation_does_not_invent_started_event():
    events = []
    backend = MoonrakerBackend(printer(), emit=events.append, transport_factory=lambda **_: None)

    backend._merge_status({"print_stats": {"state": "printing", "filename": "existing.gcode"}}, bootstrap=True)

    observed = next(
        event for event in events if isinstance(event, ProviderEvent) and event.kind == "print_running_observed"
    )
    assert observed.data["correlation_id"]
    assert not any(isinstance(event, JobLifecycle) and event.kind == "started" for event in events)


def test_official_history_finished_shape_emits_one_completed_event_across_reconnect():
    events = []
    backend = MoonrakerBackend(printer(), emit=events.append, transport_factory=lambda **_: None)
    backend._merge_status({"print_stats": {"state": "standby"}}, bootstrap=True)
    backend._merge_status({"print_stats": {"state": "printing", "filename": "cube.gcode"}}, bootstrap=False)
    message = {
        "method": "notify_history_changed",
        "params": [
            {
                "action": "finished",
                "job": {
                    "job_id": "000027",
                    "filename": "cube.gcode",
                    "status": "completed",
                    "print_duration": 42.9,
                },
            }
        ],
    }

    backend._process_message(message, bootstrap=False)
    backend._emit_offline()
    backend._process_message(message, bootstrap=True)

    started = [event for event in events if isinstance(event, JobLifecycle) and event.kind == "started"]
    completed = [event for event in events if isinstance(event, JobLifecycle) and event.kind == "completed"]
    assert len(started) == 1
    assert len(completed) == 1
    assert completed[0].correlation_id == started[0].correlation_id
    assert completed[0].provider_job_id == "000027"
    assert completed[0].data["status"] == "completed"
    assert backend.snapshot().elapsed_seconds == 42


def test_reconnect_idle_discards_stale_job_before_next_start_and_completion():
    events = []
    backend = MoonrakerBackend(printer(), emit=events.append, transport_factory=lambda **_: None)
    backend._merge_status({"print_stats": {"state": "standby"}}, bootstrap=True)
    backend._merge_status(
        {
            "print_stats": {
                "state": "printing",
                "filename": "a.gcode",
                "job_id": "job-a",
                "print_duration": 12,
                "info": {"current_layer": 3, "total_layer": 10},
            },
            "virtual_sdcard": {"progress": 0.3, "file_path": "a.gcode"},
        },
        bootstrap=False,
    )
    backend._emit_offline()

    backend._merge_status({"print_stats": {"state": "standby"}}, bootstrap=True)
    idle = backend.snapshot()
    assert idle.filename is None
    assert idle.progress is None
    assert idle.elapsed_seconds is None
    assert idle.current_layer is None
    backend._merge_status({"print_stats": {"state": "printing", "filename": "b.gcode"}}, bootstrap=False)
    backend._merge_status({"print_stats": {"state": "completed", "filename": "b.gcode"}}, bootstrap=False)

    lifecycle = [event for event in events if isinstance(event, JobLifecycle)]
    assert [(event.kind, event.filename) for event in lifecycle] == [
        ("started", "a.gcode"),
        ("started", "b.gcode"),
        ("completed", "b.gcode"),
    ]
    assert lifecycle[0].correlation_id == "moonraker:job-a"
    assert lifecycle[1].correlation_id != lifecycle[0].correlation_id
    assert lifecycle[1].provider_job_id is None
    assert lifecycle[2].correlation_id == lifecycle[1].correlation_id


def test_live_idle_transition_discards_active_identity_before_partial_next_job():
    events = []
    backend = MoonrakerBackend(printer(), emit=events.append, transport_factory=lambda **_: None)
    backend._merge_status({"print_stats": {"state": "standby"}}, bootstrap=True)
    backend._merge_status(
        {"print_stats": {"state": "printing", "filename": "a.gcode", "job_id": "job-a"}},
        bootstrap=False,
    )
    backend._merge_status({"print_stats": {"state": "standby"}}, bootstrap=False)
    backend._merge_status({"print_stats": {"state": "printing", "filename": "b.gcode"}}, bootstrap=False)
    backend._merge_status({"print_stats": {"state": "completed", "filename": "b.gcode"}}, bootstrap=False)

    lifecycle = [event for event in events if isinstance(event, JobLifecycle)]
    assert [(event.kind, event.filename) for event in lifecycle] == [
        ("started", "a.gcode"),
        ("started", "b.gcode"),
        ("completed", "b.gcode"),
    ]
    assert lifecycle[0].correlation_id == "moonraker:job-a"
    assert lifecycle[1].correlation_id != lifecycle[0].correlation_id
    assert lifecycle[1].provider_job_id is None
    assert lifecycle[2].correlation_id == lifecycle[1].correlation_id


@pytest.mark.parametrize("disconnect_before_idle", [False, True])
def test_idle_after_terminal_scrubs_job_cache_before_partial_next_job(disconnect_before_idle):
    events = []
    backend = MoonrakerBackend(printer(), emit=events.append, transport_factory=lambda **_: None)
    backend._merge_status({"print_stats": {"state": "standby"}}, bootstrap=True)
    backend._merge_status(
        {
            "print_stats": {
                "state": "printing",
                "filename": "a.gcode",
                "job_id": "job-a",
                "message": "old job",
                "print_duration": 12,
                "info": {"current_layer": 3, "total_layer": 10},
            },
            "virtual_sdcard": {"progress": 0.3, "file_path": "a.gcode"},
        },
        bootstrap=False,
    )
    backend._merge_status({"print_stats": {"state": "completed"}}, bootstrap=False)
    if disconnect_before_idle:
        backend._emit_offline()

    backend._merge_status({"print_stats": {"state": "standby"}}, bootstrap=disconnect_before_idle)
    backend._merge_status({"print_stats": {"state": "printing"}}, bootstrap=False)
    backend._merge_status({"print_stats": {"state": "completed"}}, bootstrap=False)

    lifecycle = [event for event in events if isinstance(event, JobLifecycle)]
    starts = [event for event in lifecycle if event.kind == "started"]
    completions = [event for event in lifecycle if event.kind == "completed"]
    assert len(starts) == 2
    assert len(completions) == 2
    assert starts[0].correlation_id == "moonraker:job-a"
    assert starts[1].correlation_id != starts[0].correlation_id
    assert starts[1].provider_job_id is None
    assert starts[1].filename is None
    assert completions[1].correlation_id == starts[1].correlation_id
    assert completions[1].filename is None


@pytest.mark.parametrize(
    "params",
    [
        [],
        [{}],
        [{"action": "finished", "job": "invalid"}],
        [{"action": "finished"}],
        [{"action": "unknown", "job": {"status": "completed"}}],
    ],
)
def test_malformed_history_notifications_are_ignored(params):
    events = []
    backend = MoonrakerBackend(printer(), emit=events.append, transport_factory=lambda **_: None)
    backend._merge_status({"print_stats": {"state": "standby"}}, bootstrap=True)
    before = backend.snapshot()
    events.clear()

    backend._process_message({"method": "notify_history_changed", "params": params}, bootstrap=False)

    assert backend.snapshot() == before
    assert events == []
