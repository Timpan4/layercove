"""Safe, bounded HTTP client for one stored Moonraker origin."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import ssl
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, BinaryIO
from urllib.parse import urlsplit

import anyio
import httpcore
import httpx

from backend.app.api.routes._url_safety import CLOUD_METADATA_IPS, unwrap_ipv4_mapped
from backend.app.utils.filename import InvalidFilenameError, validate_moonraker_gcode_basename

_MAX_RESPONSE_BYTES = 64 * 1024
_MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024
_TOTAL_TIMEOUT_SECONDS = 10.0
_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=10.0, pool=5.0)

Resolver = Callable[[str, int], Awaitable[Iterable[str | ipaddress.IPv4Address | ipaddress.IPv6Address]]]
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
TransportFactory = Callable[[str, int, frozenset[IPAddress], bool], httpx.AsyncBaseTransport]


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


class _BoundedUpload:
    """Limit synchronous multipart reads without buffering a G-code in memory."""

    def __init__(self, file: BinaryIO, size: int | None):
        self._file = file
        self._remaining = _MAX_UPLOAD_BYTES
        if size is not None:
            if not isinstance(size, int) or size < 0 or size > _MAX_UPLOAD_BYTES:
                raise MoonrakerHTTPError("upload_too_large", "G-code upload exceeds size limit.")
            self._remaining = size

    def read(self, size: int = -1) -> bytes:
        if self._remaining <= 0:
            extra = self._file.read(1)
            if extra:
                raise MoonrakerHTTPError("upload_too_large", "G-code upload exceeds size limit.")
            return b""
        chunk = self._file.read(self._remaining if size < 0 else min(size, self._remaining))
        if not isinstance(chunk, bytes):
            raise MoonrakerHTTPError("invalid_upload", "G-code upload could not be read.")
        self._remaining -= len(chunk)
        return chunk


def _is_safe_peer(address: IPAddress) -> bool:
    address = unwrap_ipv4_mapped(address)
    return not (
        address in CLOUD_METADATA_IPS
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
    )


async def resolve_moonraker_host(host: str, port: int) -> frozenset[IPAddress]:
    """Resolve host once per request; reject every blocked result, not only chosen one."""
    try:
        records = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise MoonrakerHTTPError("unavailable", "Moonraker host could not be resolved.") from exc

    peers = frozenset(unwrap_ipv4_mapped(ipaddress.ip_address(record[4][0])) for record in records)
    if not peers or any(not _is_safe_peer(peer) for peer in peers):
        raise MoonrakerHTTPError("unsafe_target", "Moonraker host resolved to a blocked address.")
    return peers


class _TLSVerificationError(Exception):
    pass


def _caused_by_tls_verification(exc: BaseException) -> bool:
    current: BaseException | None = exc
    while current is not None:
        if isinstance(current, (ssl.SSLCertVerificationError, _TLSVerificationError)):
            return True
        current = current.__cause__ or current.__context__
    return False


class _AnyIOStream(httpcore.AsyncNetworkStream):
    """Public AnyIO adapter for httpcore's public network-stream contract."""

    def __init__(self, stream: anyio.abc.ByteStream):
        self._stream = stream

    async def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        try:
            with anyio.fail_after(timeout):
                return await self._stream.receive(max_bytes=max_bytes)
        except anyio.EndOfStream:
            return b""
        except TimeoutError as exc:
            raise httpcore.ReadTimeout("Moonraker read timed out") from exc
        except (OSError, anyio.BrokenResourceError, anyio.ClosedResourceError) as exc:
            raise httpcore.ReadError("Moonraker read failed") from exc

    async def write(self, buffer: bytes, timeout: float | None = None) -> None:
        if not buffer:
            return
        try:
            with anyio.fail_after(timeout):
                await self._stream.send(buffer)
        except TimeoutError as exc:
            raise httpcore.WriteTimeout("Moonraker write timed out") from exc
        except (OSError, anyio.BrokenResourceError, anyio.ClosedResourceError) as exc:
            raise httpcore.WriteError("Moonraker write failed") from exc

    async def aclose(self) -> None:
        await self._stream.aclose()

    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        try:
            with anyio.fail_after(timeout):
                stream = await anyio.streams.tls.TLSStream.wrap(
                    self._stream,
                    ssl_context=ssl_context,
                    hostname=server_hostname,
                    standard_compatible=False,
                    server_side=False,
                )
        except Exception as exc:
            await self.aclose()
            if _caused_by_tls_verification(exc):
                raise _TLSVerificationError("Moonraker certificate verification failed") from exc
            if isinstance(exc, TimeoutError):
                raise httpcore.ConnectTimeout("Moonraker TLS handshake timed out") from exc
            raise httpcore.ConnectError("Moonraker TLS handshake failed") from exc
        return _AnyIOStream(stream)

    def get_extra_info(self, name: str):
        if name == "ssl_object":
            return self._stream.extra(anyio.streams.tls.TLSAttribute.ssl_object, None)
        if name == "client_addr":
            return self._stream.extra(anyio.abc.SocketAttribute.local_address, None)
        if name == "server_addr":
            return self._stream.extra(anyio.abc.SocketAttribute.remote_address, None)
        if name == "socket":
            return self._stream.extra(anyio.abc.SocketAttribute.raw_socket, None)
        if name == "is_readable":
            return False
        return None


