import asyncio
import socket

import pytest
from aiohttp import web

from backend.app.services.moonraker_websocket import (
    MoonrakerWebSocketError,
    _approved_peers,
    _PinnedResolver,
    moonraker_websocket_url,
)


def test_moonraker_websocket_url_derives_only_backend_endpoint():
    assert moonraker_websocket_url("https://klipper.local:7125") == "wss://klipper.local:7125/websocket"
    assert (
        moonraker_websocket_url("http://klipper.local:7125", "ws://klipper.local:7125/custom")
        == "ws://klipper.local:7125/custom"
    )


def test_moonraker_websocket_url_revalidates_stored_base_url():
    with pytest.raises(ValueError, match="base URL"):
        moonraker_websocket_url("ftp://klipper.local")


@pytest.mark.parametrize(
    ("base_url", "override"),
    [
        ("http://klipper.local:7125", "ws://attacker.example:7125/websocket"),
        ("http://klipper.local:7125", "ws://klipper.local:7126/websocket"),
        ("https://klipper.local:7125", "ws://klipper.local:7125/websocket"),
    ],
)
def test_moonraker_websocket_override_cannot_change_origin_or_downgrade_tls(base_url, override):
    with pytest.raises(ValueError):
        moonraker_websocket_url(base_url, override)


@pytest.mark.parametrize(
    "url",
    [
        "ws://user:secret@klipper.local/websocket",
        "ws://klipper.local/websocket?token=secret",
        "https://klipper.local/websocket",
    ],
)
def test_moonraker_websocket_url_rejects_credential_or_non_websocket_urls(url):
    with pytest.raises(ValueError):
        moonraker_websocket_url("http://klipper.local", url)


def test_moonraker_websocket_rejects_any_blocked_dns_answer():
    with pytest.raises(MoonrakerWebSocketError, match="unsafe_target"):
        _approved_peers(["192.168.1.10", "127.0.0.1"])


@pytest.mark.asyncio
async def test_pinned_websocket_resolver_returns_every_approved_answer_and_rejects_new_host():
    resolver = _PinnedResolver("klipper.local", _approved_peers(["192.168.1.10", "2001:db8::1"]))

    answers = await resolver.resolve("klipper.local", 7125, socket.AF_UNSPEC)

    assert {answer["host"] for answer in answers} == {"192.168.1.10", "2001:db8::1"}
    with pytest.raises(OSError, match="unexpected connection host"):
        await resolver.resolve("metadata.google.internal", 80)


