"""Moonraker live-state backend using one owned, pinned WebSocket task."""

from __future__ import annotations

import asyncio
import math
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any, Protocol
from uuid import uuid4

from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError
from backend.app.services.moonraker_websocket import MoonrakerWebSocketTransport
from backend.app.services.printer_backend import (
    BackendError,
    BackendEventSink,
    JobLifecycle,
    ProviderEvent,
    StatusChanged,
)
from backend.app.services.printer_types import (
    NormalizedPrinterState,
    PrinterCapabilities,
    PrinterProvider,
    PrinterSnapshot,
    capabilities_for_provider,
)

_OBJECTS = {
    "print_stats": None,
    "virtual_sdcard": None,
    "display_status": None,
    "gcode_move": None,
    "toolhead": None,
    "extruder": None,
    "heater_bed": None,
}
_BACKOFF_SECONDS = (1, 2, 4, 8, 16, 30)
_BOOTSTRAP_RESPONSE_TIMEOUT_SECONDS = 10.0
_STABLE_CONNECTION_SECONDS = 30
_ACTIVE_STATES = {NormalizedPrinterState.PRINTING, NormalizedPrinterState.PAUSED}
_TERMINAL_KINDS = {
    NormalizedPrinterState.COMPLETED: "completed",
    NormalizedPrinterState.CANCELLED: "cancelled",
    NormalizedPrinterState.ERROR: "failed",
}
_STATE_MAP = {
    "standby": NormalizedPrinterState.IDLE,
    "ready": NormalizedPrinterState.IDLE,
    "printing": NormalizedPrinterState.PRINTING,
    "paused": NormalizedPrinterState.PAUSED,
    "complete": NormalizedPrinterState.COMPLETED,
    "completed": NormalizedPrinterState.COMPLETED,
    "cancelled": NormalizedPrinterState.CANCELLED,
    "canceled": NormalizedPrinterState.CANCELLED,
    "error": NormalizedPrinterState.ERROR,
}


class _MoonrakerConnection(Protocol):
    async def send_json(self, data: dict[str, Any]) -> None: ...

    async def receive_json(self) -> dict[str, Any]: ...

    async def close(self) -> None: ...


TransportFactory = Callable[..., _MoonrakerConnection]
Sleep = Callable[[float], Awaitable[None]]
Clock = Callable[[], float]


def moonraker_retry_delay(attempt: int, jitter: Callable[[], float] = random.random) -> float:
    """Return bounded exponential retry delay plus bounded positive jitter."""
    delay = _BACKOFF_SECONDS[min(max(attempt, 0), len(_BACKOFF_SECONDS) - 1)]
    return delay * (1 + max(0.0, min(float(jitter()), 1.0)) * 0.2)


def _finite_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _seconds(value: object) -> int | None:
    number = _finite_number(value)
    return max(0, int(number)) if number is not None else None


def _layer(value: object) -> int | None:
    number = _finite_number(value)
    return max(0, int(number)) if number is not None else None


