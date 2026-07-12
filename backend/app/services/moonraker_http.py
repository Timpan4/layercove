"""Safe, bounded HTTP client for one stored Moonraker origin."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpcore
import httpx

from backend.app.api.routes._url_safety import CLOUD_METADATA_IPS, unwrap_ipv4_mapped

_MAX_RESPONSE_BYTES = 64 * 1024
_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=10.0, pool=5.0)

Resolver = Callable[[str, int], Awaitable[Iterable[str | ipaddress.IPv4Address | ipaddress.IPv6Address]]]
TransportFactory = Callable[[str, int, frozenset[ipaddress._BaseAddress], bool], httpx.AsyncBaseTransport]


class MoonrakerHTTPError(Exception):
    """A safe error suitable for API responses and logs."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


@dataclass(frozen=True)
class MoonrakerHTTPResponse:
    status_code: int
    headers: dict[str, str]
    body: bytes


def _is_safe_peer(address: ipaddress._BaseAddress) -> bool:
    address = unwrap_ipv4_mapped(address)
    return not (
        address in CLOUD_METADATA_IPS
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
    )


async def resolve_moonraker_host(host: str, port: int) -> frozenset[ipaddress._BaseAddress]:
    """Resolve host once per request; reject every blocked result, not only chosen one."""
    try:
        records = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise MoonrakerHTTPError("unavailable", "Moonraker host could not be resolved.") from exc

    peers = frozenset(unwrap_ipv4_mapped(ipaddress.ip_address(record[4][0])) for record in records)
    if not peers or any(not _is_safe_peer(peer) for peer in peers):
        raise MoonrakerHTTPError("unsafe_target", "Moonraker host resolved to a blocked address.")
    return peers


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Connect only to addresses approved by the resolver for this request."""

    def __init__(self, host: str, peers: frozenset[ipaddress._BaseAddress]):
        self._host = host.lower()
        self._peers = peers
        from httpcore._backends.anyio import AnyIOBackend

        self._backend = AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ):
        if host.lower() != self._host:
            raise httpcore.ConnectError("unexpected connection host")

        for peer in sorted(self._peers, key=str):
            try:
                stream = await self._backend.connect_tcp(str(peer), port, timeout, local_address, socket_options)
                connected = stream.get_extra_info("server_addr")
                if not connected or ipaddress.ip_address(connected[0]) not in self._peers:
                    await stream.aclose()
                    continue
                return stream
            except httpcore.NetworkError:
                continue
        raise httpcore.ConnectError("approved Moonraker peer was unavailable")

    async def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options: Any = None):
        raise httpcore.ConnectError("unix sockets are not supported")

    async def sleep(self, seconds: float) -> None:
        await self._backend.sleep(seconds)


def _pinned_transport(
    host: str,
    port: int,
    peers: frozenset[ipaddress._BaseAddress],
    tls_verify: bool,
) -> httpx.AsyncBaseTransport:
    """Build an httpx transport with DNS-pinned TCP connections and no proxy."""
    transport = httpx.AsyncHTTPTransport(
        verify=tls_verify,
        trust_env=False,
        limits=httpx.Limits(max_connections=1, max_keepalive_connections=0),
        retries=0,
    )
    ssl_context = transport._pool._ssl_context  # type: ignore[attr-defined]
    transport._pool = httpcore.AsyncConnectionPool(  # type: ignore[attr-defined]
        ssl_context=ssl_context,
        max_connections=1,
        max_keepalive_connections=0,
        retries=0,
        network_backend=_PinnedNetworkBackend(host, peers),
    )
    return transport


class MoonrakerHTTPClient:
    """Only exposes focused Moonraker probes; browser-supplied URLs never enter here."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None = None,
        authorization: str | None = None,
        tls_verify: bool = True,
        resolver: Resolver = resolve_moonraker_host,
        transport_factory: TransportFactory = _pinned_transport,
    ):
        if api_key is not None and authorization is not None:
            raise ValueError("api_key and authorization are mutually exclusive")
        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Moonraker base URL must be an HTTP(S) origin")
        self._base_url = base_url.rstrip("/")
        self._host = parsed.hostname
        self._port = parsed.port or (443 if parsed.scheme == "https" else 80)
        self._api_key = api_key
        self._authorization = authorization
        self._tls_verify = tls_verify
        self._resolver = resolver
        self._transport_factory = transport_factory

    async def get_server_info(self) -> MoonrakerHTTPResponse:
        """Probe Moonraker's documented read-only server-info endpoint."""
        return await self._request("/server/info")

    async def test_connection(self) -> bool:
        response = await self.get_server_info()
        return 200 <= response.status_code < 300

    async def _request(self, path: str) -> MoonrakerHTTPResponse:
        peers = frozenset(
            unwrap_ipv4_mapped(ipaddress.ip_address(peer)) for peer in await self._resolver(self._host, self._port)
        )
        if not peers or any(not _is_safe_peer(peer) for peer in peers):
            raise MoonrakerHTTPError("unsafe_target", "Moonraker host resolved to a blocked address.")

        headers: dict[str, str] = {}
        if self._api_key is not None:
            headers["X-Api-Key"] = self._api_key
        elif self._authorization is not None:
            headers["Authorization"] = self._authorization

        transport = self._transport_factory(self._host, self._port, peers, self._tls_verify)
        try:
            async with (
                httpx.AsyncClient(
                    transport=transport,
                    timeout=_TIMEOUT,
                    follow_redirects=False,
                    trust_env=False,
                ) as client,
                client.stream("GET", f"{self._base_url}{path}", headers=headers) as response,
            ):
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > _MAX_RESPONSE_BYTES:
                        raise MoonrakerHTTPError("response_too_large", "Moonraker response exceeded size limit.")
                return MoonrakerHTTPResponse(response.status_code, dict(response.headers), bytes(body))
        except MoonrakerHTTPError:
            raise
        except httpx.TimeoutException as exc:
            raise MoonrakerHTTPError("timeout", "Moonraker connection timed out.") from exc
        except httpx.HTTPError as exc:
            raise MoonrakerHTTPError("unavailable", "Moonraker connection failed.") from exc
