import socket

import pytest

from backend.app.services.moonraker_websocket import (
    MoonrakerWebSocketError,
    _approved_peers,
    _PinnedResolver,
    moonraker_websocket_url,
)


def test_moonraker_websocket_url_derives_only_backend_endpoint():
    assert moonraker_websocket_url("https://klipper.local:7125") == "wss://klipper.local:7125/websocket"
    assert moonraker_websocket_url("http://klipper.local:7125", "ws://klipper.local/custom") == "ws://klipper.local/custom"


def test_moonraker_websocket_url_revalidates_stored_base_url():
    with pytest.raises(ValueError, match="base URL"):
        moonraker_websocket_url("ftp://klipper.local")


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