class MoonrakerBackend:
    provider = PrinterProvider.MOONRAKER

    def __init__(
        self,
        printer: Any,
        *,
        emit: BackendEventSink,
        transport_factory: TransportFactory = MoonrakerWebSocketTransport,
        http_client_factory: Callable[..., MoonrakerHTTPClient] = MoonrakerHTTPClient,
        sleep: Sleep = asyncio.sleep,
        jitter: Callable[[], float] = random.random,
        bootstrap_timeout: float = _BOOTSTRAP_RESPONSE_TIMEOUT_SECONDS,
        clock: Clock = time.monotonic,
        stable_connection_seconds: float = _STABLE_CONNECTION_SECONDS,
    ):
        config = getattr(printer, "moonraker_config", None)
        if config is None:
            raise BackendError("Moonraker printer configuration is incomplete")
        try:
            self._transport = transport_factory(
                base_url=config.base_url,
                websocket_url_override=config.websocket_url_override,
                api_key=config.api_key,
                authorization=config.authorization,
                tls_verify=config.tls_verify,
            )
        except (TypeError, ValueError) as exc:
            raise BackendError("Moonraker printer configuration is invalid") from exc
        self._http = http_client_factory(
            base_url=config.base_url,
            api_key=config.api_key,
            authorization=config.authorization,
            tls_verify=config.tls_verify,
        )
        self._emit = emit
        self._sleep = sleep
        self._jitter = jitter
        self._bootstrap_timeout = bootstrap_timeout
        self._clock = clock
        self._stable_connection_seconds = stable_connection_seconds
        self._task: asyncio.Task[None] | None = None
        self._connection: _MoonrakerConnection | None = None
        self._stopping = False
        self._objects: dict[str, dict[str, Any]] = {}
        self._snapshot = PrinterSnapshot(self.provider, False, NormalizedPrinterState.OFFLINE)
        self._last_state = NormalizedPrinterState.OFFLINE
        self._active_correlation_id: str | None = None
        self._active_provider_job_id: str | None = None
        self._active_filename: str | None = None

    @property
    def capabilities(self) -> PrinterCapabilities:
        return capabilities_for_provider(self.provider)

    async def connect(self) -> None:
        if self._task is None or self._task.done():
            self._stopping = False
            self._snapshot = replace(self._snapshot, connected=False, state=NormalizedPrinterState.CONNECTING)
            self._emit(StatusChanged(self._snapshot))
            self._task = asyncio.create_task(self._run())
        await asyncio.sleep(0)

    async def disconnect(self, timeout: float = 0) -> None:
        self._stopping = True
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._connection = None
        if self._snapshot.connected or self._snapshot.state is not NormalizedPrinterState.OFFLINE:
            self._snapshot = replace(self._snapshot, connected=False, state=NormalizedPrinterState.OFFLINE)
            self._emit(StatusChanged(self._snapshot))

    def snapshot(self) -> PrinterSnapshot:
        return self._snapshot

    async def start_print(self, filename: str, *args: object, **options: object) -> bool:
        self._require_command("start_print", {NormalizedPrinterState.IDLE})
        await self._run_command(self._http.start_print(filename))
        return True

    async def pause(self) -> bool:
        self._require_command("pause", {NormalizedPrinterState.PRINTING})
        await self._run_command(self._http.pause_print())
        return True

    async def resume(self) -> bool:
        self._require_command("resume", {NormalizedPrinterState.PAUSED})
        await self._run_command(self._http.resume_print())
        return True

    async def cancel(self) -> bool:
        self._require_command(
            "cancel", {NormalizedPrinterState.PREPARING, NormalizedPrinterState.PRINTING, NormalizedPrinterState.PAUSED}
        )
        await self._run_command(self._http.cancel_print())
        return True

    async def upload_gcode(self, file, *, filename: str, start: bool, size: int | None) -> str:
        self._require_command("upload_gcode", {NormalizedPrinterState.IDLE})
        path = await self._run_command(self._http.upload_gcode(file, filename=filename, size=size))
        if start:
            await self._run_command(self._http.start_print(path))
        return path

    async def emergency_stop(self) -> bool:
        await self._run_command(self._http.emergency_stop())
        return True

    def _require_command(self, capability: str, states: set[NormalizedPrinterState]) -> None:
        if not getattr(self.capabilities, capability) or not self._snapshot.connected:
            raise BackendError("Moonraker command is unavailable.", code="command_unavailable")
        if self._snapshot.state not in states:
            raise BackendError("Moonraker command is not valid for the current printer state.", code="invalid_state")

    async def _run_command(self, command):
        try:
            return await command
        except MoonrakerHTTPError as exc:
            raise BackendError(exc.message, code=exc.code) from exc

    async def _run(self) -> None:
        attempt = 0
        while not self._stopping:
            connection: _MoonrakerConnection | None = None
            connected_at: float | None = None
            try:
                connection = await self._transport.connect()
                self._connection = connection
                connected_at = self._clock()
                await asyncio.wait_for(
                    self._request(connection, 1, "printer.objects.query"), timeout=self._bootstrap_timeout
                )
                await asyncio.wait_for(
                    self._request(connection, 2, "printer.objects.subscribe"), timeout=self._bootstrap_timeout
                )
                while True:
                    if self._clock() - connected_at >= self._stable_connection_seconds:
                        attempt = 0
                    self._process_message(await connection.receive_json(), bootstrap=False)
            except asyncio.CancelledError:
                raise
            except Exception:
                if not self._stopping:
                    if connected_at is not None and self._clock() - connected_at >= self._stable_connection_seconds:
                        attempt = 0
                    self._emit_offline()
                    await self._sleep(moonraker_retry_delay(attempt, self._jitter))
                    attempt = min(attempt + 1, len(_BACKOFF_SECONDS) - 1)
            finally:
                if connection is not None:
                    try:
                        await connection.close()
                    except Exception:
                        pass
                if self._connection is connection:
                    self._connection = None

    async def _request(self, connection: _MoonrakerConnection, request_id: int, method: str) -> None:
        await connection.send_json(
            {"jsonrpc": "2.0", "method": method, "params": {"objects": _OBJECTS}, "id": request_id}
        )
        while True:
            message = await connection.receive_json()
            if message.get("id") == request_id:
                result = message.get("result")
                if not isinstance(result, dict):
                    raise BackendError("Moonraker returned an invalid subscription response")
                self._merge_status(result.get("status"), bootstrap=True)
                return
            self._process_message(message, bootstrap=True)

    def _process_message(self, message: object, *, bootstrap: bool) -> None:
        if not isinstance(message, dict):
            return
        if message.get("method") == "notify_status_update":
            params = message.get("params")
            self._merge_status(params[0] if isinstance(params, list) and params else None, bootstrap=bootstrap)
        elif message.get("method") == "notify_history_changed":
            params = message.get("params")
            change = params[0] if isinstance(params, list) and params else None
            if not isinstance(change, dict) or not isinstance(change.get("job"), dict):
                return
            if change.get("action") not in {"added", "finished"}:
                return
            job = change["job"]
            history: dict[str, Any] = {}
            for field in ("filename", "job_id", "print_duration"):
                if field in job:
                    history[field] = job[field]
            if change.get("action") == "finished" and isinstance(job.get("status"), str):
                history["state"] = job["status"]
            if history:
                self._merge_status({"print_stats": history}, bootstrap=bootstrap)

    def _merge_status(self, status: object, *, bootstrap: bool) -> None:
        if not isinstance(status, dict):
            return
        for name, value in status.items():
            if isinstance(name, str) and isinstance(value, dict):
                self._objects.setdefault(name, {}).update(value)
        self._snapshot = self._snapshot_from_objects(connected=True)
        if self._snapshot.state is NormalizedPrinterState.IDLE and (
            self._last_state in _ACTIVE_STATES or self._last_state in _TERMINAL_KINDS
        ):
            self._clear_stale_job_data()
            self._snapshot = self._snapshot_from_objects(connected=True)
        self._emit(StatusChanged(self._snapshot))
        self._emit_lifecycle(bootstrap=bootstrap)

    def _clear_stale_job_data(self) -> None:
        fields = {
            "print_stats": {
                "filename",
                "filament_used",
                "info",
                "job_id",
                "message",
                "print_duration",
                "total_duration",
                "uid",
            },
            "virtual_sdcard": {"file_path", "progress"},
            "display_status": {"message", "progress"},
        }
        for object_name, names in fields.items():
            values = self._objects.get(object_name)
            if values is not None:
                for name in names:
                    values.pop(name, None)

    def _snapshot_from_objects(self, *, connected: bool) -> PrinterSnapshot:
        stats = self._objects.get("print_stats", {})
        virtual_sdcard = self._objects.get("virtual_sdcard", {})
        display = self._objects.get("display_status", {})
        info = stats.get("info") if isinstance(stats.get("info"), dict) else {}
        raw_state = stats.get("state") or stats.get("status")
        state = _STATE_MAP.get(str(raw_state).lower(), NormalizedPrinterState.UNKNOWN)
        if raw_state is None and connected:
            state = NormalizedPrinterState.IDLE
        progress = _finite_number(display.get("progress"))
        if progress is None:
            progress = _finite_number(virtual_sdcard.get("progress"))
        if progress is not None:
            progress = max(0.0, min(progress * 100, 100.0))
        temperatures: dict[str, float | None] = {}
        for object_name, field_name in (("extruder", "nozzle"), ("heater_bed", "bed")):
            value = _finite_number(self._objects.get(object_name, {}).get("temperature"))
            if value is not None:
                temperatures[field_name] = value
        filename = stats.get("filename") or virtual_sdcard.get("file_path")
        filename = filename if isinstance(filename, str) and filename else None
        message = stats.get("message")
        return PrinterSnapshot(
            provider=self.provider,
            connected=connected,
            state=state,
            message=message if isinstance(message, str) and message else None,
            filename=filename,
            progress=progress,
            elapsed_seconds=_seconds(stats.get("print_duration")),
            current_layer=_layer(info.get("current_layer")),
            total_layers=_layer(info.get("total_layer")),
            temperatures=temperatures,
            provider_detail={"print_state": str(raw_state).lower()} if raw_state is not None else {},
        )

    def _provider_job_id(self) -> str | None:
        stats = self._objects.get("print_stats", {})
        info = stats.get("info") if isinstance(stats.get("info"), dict) else {}
        for value in (stats.get("job_id"), info.get("job_id"), stats.get("uid")):
            candidate = str(value).strip() if value is not None else ""
            if candidate:
                return candidate
        return None

    def _emit_lifecycle(self, *, bootstrap: bool) -> None:
        state = self._snapshot.state
        was_active = self._last_state in _ACTIVE_STATES
        is_active = state in _ACTIVE_STATES
        provider_job_id = self._provider_job_id()
        if state is NormalizedPrinterState.IDLE and was_active and self._active_correlation_id is not None:
            self._active_correlation_id = None
            self._active_provider_job_id = None
            self._active_filename = None
        if is_active and not was_active and self._active_correlation_id is None:
            self._active_provider_job_id = provider_job_id
            self._active_correlation_id = f"moonraker:{provider_job_id}" if provider_job_id else str(uuid4())
            self._active_filename = self._snapshot.filename
            data = self._lifecycle_data("printing")
            if bootstrap:
                self._emit(ProviderEvent("print_running_observed", data))
            else:
                self._emit(
                    JobLifecycle(
                        "started",
                        self._active_correlation_id,
                        provider_job_id,
                        self._active_filename,
                        datetime.now(timezone.utc),
                        None,
                        data,
                    )
                )
        elif state in _TERMINAL_KINDS and was_active and self._active_correlation_id is not None:
            kind = _TERMINAL_KINDS[state]
            self._emit(
                JobLifecycle(
                    kind,
                    self._active_correlation_id,
                    self._active_provider_job_id or provider_job_id,
                    self._active_filename or self._snapshot.filename,
                    datetime.now(timezone.utc),
                    self._snapshot.message if kind != "completed" else None,
                    self._lifecycle_data(kind),
                )
            )
            self._active_correlation_id = None
            self._active_provider_job_id = None
            self._active_filename = None
        self._last_state = state

    def _lifecycle_data(self, status: str) -> dict[str, str | None]:
        filename = self._active_filename or self._snapshot.filename
        return {
            "status": status,
            "filename": filename,
            "subtask_name": filename,
            "provider_job_id": self._active_provider_job_id or self._provider_job_id(),
        }

    def _emit_offline(self) -> None:
        if self._snapshot.connected or self._snapshot.state is not NormalizedPrinterState.OFFLINE:
            self._snapshot = replace(self._snapshot, connected=False, state=NormalizedPrinterState.OFFLINE)
            self._emit(StatusChanged(self._snapshot))
