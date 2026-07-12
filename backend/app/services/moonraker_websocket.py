"""Pinned Moonraker WebSocket transport for backend-owned live status."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import aiohttp
from aiohttp.abc import AbstractResolver

from backend.app.services.moonraker_http import (
    IPAddress,
    Resolver,
    _is_safe_peer,
    resolve_moonraker_host,
    unwrap_ipv4_mapped,
)

_MAX_MESSAGE_BYTES = 64 * 1024
_TOTAL_TIMEOUT_SECONDS = 10.0


class MoonrakerWebSocketError(Exception):
    """Safe transport error; never includes configured credentials or URL text."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


def moonraker_websocket_url(base_url: str, override: str | None = None) -> str:
    """Build or revalidate the single configured Moonraker WebSocket endpoint."""
    base = urlsplit(base_url)
    if (
        base.scheme not in {"http", "https"}
        or not base.hostname
        or base.username is not None
        or base.password is not None
        or base.path not in {"", "/"}
        or base.query
        or base.fragment
    ):
        raise ValueError("Moonraker base URL must be an HTTP(S) origin")
    value = override
    if value is None:
        scheme = "wss" if base.scheme == "https" else "ws"
        value = urlunsplit((scheme, base.netloc, "/websocket", "", ""))
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"ws", "wss"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Moonraker WebSocket URL must be a credential-free WS(S) URL")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/websocket", "", ""))


class _PinnedResolver(AbstractResolver):
    """Only returns already-approved DNS answers for this WebSocket connection."""

    def __init__(self, host: str, peers: frozenset[IPAddress]):
        self._host = host.lower()
        self._peers = peers

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_UNSPEC) -> list[dict[str, Any]]:
        if host.lower() != self._host:
            raise OSError("unexpected connection host")
        return [
            {
                "hostname": host,
                "host": str(peer),
                "port": port,
                "family": socket.AF_INET6 if peer.version == 6 else socket.AF_INET,
                "proto": 0,
                "flags": 0,
            }
            for peer in sorted(self._peers, key=str)
            if family in {socket.AF_UNSPEC, socket.AF_INET6 if peer.version == 6 else socket.AF_INET}
        ]

    async def close(self) -> None:
        return None


def _approved_peers(values: Iterable[str | IPAddress]) -> frozenset[IPAddress]:
    peers = frozenset(unwrap_ipv4_mapped(ipaddress.ip_address(value)) for value in values)
    if not peers or any(not _is_safe_peer(peer) for peer in peers):
        raise MoonrakerWebSocketError("unsafe_target", "Moonraker host resolved to a blocked address.")
    return peers


def _connected_peer(websocket: aiohttp.ClientWebSocketResponse) -> IPAddress | None:
    response = websocket._response  # aiohttp has no public peer accessor for client WebSockets.
    connection = response.connection
    transport = connection.transport if connection is not None else None
    peer = transport.get_extra_info("peername") if transport is not None else None
    try:
        return unwrap_ipv4_mapped(ipaddress.ip_address(peer[0])) if peer else None
    except ValueError:
        return None


class MoonrakerWebSocket:
    """Small wrapper that owns both aiohttp session and its WebSocket."""

    def __init__(self, session: aiohttp.ClientSession, websocket: aiohttp.ClientWebSocketResponse):
        self._session = session
        self._websocket = websocket

    async def send_json(self, data: dict[str, Any]) -> None:
        await self._websocket.send_json(data)

    async def receive_json(self) -> dict[str, Any]:
        message = await self._websocket.receive()
        if message.type is aiohttp.WSMsgType.TEXT:
            try:
                data = message.json()
            except (TypeError, ValueError) as exc:
                raise MoonrakerWebSocketError("malformed_message", "Moonraker sent an invalid WebSocket message.") from exc
            if not isinstance(data, dict):
                raise MoonrakerWebSocketError("malformed_message", "Moonraker sent an invalid WebSocket message.")
            return data
        if message.type is aiohttp.WSMsgType.ERROR:
            raise MoonrakerWebSocketError("unavailable", "Moonraker WebSocket disconnected.") from self._websocket.exception()
        raise MoonrakerWebSocketError("unavailable", "Moonraker WebSocket disconnected.")

    async def close(self) -> None:
        await self._websocket.close()
        await self._session.close()


class MoonrakerWebSocketTransport:
    """Resolve every answer, pin connection peers, and preserve per-printer TLS/auth."""

    def __init__(
        self,
        *,
        base_url: str,
        websocket_url_override: str | None = None,
        api_key: str | None = None,
        authorization: str | None = None,
        tls_verify: bool = True,
        resolver: Resolver = resolve_moonraker_host,
    ):
        if api_key is not None and authorization is not None:
            raise ValueError("api_key and authorization are mutually exclusive")
        self._url = moonraker_websocket_url(base_url, websocket_url_override)
        parsed = urlsplit(self._url)
        self._host = parsed.hostname or ""
        self._port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        self._api_key = api_key
        self._authorization = authorization
        self._tls_verify = tls_verify
        self._resolver = resolver

    async def connect(self) -> MoonrakerWebSocket:
        try:
            async with asyncio.timeout(_TOTAL_TIMEOUT_SECONDS):
                peers = _approved_peers(await self._resolver(self._host, self._port))
                connector = aiohttp.TCPConnector(
                    resolver=_PinnedResolver(self._host, peers),
                    ssl=self._tls_verify,
                    limit=1,
                    force_close=True,
                )
                headers = {"X-Api-Key": self._api_key} if self._api_key is not None else {}
                if self._authorization is not None:
                    headers["Authorization"] = self._authorization
                session = aiohttp.ClientSession(
                    connector=connector,
                    timeout=aiohttp.ClientTimeout(total=_TOTAL_TIMEOUT_SECONDS),
                    trust_env=False,
                )
                try:
                    websocket = await session.ws_connect(
                        self._url,
                        headers=headers,
                        max_msg_size=_MAX_MESSAGE_BYTES,
                    )
                    if _connected_peer(websocket) not in peers:
                        await websocket.close()
                        raise MoonrakerWebSocketError("unsafe_target", "Moonraker connected to an unapproved address.")
                    return MoonrakerWebSocket(session, websocket)
                except Exception:
                    await session.close()
                    raise
        except MoonrakerWebSocketError:
            raise
        except TimeoutError as exc:
            raise MoonrakerWebSocketError("timeout", "Moonraker did not respond before timeout.") from exc
        except (aiohttp.ClientConnectorCertificateError, aiohttp.ClientConnectorSSLError) as exc:
            raise MoonrakerWebSocketError(
                "tls_verification_failed",
                "Moonraker TLS certificate verification failed. Trust it or disable TLS verification for this printer.",
            ) from exc
        except aiohttp.WSServerHandshakeError as exc:
            if exc.status in {401, 403}:
                raise MoonrakerWebSocketError(
                    "authentication_failed", "Moonraker rejected configured credentials."
                ) from exc
            raise MoonrakerWebSocketError("unavailable", "Could not connect to Moonraker.") from exc
        except aiohttp.ClientError as exc:
            raise MoonrakerWebSocketError("unavailable", "Could not connect to Moonraker.") from exc