@pytest.mark.asyncio
async def test_websocket_transport_handshake_auth_and_pinned_local_peer(monkeypatch):
    from backend.app.services import moonraker_websocket

    received_headers = []

    async def handler(request):
        received_headers.append(request.headers.get("X-Api-Key"))
        websocket = web.WebSocketResponse()
        await websocket.prepare(request)
        message = await websocket.receive_json()
        await websocket.send_json({"echo": message})
        return websocket

    app = web.Application()
    app.router.add_get("/websocket", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    async def resolver(host, resolved_port):
        assert (host, resolved_port) == ("printer.test", port)
        return ["127.0.0.1"]

    monkeypatch.setattr(moonraker_websocket, "_is_safe_peer", lambda _: True)
    transport = moonraker_websocket.MoonrakerWebSocketTransport(
        base_url=f"http://printer.test:{port}",
        api_key="stored-secret",
        resolver=resolver,
    )
    try:
        connection = await transport.connect()
        await connection.send_json({"status": "ping"})
        assert await connection.receive_json() == {"echo": {"status": "ping"}}
        with pytest.raises(MoonrakerWebSocketError, match="disconnected"):
            await connection.receive_json()
        await connection.close()

        reconnected = await transport.connect()
        await reconnected.send_json({"status": "reconnected"})
        assert await reconnected.receive_json() == {"echo": {"status": "reconnected"}}
        assert received_headers == ["stored-secret", "stored-secret"]
        await reconnected.close()
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_websocket_transport_rejects_redirect_before_forwarding_auth(monkeypatch):
    from backend.app.services import moonraker_websocket

    redirected_requests = []

    async def redirected_handler(request):
        redirected_requests.append(request.headers.get("X-Api-Key"))
        return web.Response(status=400)

    redirected_app = web.Application()
    redirected_app.router.add_get("/websocket", redirected_handler)
    redirected_runner = web.AppRunner(redirected_app)
    await redirected_runner.setup()
    redirected_site = web.TCPSite(redirected_runner, "127.0.0.1", 0)
    await redirected_site.start()
    redirected_port = redirected_site._server.sockets[0].getsockname()[1]

    async def approved_handler(_request):
        raise web.HTTPFound(location=f"http://printer.test:{redirected_port}/websocket")

    approved_app = web.Application()
    approved_app.router.add_get("/websocket", approved_handler)
    approved_runner = web.AppRunner(approved_app)
    await approved_runner.setup()
    approved_site = web.TCPSite(approved_runner, "127.0.0.1", 0)
    await approved_site.start()
    approved_port = approved_site._server.sockets[0].getsockname()[1]

    async def resolver(host, port):
        assert host == "printer.test"
        assert port == approved_port
        return ["127.0.0.1"]

    real_client_session = moonraker_websocket.aiohttp.ClientSession
    sessions = []

    def client_session(**kwargs):
        session = real_client_session(**kwargs)
        sessions.append(session)
        return session

    monkeypatch.setattr(moonraker_websocket, "_is_safe_peer", lambda _: True)
    monkeypatch.setattr(moonraker_websocket.aiohttp, "ClientSession", client_session)
    transport = moonraker_websocket.MoonrakerWebSocketTransport(
        base_url=f"http://printer.test:{approved_port}",
        api_key="must-not-be-forwarded",
        resolver=resolver,
    )
    try:
        with pytest.raises(MoonrakerWebSocketError, match="redirect_not_allowed"):
            await transport.connect()

        assert redirected_requests == []
        assert sessions and all(session.closed for session in sessions)
    finally:
        await approved_runner.cleanup()
        await redirected_runner.cleanup()


@pytest.mark.asyncio
async def test_cancelled_websocket_handshake_closes_client_session(monkeypatch):
    from backend.app.services import moonraker_websocket

    started = asyncio.Event()

    class Session:
        closed = False

        async def ws_connect(self, *args, **kwargs):
            started.set()
            await asyncio.Future()

        async def close(self):
            self.closed = True

    session = Session()
    monkeypatch.setattr(moonraker_websocket.aiohttp, "TCPConnector", lambda **_: object())
    monkeypatch.setattr(moonraker_websocket.aiohttp, "ClientSession", lambda **_: session)
    monkeypatch.setattr(moonraker_websocket, "_approved_peers", lambda _: frozenset({object()}))
    transport = moonraker_websocket.MoonrakerWebSocketTransport(
        base_url="http://printer.test:7125",
        resolver=lambda *_: asyncio.sleep(0, result=["192.168.1.2"]),
    )

    task = asyncio.create_task(transport.connect())
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert session.closed is True


@pytest.mark.asyncio
async def test_websocket_heartbeat_closes_silent_peer(monkeypatch):
    from backend.app.services import moonraker_websocket

    ping_seen = asyncio.Event()
    release_server = asyncio.Event()

    async def handler(request):
        websocket = web.WebSocketResponse(autoping=False)
        await websocket.prepare(request)
        message = await websocket.receive()
        if message.type is web.WSMsgType.PING:
            ping_seen.set()
        await release_server.wait()
        return websocket

    app = web.Application()
    app.router.add_get("/websocket", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    async def resolver(*_):
        return ["127.0.0.1"]

    monkeypatch.setattr(moonraker_websocket, "_is_safe_peer", lambda _: True)
    transport = moonraker_websocket.MoonrakerWebSocketTransport(
        base_url=f"http://printer.test:{port}", resolver=resolver, heartbeat=0.01
    )
    try:
        connection = await transport.connect()
        await asyncio.wait_for(ping_seen.wait(), timeout=0.2)
        with pytest.raises(MoonrakerWebSocketError, match="disconnected"):
            await asyncio.wait_for(connection.receive_json(), timeout=0.2)
        await connection.close()
    finally:
        release_server.set()
        await runner.cleanup()
