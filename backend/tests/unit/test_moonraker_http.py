import asyncio
import io
import ipaddress
import ssl
import time

import httpcore
import httpx
import pytest


@pytest.mark.asyncio
async def test_moonraker_client_blocks_unsafe_resolved_peers():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    async def resolver(host: str, port: int):
        assert (host, port) == ("printer.lan", 7125)
        return {ipaddress.ip_address("127.0.0.1")}

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(lambda request: httpx.Response(200)),
    )

    with pytest.raises(MoonrakerHTTPError, match="unsafe_target"):
        await client.get_server_info()


@pytest.mark.asyncio
async def test_moonraker_client_maps_api_key_and_blocks_redirects():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(302, headers={"location": "http://not-followed.invalid/"})

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        api_key="moonraker-secret",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(handler),
    )

    with pytest.raises(MoonrakerHTTPError) as caught:
        await client.get_server_info()

    assert caught.value.code == "redirect_blocked"
    assert "not-followed.invalid" not in str(caught.value)
    assert requests[0].headers["X-Api-Key"] == "moonraker-secret"
    assert "Authorization" not in requests[0].headers


@pytest.mark.asyncio
async def test_moonraker_client_maps_authorization_and_hides_network_error_details():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("10.0.0.25")}

    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise httpx.ConnectError("http://printer.lan/?token=moonraker-secret", request=request)

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        authorization="Bearer moonraker-secret",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(handler),
    )

    with pytest.raises(MoonrakerHTTPError) as caught:
        await client.get_server_info()

    assert caught.value.code == "unavailable"
    assert "moonraker-secret" not in str(caught.value)
    assert requests[0].headers["Authorization"] == "Bearer moonraker-secret"
    assert "X-Api-Key" not in requests[0].headers


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code", [401, 403])
async def test_moonraker_client_maps_authentication_status_without_body_leak(status_code: int):
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        api_key="secret",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(
            lambda request: httpx.Response(status_code, text="secret response body")
        ),
    )

    with pytest.raises(MoonrakerHTTPError) as caught:
        await client.get_server_info()

    assert caught.value.code == "authentication_failed"
    assert "secret" not in str(caught.value)


@pytest.mark.asyncio
async def test_moonraker_client_maps_http_status_and_timeout_safely():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    responses = [
        httpx.Response(500, text="secret response body"),
        httpx.ReadTimeout("http://printer.lan/?token=secret"),
    ]

    async def handler(request: httpx.Request):
        response = responses.pop(0)
        if isinstance(response, Exception):
            response.request = request
            raise response
        return response

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(handler),
    )

    with pytest.raises(MoonrakerHTTPError) as status_error:
        await client.get_server_info()
    with pytest.raises(MoonrakerHTTPError) as timeout_error:
        await client.get_server_info()

    assert status_error.value.code == "http_status"
    assert timeout_error.value.code == "timeout"
    assert "secret" not in str(status_error.value)
    assert "secret" not in str(timeout_error.value)


@pytest.mark.asyncio
async def test_moonraker_upload_uses_multipart_gcodes_root_and_returned_path():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/server/files/upload"
        assert request.headers["X-Api-Key"] == "moonraker-secret"
        assert "multipart/form-data" in request.headers["content-type"]
        assert b'name="root"' in request.content and b"gcodes" in request.content
        assert b'name="print"' not in request.content
        assert b'filename="cube.gcode"' in request.content
        return httpx.Response(201, json={"item": {"root": "gcodes", "path": "server-name.gcode"}})

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        api_key="moonraker-secret",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(handler),
    )

    assert await client.upload_gcode(io.BytesIO(b"G28"), filename="cube.gcode", size=3) == "server-name.gcode"


@pytest.mark.asyncio
@pytest.mark.parametrize("filename", ["../cube.gcode", "folder/cube.gcode", "cube.3mf", "cube.gcode\\x00"])
async def test_moonraker_upload_rejects_unsafe_filename_before_request(filename: str):
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    calls = 0

    async def resolver(host: str, port: int):
        nonlocal calls
        calls += 1
        return {ipaddress.ip_address("192.168.1.25")}

    client = MoonrakerHTTPClient(base_url="http://printer.lan:7125", resolver=resolver)

    with pytest.raises(MoonrakerHTTPError, match="invalid_filename"):
        await client.upload_gcode(io.BytesIO(b"G28"), filename=filename, size=3)

    assert calls == 0


