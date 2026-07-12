from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from aiohttp import web


@dataclass
class FakeMoonraker:
    api_key: str | None = None
    authorization: str | None = None
    status: dict[str, dict[str, Any]] = field(
        default_factory=lambda: {
            "print_stats": {"state": "standby"},
            "virtual_sdcard": {"progress": 0.0},
            "display_status": {},
            "extruder": {"temperature": 25.0},
            "heater_bed": {"temperature": 25.0},
        }
    )
    requests: list[tuple[str, str]] = field(default_factory=list)
    commands: list[tuple[str, str | None]] = field(default_factory=list)
    uploads: list[tuple[str, bytes]] = field(default_factory=list)
    malformed_server_info: bool = False
    malformed_jsonrpc_method: str | None = None
    malformed_websocket_message: bool = False

    def __post_init__(self) -> None:
        self._app = web.Application(client_max_size=16 * 1024 * 1024)
        self._app.router.add_get("/server/info", self._server_info)
        self._app.router.add_post("/server/files/upload", self._upload)
        self._app.router.add_post("/printer/print/start", self._start_print)
        self._app.router.add_post("/printer/print/pause", self._pause_print)
        self._app.router.add_post("/printer/print/resume", self._resume_print)
        self._app.router.add_post("/printer/print/cancel", self._cancel_print)
        self._app.router.add_post("/printer/emergency_stop", self._emergency_stop)
        self._app.router.add_get("/websocket", self._websocket)
        self._runner: web.AppRunner | None = None
        self._websockets: set[web.WebSocketResponse] = set()
        self._subscribers: set[web.WebSocketResponse] = set()
        self.port: int | None = None

    @property
    def base_url(self) -> str:
        if self.port is None:
            raise RuntimeError("Fake Moonraker has not been started")
        return f"http://moonraker.test:{self.port}"

    async def start(self) -> FakeMoonraker:
        if self._runner is not None:
            return self
        self._runner = web.AppRunner(self._app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        sockets = site._server.sockets if site._server is not None else []
        if not sockets:
            await self.close()
            raise RuntimeError("Fake Moonraker failed to bind a test port")
        self.port = sockets[0].getsockname()[1]
        return self

    async def close(self) -> None:
        sockets = list(self._websockets)
        self._websockets.clear()
        self._subscribers.clear()
        await asyncio.gather(*(socket.close() for socket in sockets), return_exceptions=True)
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        self.port = None

    async def resolver(self, host: str, port: int) -> list[str]:
        if host != "moonraker.test" or port != self.port:
            raise AssertionError(f"unexpected Moonraker origin {host}:{port}")
        return ["127.0.0.1"]

    async def set_status(self, update: dict[str, dict[str, Any]]) -> None:
        for object_name, values in update.items():
            self.status.setdefault(object_name, {}).update(values)
        await self._broadcast({"jsonrpc": "2.0", "method": "notify_status_update", "params": [update, 0.0]})

    async def wait_for_subscribers(self, count: int = 1, *, timeout: float = 1.0) -> None:
        async with asyncio.timeout(timeout):
            while len(self._subscribers) < count:
                await asyncio.sleep(0)

    async def send_malformed_notification(self) -> None:
        sockets = list(self._subscribers)
        await asyncio.gather(*(socket.send_str("{not-json") for socket in sockets))

    async def finish_job(
        self,
        *,
        status: str,
        filename: str,
        job_id: str = "1",
        print_duration: float = 1.0,
    ) -> None:
        await self._broadcast(
            {
                "jsonrpc": "2.0",
                "method": "notify_history_changed",
                "params": [
                    {
                        "action": "finished",
                        "job": {
                            "status": status,
                            "filename": filename,
                            "job_id": job_id,
                            "print_duration": print_duration,
                        },
                    }
                ],
            }
        )

    async def disconnect_websockets(self) -> None:
        sockets = list(self._websockets)
        await asyncio.gather(*(socket.close() for socket in sockets), return_exceptions=True)

    def require_api_key(self, value: str) -> None:
        self.api_key = value
        self.authorization = None

    def require_authorization(self, value: str) -> None:
        self.authorization = value
        self.api_key = None

    def _authorized(self, request: web.Request) -> bool:
        if self.api_key is not None and request.headers.get("X-Api-Key") != self.api_key:
            return False
        return self.authorization is None or request.headers.get("Authorization") == self.authorization

    def _record(self, request: web.Request) -> None:
        self.requests.append((request.method, request.path))

    async def _server_info(self, request: web.Request) -> web.StreamResponse:
        self._record(request)
        if not self._authorized(request):
            raise web.HTTPUnauthorized(text="credentials rejected")
        if self.malformed_server_info:
            return web.Response(body=b"{not-json", content_type="application/json")
        return web.json_response({"result": {"klippy_connected": True, "moonraker_version": "test"}})

    async def _upload(self, request: web.Request) -> web.StreamResponse:
        self._record(request)
        if not self._authorized(request):
            raise web.HTTPUnauthorized(text="credentials rejected")
        reader = await request.multipart()
        root: str | None = None
        filename: str | None = None
        content = bytearray()
        while part := await reader.next():
            if part.name == "root":
                root = await part.text()
            elif part.name == "file":
                filename = part.filename
                while chunk := await part.read_chunk():
                    content.extend(chunk)
        if root != "gcodes" or not filename:
            raise web.HTTPBadRequest(text="invalid upload")
        self.uploads.append((filename, bytes(content)))
        remote_path = f"queue/{filename}"
        return web.json_response({"item": {"root": "gcodes", "path": remote_path}}, status=201)

    async def _start_print(self, request: web.Request) -> web.StreamResponse:
        return await self._command(request, "start", request.query.get("filename"))

    async def _pause_print(self, request: web.Request) -> web.StreamResponse:
        return await self._command(request, "pause")

    async def _resume_print(self, request: web.Request) -> web.StreamResponse:
        return await self._command(request, "resume")

    async def _cancel_print(self, request: web.Request) -> web.StreamResponse:
        return await self._command(request, "cancel")

    async def _emergency_stop(self, request: web.Request) -> web.StreamResponse:
        return await self._command(request, "emergency_stop")

    async def _command(self, request: web.Request, name: str, value: str | None = None) -> web.StreamResponse:
        self._record(request)
        if not self._authorized(request):
            raise web.HTTPUnauthorized(text="credentials rejected")
        self.commands.append((name, value))
        return web.json_response({"result": "ok"})

    async def _websocket(self, request: web.Request) -> web.StreamResponse:
        self._record(request)
        if not self._authorized(request):
            raise web.HTTPUnauthorized(text="credentials rejected")
        websocket = web.WebSocketResponse(autoping=True)
        await websocket.prepare(request)
        self._websockets.add(websocket)
        try:
            async for message in websocket:
                if message.type is not web.WSMsgType.TEXT:
                    continue
                try:
                    payload = message.json()
                except ValueError:
                    continue
                method = payload.get("method") if isinstance(payload, dict) else None
                request_id = payload.get("id") if isinstance(payload, dict) else None
                if self.malformed_websocket_message:
                    await websocket.send_str("{not-json")
                    self.malformed_websocket_message = False
                    continue
                if method == self.malformed_jsonrpc_method:
                    await websocket.send_json({"jsonrpc": "2.0", "id": request_id, "result": "invalid"})
                elif method in {"printer.objects.query", "printer.objects.subscribe"}:
                    await websocket.send_json({"jsonrpc": "2.0", "id": request_id, "result": {"status": self.status}})
                    if method == "printer.objects.subscribe":
                        self._subscribers.add(websocket)
                else:
                    await websocket.send_json(
                        {
                            "jsonrpc": "2.0",
                            "id": request_id,
                            "error": {"code": -32601, "message": f"unsupported method {method}"},
                        }
                    )
        finally:
            self._subscribers.discard(websocket)
            self._websockets.discard(websocket)
        return websocket

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        sockets = list(self._subscribers)
        results = await asyncio.gather(*(socket.send_json(payload) for socket in sockets), return_exceptions=True)
        for socket, result in zip(sockets, results, strict=True):
            if isinstance(result, BaseException):
                self._subscribers.discard(socket)
                self._websockets.discard(socket)
