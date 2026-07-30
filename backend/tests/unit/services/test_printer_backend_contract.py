from io import BytesIO
from types import SimpleNamespace

import pytest

from backend.app.services.bambu_backend import BambuBackend
from backend.app.services.moonraker_backend import MoonrakerBackend
from backend.app.services.moonraker_http import MoonrakerHTTPError
from backend.app.services.printer_backend import (
    BackendError,
    BambuStartJob,
    JobLifecycle,
    MoonrakerStartJob,
    StartResult,
    StatusChanged,
    UploadJob,
    UploadResult,
)
from backend.app.services.printer_types import NormalizedPrinterState


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


@pytest.mark.asyncio
async def test_moonraker_upload_start_contract_preserves_queue_identity_and_events():
    calls = []

    class HTTP:
        async def upload_gcode(self, file, *, filename, size):
            calls.append(("upload", filename, size))
            return "queue/server.gcode"

        async def start_print(self, filename):
            calls.append(("start", filename))

    events = []
    backend = MoonrakerBackend(
        printer(), emit=events.append, transport_factory=lambda **_: None, http_client_factory=lambda **_: HTTP()
    )
    backend._snapshot = backend._snapshot.__class__(backend.provider, True, NormalizedPrinterState.IDLE)
    backend.bind_queued_job("queue-correlation", "queue/server.gcode")

    upload = await backend.upload(UploadJob(BytesIO(b"G0"), "cube.gcode", 2))
    start = await backend.start(MoonrakerStartJob(upload.path))
    backend._merge_status(
        {"print_stats": {"state": "printing", "filename": upload.path, "job_id": "job-1"}}, bootstrap=False
    )

    assert upload == UploadResult("queue/server.gcode")
    assert start == StartResult(started=True)
    assert calls == [("upload", "cube.gcode", 2), ("start", "queue/server.gcode")]
    assert isinstance(events[0], StatusChanged)
    assert isinstance(events[1], JobLifecycle)
    assert events[1].correlation_id == "queue-correlation"


@pytest.mark.asyncio
async def test_moonraker_upload_rejects_non_upload_job_before_http_io():
    calls = []

    class HTTP:
        async def upload_gcode(self, file, *, filename, size):
            calls.append((filename, size))
            return filename

    backend = MoonrakerBackend(
        printer(), emit=lambda _: None, transport_factory=lambda **_: None, http_client_factory=lambda **_: HTTP()
    )
    backend._snapshot = backend._snapshot.__class__(backend.provider, True, NormalizedPrinterState.IDLE)

    with pytest.raises(BackendError, match="Moonraker upload job is invalid") as caught:
        await backend.upload(MoonrakerStartJob("cube.gcode"))

    assert caught.value.code == "invalid_upload_job"
    assert calls == []


def bambu_backend(calls):
    class Client:
        def start_print(self, filename, plate_id):
            calls.append((filename, plate_id))
            return True

    return BambuBackend(
        SimpleNamespace(ip_address="192.168.1.2", serial_number="SERIAL", access_code="code", model="X1C"),
        emit=lambda _: None,
        client_factory=lambda **_: Client(),
    )


def moonraker_backend(calls):
    class HTTP:
        async def start_print(self, filename):
            calls.append(filename)

    backend = MoonrakerBackend(
        printer(), emit=lambda _: None, transport_factory=lambda **_: None, http_client_factory=lambda **_: HTTP()
    )
    backend._snapshot = backend._snapshot.__class__(backend.provider, True, NormalizedPrinterState.IDLE)
    return backend


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("make_backend", "job", "wrong_job", "expected_calls"),
    [
        (bambu_backend, BambuStartJob("cube.3mf", plate_id=2), MoonrakerStartJob("wrong.gcode"), [("cube.3mf", 2)]),
        (moonraker_backend, MoonrakerStartJob("cube.gcode"), BambuStartJob("wrong.3mf"), ["cube.gcode"]),
    ],
)
async def test_typed_start_contract_rejects_provider_mismatch_before_io(make_backend, job, wrong_job, expected_calls):
    calls = []
    backend = make_backend(calls)

    assert await backend.start(job) == StartResult(started=True)
    assert calls == expected_calls

    with pytest.raises(BackendError, match="start job is invalid") as caught:
        await backend.start(wrong_job)

    assert caught.value.code == "invalid_start_job"
    assert calls == expected_calls