@pytest.mark.asyncio
async def test_moonraker_upload_rejects_size_over_limit_before_request(monkeypatch):
    from backend.app.services import moonraker_http
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    monkeypatch.setattr(moonraker_http, "_MAX_UPLOAD_BYTES", 3)
    calls = 0

    async def resolver(host: str, port: int):
        nonlocal calls
        calls += 1
        return {ipaddress.ip_address("192.168.1.25")}

    client = MoonrakerHTTPClient(base_url="http://printer.lan:7125", resolver=resolver)
    with pytest.raises(MoonrakerHTTPError) as error:
        await client.upload_gcode(io.BytesIO(b"G28X"), filename="cube.gcode", size=4)

    assert error.value.code == "upload_too_large"
    assert calls == 0


@pytest.mark.asyncio
async def test_moonraker_upload_streaming_bound_rejects_unknown_oversize_file(monkeypatch):
    from backend.app.services import moonraker_http
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    monkeypatch.setattr(moonraker_http, "_MAX_UPLOAD_BYTES", 3)

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(lambda request: httpx.Response(201, json={"item": {}})),
    )
    with pytest.raises(MoonrakerHTTPError) as error:
        await client.upload_gcode(io.BytesIO(b"G28X"), filename="cube.gcode")

    assert error.value.code == "upload_too_large"


@pytest.mark.asyncio
async def test_moonraker_commands_map_auth_timeout_and_never_retry_mutating_posts():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.method == "POST"
        return httpx.Response(401, text="moonraker-secret")

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        api_key="moonraker-secret",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(handler),
    )
    with pytest.raises(MoonrakerHTTPError) as auth_error:
        await client.pause_print()
    assert auth_error.value.code == "authentication_failed"
    assert calls == 1

    async def timeout(request: httpx.Request):
        raise httpx.ReadTimeout("secret", request=request)

    timeout_client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(timeout),
    )
    with pytest.raises(MoonrakerHTTPError) as timeout_error:
        await timeout_client.emergency_stop()
    assert timeout_error.value.code == "timeout"
    assert "secret" not in str(timeout_error.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "args", "path"),
    [
        ("start_print", ("server-name.gcode",), "/printer/print/start"),
        ("pause_print", (), "/printer/print/pause"),
        ("resume_print", (), "/printer/print/resume"),
        ("cancel_print", (), "/printer/print/cancel"),
    ],
)
async def test_moonraker_print_command_failures_are_safe_and_not_retried(method, args, path):
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    paths = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        return httpx.Response(500, text="moonraker-secret")

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(handler),
    )
    with pytest.raises(MoonrakerHTTPError) as error:
        await getattr(client, method)(*args)

    assert error.value.code == "http_status"
    assert "moonraker-secret" not in str(error.value)
    assert paths == [path]


@pytest.mark.asyncio
async def test_moonraker_client_maps_tls_verification_failure_and_propagates_tls_setting():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    tls_values: list[bool] = []

    async def tls_failure(request: httpx.Request):
        try:
            raise ssl.SSLCertVerificationError("certificate secret")
        except ssl.SSLCertVerificationError as cause:
            raise httpx.ConnectError("https://printer.lan/?token=secret", request=request) from cause

    def transport_factory(host, port, peers, tls_verify):
        tls_values.append(tls_verify)
        return httpx.MockTransport(tls_failure)

    client = MoonrakerHTTPClient(
        base_url="https://printer.lan:7125",
        resolver=resolver,
        transport_factory=transport_factory,
    )

    with pytest.raises(MoonrakerHTTPError) as caught:
        await client.get_server_info()

    assert caught.value.code == "tls_verification_failed"
    assert "secret" not in str(caught.value)
    assert tls_values == [True]


@pytest.mark.asyncio
async def test_moonraker_client_propagates_per_printer_tls_opt_out():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    tls_values: list[bool] = []

    def transport_factory(host, port, peers, tls_verify):
        tls_values.append(tls_verify)
        return httpx.MockTransport(lambda request: httpx.Response(200, content=b"{}"))

    client = MoonrakerHTTPClient(
        base_url="https://printer.lan:7125",
        tls_verify=False,
        resolver=resolver,
        transport_factory=transport_factory,
    )

    await client.get_server_info()

    assert tls_values == [False]


@pytest.mark.asyncio
async def test_moonraker_client_rejects_responses_over_body_limit():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(lambda request: httpx.Response(200, content=b"x" * 65537)),
    )

    with pytest.raises(MoonrakerHTTPError, match="response_too_large"):
        await client.get_server_info()


