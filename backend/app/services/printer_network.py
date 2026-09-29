"""Shared destination policy for backend-owned printer network traffic."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import AsyncGenerator, Awaitable, Callable, Iterable
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver

from backend.app.api.routes._url_safety import CLOUD_METADATA_IPS, unwrap_ipv4_mapped

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Resolver = Callable[[str, int], Awaitable[Iterable[str | IPAddress]]]


class PrinterNetworkError(Exception):
    """Safe destination-policy failure."""

    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}")


def is_safe_peer(address: IPAddress) -> bool:
    address = unwrap_ipv4_mapped(address)
    return not (
        address in CLOUD_METADATA_IPS
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
    )


def approved_peers(values: Iterable[str | IPAddress]) -> frozenset[IPAddress]:
    peers = frozenset(unwrap_ipv4_mapped(ipaddress.ip_address(value)) for value in values)
    if not peers or any(not is_safe_peer(peer) for peer in peers):
        raise PrinterNetworkError("unsafe_target", "Printer host resolved to a blocked address.")
    return peers


async def resolve_printer_host(host: str, port: int) -> frozenset[IPAddress]:
    """Resolve once; reject request when any DNS answer is unsafe."""
    try:
        records = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise PrinterNetworkError("unavailable", "Printer host could not be resolved.") from exc
    return approved_peers(record[4][0] for record in records)


class PinnedResolver(AbstractResolver):
    """Return only DNS answers approved before connection."""

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


def connected_peer(response: object) -> IPAddress | None:
    connection = getattr(response, "connection", None)
    transport = getattr(connection, "transport", None)
    peer = transport.get_extra_info("peername") if transport is not None else None
    try:
        return unwrap_ipv4_mapped(ipaddress.ip_address(peer[0])) if peer else None
    except ValueError:
        return None


@asynccontextmanager
async def trusted_http_response(
    url: str,
    *,
    timeout: float | aiohttp.ClientTimeout | None,
) -> AsyncGenerator[aiohttp.ClientResponse, None]:
    """Open one pinned HTTP request with redirect and connected-peer checks."""
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise PrinterNetworkError("unsafe_target", "Printer URL must use HTTP or HTTPS.")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    peers = await resolve_printer_host(parsed.hostname, port)
    client_timeout = timeout if isinstance(timeout, aiohttp.ClientTimeout) else aiohttp.ClientTimeout(total=timeout)
    connector = aiohttp.TCPConnector(
        resolver=PinnedResolver(parsed.hostname, peers),
        limit=1,
        force_close=True,
    )
    async with (
        aiohttp.ClientSession(
            connector=connector,
            timeout=client_timeout,
            trust_env=False,
        ) as session,
        session.get(url, allow_redirects=False) as response,
    ):
        if 300 <= response.status < 400:
            raise PrinterNetworkError("redirect_blocked", "Printer HTTP redirects are blocked.")
        if connected_peer(response) not in peers:
            raise PrinterNetworkError("peer_mismatch", "Connected printer peer did not match approved DNS results.")
        yield response