@pytest.mark.asyncio
@pytest.mark.parametrize("job", [BambuStartJob("../unsafe.3mf"), BambuStartJob("cube.3mf", "not-an-int")])
async def test_bambu_start_rejects_invalid_fields_before_io(job):
    calls = []

    backend = bambu_backend(calls)

    with pytest.raises(BackendError, match="Bambu start job is invalid") as caught:
        await backend.start(job)

    assert caught.value.code == "invalid_start_job"
    assert calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (OSError("access code: secret"), ("unavailable", "Bambu print command could not be sent.", True)),
        (False, ("command_unavailable", "Bambu print command is unavailable.", False)),
    ],
)
async def test_bambu_start_maps_expected_failures_without_leaking_details(result, expected):
    class Client:
        def start_print(self, filename, plate_id):
            if isinstance(result, Exception):
                raise result
            return result

    backend = BambuBackend(
        SimpleNamespace(ip_address="192.168.1.2", serial_number="SERIAL", access_code="code", model="X1C"),
        emit=lambda _: None,
        client_factory=lambda **_: Client(),
    )

    with pytest.raises(BackendError) as caught:
        await backend.start(BambuStartJob("cube.3mf"))

    assert (caught.value.code, caught.value.safe_message, caught.value.retryable) == expected


@pytest.mark.asyncio
async def test_typed_commands_leave_programming_errors_visible():
    class Client:
        def start_print(self, filename, plate_id):
            raise RuntimeError("broken implementation")

    bambu = BambuBackend(
        SimpleNamespace(ip_address="192.168.1.2", serial_number="SERIAL", access_code="code", model="X1C"),
        emit=lambda _: None,
        client_factory=lambda **_: Client(),
    )

    class HTTP:
        async def start_print(self, filename):
            raise RuntimeError("broken implementation")

    moonraker = MoonrakerBackend(
        printer(), emit=lambda _: None, transport_factory=lambda **_: None, http_client_factory=lambda **_: HTTP()
    )
    moonraker._snapshot = moonraker._snapshot.__class__(moonraker.provider, True, NormalizedPrinterState.IDLE)

    with pytest.raises(RuntimeError, match="broken implementation"):
        await bambu.start(BambuStartJob("cube.3mf"))
    with pytest.raises(RuntimeError, match="broken implementation"):
        await moonraker.start(MoonrakerStartJob("cube.gcode"))


@pytest.mark.asyncio
async def test_moonraker_start_preserves_safe_path_validation():
    backend = MoonrakerBackend(printer(), emit=lambda _: None, transport_factory=lambda **_: None)
    backend._snapshot = backend._snapshot.__class__(backend.provider, True, NormalizedPrinterState.IDLE)

    with pytest.raises(BackendError) as caught:
        await backend.start(MoonrakerStartJob("../cube.gcode"))

    assert (caught.value.code, caught.value.safe_message) == (
        "invalid_filename",
        "Moonraker print requires a safe G-code path.",
    )

    class HTTP:
        async def start_print(self, filename):
            raise MoonrakerHTTPError("timeout", "Moonraker did not respond.")

    backend = MoonrakerBackend(
        printer(), emit=lambda _: None, transport_factory=lambda **_: None, http_client_factory=lambda **_: HTTP()
    )
    backend._snapshot = backend._snapshot.__class__(backend.provider, True, NormalizedPrinterState.IDLE)

    with pytest.raises(BackendError) as caught:
        await backend.start(MoonrakerStartJob("cube.gcode"))

    error = caught.value
    assert (error.code, error.message, error.safe_message, error.retryable) == (
        "timeout",
        "Moonraker did not respond.",
        "Moonraker did not respond.",
        True,
    )