@pytest.mark.asyncio
async def test_moonraker_client_total_deadline_bounds_dns_resolution(monkeypatch):
    from backend.app.services import moonraker_http
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    monkeypatch.setattr(moonraker_http, "_TOTAL_TIMEOUT_SECONDS", 0.02)

    async def resolver(host: str, port: int):
        await asyncio.Event().wait()

    client = MoonrakerHTTPClient(base_url="http://printer.lan:7125", resolver=resolver)

    with pytest.raises(MoonrakerHTTPError) as caught:
        await client.get_server_info()

    assert caught.value.code == "timeout"


@pytest.mark.asyncio
async def test_moonraker_client_total_deadline_bounds_slow_response_body(monkeypatch):
    from backend.app.services import moonraker_http
    from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError

    monkeypatch.setattr(moonraker_http, "_TOTAL_TIMEOUT_SECONDS", 0.025)

    async def resolver(host: str, port: int):
        return {ipaddress.ip_address("192.168.1.25")}

    class SlowBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            while True:
                await asyncio.sleep(0.015)
                yield b"x"

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        resolver=resolver,
        transport_factory=lambda *_: httpx.MockTransport(lambda request: httpx.Response(200, stream=SlowBody())),
    )

    with pytest.raises(MoonrakerHTTPError) as caught:
        await client.get_server_info()

    assert caught.value.code == "timeout"


@pytest.mark.asyncio
async def test_moonraker_client_uses_httpx_raw_host_canonicalization():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient

    expected_host = "xn--fa-hia.de"
    observed_hosts: list[str] = []

    async def resolver(host: str, port: int):
        observed_hosts.append(host)
        assert (host, port) == (expected_host, 7125)
        return {ipaddress.ip_address("192.168.1.25")}

    def transport_factory(host, port, peers, tls_verify):
        observed_hosts.append(host)

        def handler(request: httpx.Request):
            assert request.url.raw_host == expected_host.encode()
            assert request.headers["Host"] == f"{expected_host}:7125"
            return httpx.Response(200, content=b"{}")

        return httpx.MockTransport(handler)

    client = MoonrakerHTTPClient(
        base_url="https://faß.de:7125",
        resolver=resolver,
        transport_factory=transport_factory,
    )

    await client.get_server_info()

    assert observed_hosts == [expected_host, expected_host]


@pytest.mark.asyncio
async def test_pinned_transport_rejects_a_connected_peer_outside_resolved_set():
    import httpcore

    from backend.app.services.moonraker_http import _PinnedNetworkBackend

    class Stream:
        closed = False

        async def aclose(self):
            self.closed = True

        def get_extra_info(self, name: str):
            return ("192.168.1.99", 7125) if name == "server_addr" else None

    class Backend:
        stream = Stream()

        async def connect_tcp(self, *args):
            return self.stream

        async def sleep(self, seconds: float):
            pass

    backend = _PinnedNetworkBackend("printer.lan", frozenset({ipaddress.ip_address("192.168.1.25")}))
    backend._backend = Backend()

    with pytest.raises(httpcore.ConnectError):
        await backend.connect_tcp("printer.lan", 7125)
    assert backend._backend.stream.closed is True


@pytest.mark.asyncio
async def test_pinned_transport_accepts_ipv4_mapped_connected_peer():
    from backend.app.services.moonraker_http import _PinnedNetworkBackend

    class Stream:
        async def aclose(self):
            pass

        def get_extra_info(self, name: str):
            return ("::ffff:192.168.1.25", 7125) if name == "server_addr" else None

    class Backend:
        stream = Stream()

        async def connect_tcp(self, *args):
            return self.stream

        async def sleep(self, seconds: float):
            pass

    backend = _PinnedNetworkBackend("printer.lan", frozenset({ipaddress.ip_address("192.168.1.25")}))
    backend._backend = Backend()

    assert await backend.connect_tcp("printer.lan", 7125) is backend._backend.stream


@pytest.mark.asyncio
async def test_pinned_backend_bounds_all_peer_attempts_with_one_connect_timeout():
    from backend.app.services.moonraker_http import _PinnedNetworkBackend

    class Backend:
        calls = 0

        async def connect_tcp(self, *args):
            self.calls += 1
            await asyncio.sleep(0.03)
            raise httpcore.ConnectTimeout("peer timed out")

        async def sleep(self, seconds: float):
            pass

    connector = Backend()
    backend = _PinnedNetworkBackend(
        "printer.lan",
        frozenset(
            {
                ipaddress.ip_address("192.168.1.25"),
                ipaddress.ip_address("192.168.1.26"),
                ipaddress.ip_address("192.168.1.27"),
            }
        ),
        backend=connector,
    )
    started = time.monotonic()

    with pytest.raises(httpcore.ConnectTimeout):
        await backend.connect_tcp("printer.lan", 7125, timeout=0.04)

    assert time.monotonic() - started < 0.08
    assert connector.calls == 2


