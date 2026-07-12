import asyncio
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
            "prínter.lan",
            True,
            "xn--prnter-4va.lan",
            "xn--prnter-4va.lan",
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
