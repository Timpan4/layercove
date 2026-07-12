import ipaddress

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
async def test_moonraker_client_maps_api_key_and_disables_redirects():
    from backend.app.services.moonraker_http import MoonrakerHTTPClient

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

    result = await client.get_server_info()

    assert result.status_code == 302
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