class _AnyIONetworkBackend(httpcore.AsyncNetworkBackend):
    """Public AnyIO adapter for httpcore's public network-backend contract."""

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        try:
            with anyio.fail_after(timeout):
                stream = await anyio.connect_tcp(host, port, local_host=local_address)
            for option in socket_options or ():
                raw_socket = stream.extra(anyio.abc.SocketAttribute.raw_socket)
                raw_socket.setsockopt(*option)
        except TimeoutError as exc:
            raise httpcore.ConnectTimeout("Moonraker connect timed out") from exc
        except (OSError, anyio.BrokenResourceError) as exc:
            raise httpcore.ConnectError("Moonraker connect failed") from exc
        return _AnyIOStream(stream)

    async def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options: Any = None):
        raise httpcore.ConnectError("unix sockets are not supported")

    async def sleep(self, seconds: float) -> None:
        await anyio.sleep(seconds)


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Connect only to addresses approved by the resolver for this request."""

    def __init__(
        self,
        host: str,
        peers: frozenset[IPAddress],
        *,
        backend: httpcore.AsyncNetworkBackend | None = None,
    ):
        self._host = host.lower()
        self._peers = peers
        self._backend = backend or _AnyIONetworkBackend()

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

        timed_out = False
        try:
            async with asyncio.timeout(timeout):
                for peer in sorted(self._peers, key=str):
                    try:
                        stream = await self._backend.connect_tcp(
                            str(peer), port, timeout, local_address, socket_options
                        )
                        connected = stream.get_extra_info("server_addr")
                        connected_peer = unwrap_ipv4_mapped(ipaddress.ip_address(connected[0])) if connected else None
                        if connected_peer not in self._peers:
                            await stream.aclose()
                            continue
                        return stream
                    except httpcore.ConnectTimeout:
                        timed_out = True
                    except httpcore.NetworkError:
                        continue
        except TimeoutError as exc:
            raise httpcore.ConnectTimeout("approved Moonraker peers timed out") from exc
        if timed_out:
            raise httpcore.ConnectTimeout("approved Moonraker peers timed out")
        raise httpcore.ConnectError("approved Moonraker peer was unavailable")

    async def connect_unix_socket(self, path: str, timeout: float | None = None, socket_options: Any = None):
        raise httpcore.ConnectError("unix sockets are not supported")

    async def sleep(self, seconds: float) -> None:
        await self._backend.sleep(seconds)


class _HTTPXResponseStream(httpx.AsyncByteStream):
    def __init__(self, stream):
        self._stream = stream

    async def __aiter__(self):
        async for chunk in self._stream:
            yield chunk

    async def aclose(self) -> None:
        await self._stream.aclose()


class _PinnedHTTPTransport(httpx.AsyncBaseTransport):
    """httpx adapter backed only by public httpcore transport APIs."""

    def __init__(self, *, tls_verify: bool, network_backend: httpcore.AsyncNetworkBackend):
        ssl_context = ssl.create_default_context()
        if not tls_verify:
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
        self._connection_pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl_context,
            max_connections=1,
            max_keepalive_connections=0,
            retries=0,
            network_backend=network_backend,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        response = await self._connection_pool.handle_async_request(
            httpcore.Request(
                method=request.method,
                url=httpcore.URL(
                    scheme=request.url.raw_scheme,
                    host=request.url.raw_host,
                    port=request.url.port,
                    target=request.url.raw_path,
                ),
                headers=request.headers.raw,
                content=request.stream,
                extensions=request.extensions,
            )
        )
        return httpx.Response(
            status_code=response.status,
            headers=response.headers,
            stream=_HTTPXResponseStream(response.stream),
            extensions=response.extensions,
        )

    async def aclose(self) -> None:
        await self._connection_pool.aclose()


def _pinned_transport(host: str, port: int, peers: frozenset[IPAddress], tls_verify: bool) -> httpx.AsyncBaseTransport:
    return _PinnedHTTPTransport(
        tls_verify=tls_verify,
        network_backend=_PinnedNetworkBackend(host, peers),
    )


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
        canonical_url = httpx.URL(base_url)
        self._base_url = str(canonical_url).rstrip("/")
        self._host = canonical_url.raw_host.decode("ascii")
        self._port = parsed.port or (443 if parsed.scheme == "https" else 80)
        self._api_key = api_key
        self._authorization = authorization
        self._tls_verify = tls_verify
        self._resolver = resolver
        self._transport_factory = transport_factory

    async def get_server_info(self) -> MoonrakerHTTPResponse:
        """Probe Moonraker's documented read-only server-info endpoint."""
        return await self._request("GET", "/server/info")

    async def test_connection(self) -> bool:
        response = await self.get_server_info()
        return 200 <= response.status_code < 300

    async def upload_gcode(
        self,
        file: BinaryIO,
        *,
        filename: str,
        size: int | None = None,
    ) -> str:
        """Stream one safe G-code to Moonraker's ``gcodes`` root without retries."""
        try:
            validate_moonraker_gcode_basename(filename)
        except InvalidFilenameError as exc:
            raise MoonrakerHTTPError("invalid_filename", str(exc)) from exc
        response = await self._request(
            "POST",
            "/server/files/upload",
            data={"root": "gcodes"},
            files={"file": (filename, _BoundedUpload(file, size), "application/octet-stream")},
        )
        try:
            item = json.loads(response.body).get("item")
            path = item.get("path") if isinstance(item, dict) else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            path = None
        if not _safe_moonraker_gcode_path(path):
            raise MoonrakerHTTPError(
                "invalid_response", "Moonraker upload response did not contain a safe G-code path."
            )
        return path

    async def start_print(self, filename: str) -> None:
        if not _safe_moonraker_gcode_path(filename):
            raise MoonrakerHTTPError("invalid_filename", "Moonraker print requires a safe G-code path.")
        await self._request("POST", "/printer/print/start", params={"filename": filename})

    async def pause_print(self) -> None:
        await self._request("POST", "/printer/print/pause")

    async def resume_print(self) -> None:
        await self._request("POST", "/printer/print/resume")

    async def cancel_print(self) -> None:
        await self._request("POST", "/printer/print/cancel")

    async def emergency_stop(self) -> None:
        await self._request("POST", "/printer/emergency_stop")

    async def _request(self, method: str, path: str, **request_options: Any) -> MoonrakerHTTPResponse:
        try:
            async with asyncio.timeout(_TOTAL_TIMEOUT_SECONDS):
                return await self._request_within_deadline(method, path, **request_options)
        except MoonrakerHTTPError:
            raise
        except (TimeoutError, httpx.TimeoutException, httpcore.TimeoutException) as exc:
            raise MoonrakerHTTPError("timeout", "Moonraker did not respond before timeout.") from exc
        except (httpx.HTTPError, httpcore.NetworkError, httpcore.ProtocolError, _TLSVerificationError) as exc:
            if _caused_by_tls_verification(exc):
                raise MoonrakerHTTPError(
                    "tls_verification_failed",
                    "Moonraker TLS certificate verification failed. Trust it or disable TLS verification for this printer.",
                ) from exc
            raise MoonrakerHTTPError("unavailable", "Could not connect to Moonraker.") from exc

    async def _request_within_deadline(self, method: str, path: str, **request_options: Any) -> MoonrakerHTTPResponse:
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
        async with (
            httpx.AsyncClient(
                transport=transport,
                timeout=_TIMEOUT,
                follow_redirects=False,
                trust_env=False,
            ) as client,
            client.stream(method, f"{self._base_url}{path}", headers=headers, **request_options) as response,
        ):
            if 300 <= response.status_code < 400:
                raise MoonrakerHTTPError(
                    "redirect_blocked",
                    "Moonraker redirects are blocked; configure the final printer origin.",
                )
            if response.status_code in {401, 403}:
                raise MoonrakerHTTPError(
                    "authentication_failed",
                    "Moonraker rejected configured credentials.",
                )
            if response.status_code >= 400:
                raise MoonrakerHTTPError(
                    "http_status",
                    f"Moonraker returned HTTP {response.status_code}.",
                )
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > _MAX_RESPONSE_BYTES:
                    raise MoonrakerHTTPError("response_too_large", "Moonraker response exceeded size limit.")
            return MoonrakerHTTPResponse(response.status_code, dict(response.headers), bytes(body))


def _safe_moonraker_gcode_path(path: object) -> bool:
    if not isinstance(path, str) or not path or "\\" in path or path.startswith("/"):
        return False
    parts = PurePosixPath(path).parts
    return bool(parts) and all(part not in {".", ".."} for part in parts) and path.lower().endswith(".gcode")