@pytest.mark.asyncio
async def test_pinned_transport_connect_timeout_maps_to_safe_timeout():
    from backend.app.services.moonraker_http import (
        MoonrakerHTTPClient,
        MoonrakerHTTPError,
        _PinnedHTTPTransport,
        _PinnedNetworkBackend,
    )

    peer = ipaddress.ip_address("192.168.1.25")

    async def resolver(host: str, port: int):
        return {peer}

    class TimeoutBackend(httpcore.AsyncNetworkBackend):
        async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
            raise httpcore.ConnectTimeout("secret connection detail")

        async def connect_unix_socket(self, path, timeout=None, socket_options=None):
            raise AssertionError("unexpected unix socket")

        async def sleep(self, seconds):
            pass

    def transport_factory(host, port, peers, tls_verify):
        return _PinnedHTTPTransport(
            tls_verify=tls_verify,
            network_backend=_PinnedNetworkBackend(host, peers, backend=TimeoutBackend()),
        )

    client = MoonrakerHTTPClient(
        base_url="http://printer.lan:7125",
        resolver=resolver,
        transport_factory=transport_factory,
    )

    with pytest.raises(MoonrakerHTTPError) as caught:
        await client.get_server_info()

    assert caught.value.code == "timeout"
    assert "secret" not in str(caught.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("url", "expected_backend_host", "tls_verify", "expected_host", "expected_sni", "expected_verify_mode"),
    [
        ("http://printer.lan:7125/server/info", "printer.lan", True, "printer.lan", None, None),
        (
            "https://printer.lan:7125/server/info",
            "printer.lan",
            True,
            "printer.lan",
            "printer.lan",
            ssl.CERT_REQUIRED,
        ),
        (
            "https://printer.lan:7125/server/info",
            "printer.lan",
            False,
            "printer.lan",
            "printer.lan",
            ssl.CERT_NONE,
        ),
        (
            "https://prínter.lan:7125/server/info",
            "xn--prnter-4va.lan",
            True,
            "xn--prnter-4va.lan",
            "xn--prnter-4va.lan",
            ssl.CERT_REQUIRED,
        ),
        (
            "https://faß.de:7125/server/info",
            "xn--fa-hia.de",
            True,
            "xn--fa-hia.de",
            "xn--fa-hia.de",
            ssl.CERT_REQUIRED,
        ),
    ],
)
async def test_public_pinned_transport_wires_http_https_sni_and_peer(
    url: str,
    expected_backend_host: str,
    tls_verify: bool,
    expected_host: str,
    expected_sni: str | None,
    expected_verify_mode: ssl.VerifyMode | None,
):
    from backend.app.services.moonraker_http import _PinnedHTTPTransport, _PinnedNetworkBackend

    class ProtocolStream(httpcore.AsyncNetworkStream):
        def __init__(self):
            self.writes: list[bytes] = []
            self.response_sent = False
            self.sni: str | None = None
            self.verify_mode: ssl.VerifyMode | None = None

        async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
            if self.response_sent:
                return b""
            self.response_sent = True
            return b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"

        async def write(self, buffer: bytes, timeout: float | None = None) -> None:
            self.writes.append(buffer)

        async def aclose(self) -> None:
            pass

        async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
            self.sni = server_hostname
            self.verify_mode = ssl_context.verify_mode
            return self

        def get_extra_info(self, name: str):
            if name == "server_addr":
                return ("::ffff:192.168.1.25", 7125)
            if name == "is_readable":
                return False
            return None

    class Connector(httpcore.AsyncNetworkBackend):
        def __init__(self):
            self.stream = ProtocolStream()
            self.connections: list[tuple[str, int]] = []

        async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
            self.connections.append((host, port))
            return self.stream

        async def connect_unix_socket(self, path, timeout=None, socket_options=None):
            raise AssertionError("unexpected unix socket")

        async def sleep(self, seconds):
            pass

    connector = Connector()
    backend = _PinnedNetworkBackend(
        expected_backend_host,
        frozenset({ipaddress.ip_address("192.168.1.25")}),
        backend=connector,
    )
    transport = _PinnedHTTPTransport(tls_verify=tls_verify, network_backend=backend)

    async with httpx.AsyncClient(transport=transport) as client:
        response = await client.get(url)

    assert response.status_code == 200
    assert connector.connections == [("192.168.1.25", 7125)]
    assert f"Host: {expected_host}:7125".encode() in b"".join(connector.stream.writes)
    assert connector.stream.sni == expected_sni
    assert connector.stream.verify_mode == expected_verify_mode
