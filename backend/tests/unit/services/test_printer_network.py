from unittest.mock import patch

import pytest


class _Transport:
    def __init__(self, peer: str):
        self._peer = peer

    def get_extra_info(self, name: str):
        return (self._peer, 80) if name == "peername" else None


class _Connection:
    def __init__(self, peer: str):
        self.transport = _Transport(peer)


class _Response:
    def __init__(self, peer: str, status: int = 200):
        self.connection = _Connection(peer)
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


class _Session:
    get_kwargs: dict | None = None
    peer = "192.168.1.20"
    status = 200

    def __init__(self, *_, **__):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    def get(self, _url: str, **kwargs):
        type(self).get_kwargs = kwargs
        return _Response(type(self).peer, type(self).status)


@pytest.mark.asyncio
async def test_trusted_http_response_pins_peer_and_disables_redirects():
    from backend.app.services import printer_network

    async def resolve(_host: str, _port: int):
        return frozenset({printer_network.ipaddress.ip_address("192.168.1.20")})

    with (
        patch.object(printer_network, "resolve_printer_host", resolve),
        patch.object(printer_network.aiohttp, "ClientSession", _Session),
    ):
        async with printer_network.trusted_http_response("http://camera.local/frame", timeout=5) as response:
            assert response.status == 200

    assert _Session.get_kwargs == {"allow_redirects": False}


def test_approved_peers_rejects_mixed_safe_and_blocked_answers():
    from backend.app.services.printer_network import PrinterNetworkError, approved_peers

    with pytest.raises(PrinterNetworkError, match="unsafe_target"):
        approved_peers(["192.168.1.20", "127.0.0.1"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("peer", "status", "error_code"),
    [
        ("192.168.1.21", 200, "peer_mismatch"),
        ("192.168.1.20", 302, "redirect_blocked"),
    ],
)
async def test_trusted_http_response_rejects_untrusted_result(peer: str, status: int, error_code: str):
    from backend.app.services import printer_network

    async def resolve(_host: str, _port: int):
        return frozenset({printer_network.ipaddress.ip_address("192.168.1.20")})

    _Session.peer = peer
    _Session.status = status
    try:
        with (
            patch.object(printer_network, "resolve_printer_host", resolve),
            patch.object(printer_network.aiohttp, "ClientSession", _Session),
            pytest.raises(printer_network.PrinterNetworkError, match=error_code),
        ):
            async with printer_network.trusted_http_response("http://camera.local/frame", timeout=5):
                pass
    finally:
        _Session.peer = "192.168.1.20"
        _Session.status = 200
