"""Bambu implementation of the printer backend boundary."""

import asyncio
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from backend.app.services.bambu_mqtt import BambuMQTTClient, PrinterState
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

_BAMBU_STATES = {
    "IDLE": NormalizedPrinterState.IDLE,
    "PREPARE": NormalizedPrinterState.PREPARING,
    "SLICING": NormalizedPrinterState.PREPARING,
    "RUNNING": NormalizedPrinterState.PRINTING,
    "PAUSE": NormalizedPrinterState.PAUSED,
    "FINISH": NormalizedPrinterState.COMPLETED,
    "FAILED": NormalizedPrinterState.ERROR,
    "STOPPED": NormalizedPrinterState.CANCELLED,
}


class BambuBackend:
    provider = PrinterProvider.BAMBU

    def __init__(
        self,
        printer: Any,
        *,
        emit: BackendEventSink,
        client_factory: Callable[..., BambuMQTTClient] | None = None,
    ):
        if not all((printer.ip_address, printer.serial_number, printer.access_code)):
            raise BackendError("Bambu printer configuration is incomplete")
        self._emit = emit
        self._active_correlation_id: str | None = None
        self._active_provider_job_id: str | None = None
        self._active_filename: str | None = None
        make_client = client_factory or BambuMQTTClient
        self.client = make_client(
            ip_address=printer.ip_address,
            serial_number=printer.serial_number,
            access_code=printer.access_code,
            model=printer.model,
            on_state_change=lambda state: emit(StatusChanged(self._snapshot_from_state(state), state)),
            on_print_start=self._on_print_start,
            on_print_complete=self._on_print_terminal,
            on_ams_change=lambda data: emit(ProviderEvent("ams_changed", data)),
            on_layer_change=lambda layer: emit(ProviderEvent("layer_changed", layer)),
            on_bed_temp_update=lambda temp: emit(ProviderEvent("bed_temperature_changed", temp)),
            on_drying_complete=lambda ams_id: emit(ProviderEvent("drying_completed", ams_id)),
            on_print_running_observed=self._on_print_running_observed,
            on_finish_photo_moment=lambda data: emit(ProviderEvent("finish_photo_moment", data)),
        )

    def _provider_job_id(self, data: dict) -> str | None:
        state = getattr(self, "client", None)
        state = getattr(state, "state", None)
        candidates = (
            data.get("subtask_id"),
            data.get("task_id"),
            getattr(state, "subtask_id", None),
            getattr(getattr(self, "client", None), "last_dispatch_subtask_id", None),
        )
        for candidate in candidates:
            value = str(candidate).strip() if candidate is not None else ""
            if value and value != "0":
                return value
        return None

    def _job_filename(self, data: dict) -> str | None:
        state = getattr(getattr(self, "client", None), "state", None)
        return (
            data.get("filename")
            or getattr(state, "current_print", None)
            or getattr(state, "gcode_file", None)
            or getattr(state, "subtask_name", None)
        )

    def _on_print_start(self, data: dict) -> None:
        provider_job_id = self._provider_job_id(data)
        correlation_id = f"bambu:{provider_job_id}" if provider_job_id else str(uuid4())
        self._active_correlation_id = correlation_id
        self._active_provider_job_id = provider_job_id
        self._active_filename = self._job_filename(data)
        self._emit(
            JobLifecycle(
                kind="started",
                correlation_id=correlation_id,
                provider_job_id=provider_job_id,
                filename=self._active_filename,
                occurred_at=datetime.now(timezone.utc),
                reason=None,
                data=data,
            )
        )

    def _on_print_running_observed(self, data: dict) -> None:
        """Seed active identity for restart recovery without inventing a start."""
        if self._active_correlation_id is None:
            provider_job_id = self._provider_job_id(data)
            self._active_provider_job_id = provider_job_id
            self._active_correlation_id = f"bambu:{provider_job_id}" if provider_job_id else str(uuid4())
            self._active_filename = self._job_filename(data)
        self._emit(ProviderEvent("print_running_observed", data))

    def _on_print_terminal(self, data: dict) -> None:
        status = str(data.get("status") or "completed").lower()
        kind = "failed" if status == "failed" else "cancelled" if status in {"aborted", "cancelled"} else "completed"
        provider_job_id = self._active_provider_job_id or self._provider_job_id(data)
        correlation_id = self._active_correlation_id or (
            f"bambu:{provider_job_id}" if provider_job_id else str(uuid4())
        )
        reason = data.get("reason")
        if not isinstance(reason, str) or not reason:
            reason = status if kind != "completed" else None
        self._emit(
            JobLifecycle(
                kind=kind,
                correlation_id=correlation_id,
                provider_job_id=provider_job_id,
                filename=self._active_filename or self._job_filename(data),
                occurred_at=datetime.now(timezone.utc),
                reason=reason,
                data=data,
            )
        )
        self._active_correlation_id = None
        self._active_provider_job_id = None
        self._active_filename = None

    @property
    def capabilities(self) -> PrinterCapabilities:
        return capabilities_for_provider(self.provider)

    async def connect(self) -> None:
        self.client.connect()

    async def disconnect(self, timeout: float = 0) -> None:
        await asyncio.to_thread(self.client.disconnect, timeout=timeout)

    def legacy_state(self) -> PrinterState:
        self.client.check_staleness()
        return self.client.state

    def snapshot(self) -> PrinterSnapshot:
        return self._snapshot_from_state(self.legacy_state())

    def _snapshot_from_state(self, state: PrinterState) -> PrinterSnapshot:
        normalized = _BAMBU_STATES.get(state.state, NormalizedPrinterState.UNKNOWN)
        if not state.connected:
            normalized = NormalizedPrinterState.OFFLINE
        return PrinterSnapshot(
            provider=self.provider,
            connected=state.connected,
            state=normalized,
            filename=state.current_print or state.gcode_file or state.subtask_name,
            progress=state.progress,
            remaining_seconds=state.remaining_time,
            current_layer=state.layer_num,
            total_layers=state.total_layers,
            temperatures=dict(state.temperatures),
        )

    async def start_print(self, filename: str, plate_id: int = 1, **options: object) -> bool:
        return self.client.start_print(filename, plate_id, **options)

    async def pause(self) -> bool:
        return self.client.pause_print()

    async def resume(self) -> bool:
        return self.client.resume_print()

    async def cancel(self) -> bool:
        return self.client.stop_print()

    def mark_offline(self) -> None:
        """Update Bambu compatibility state and emit normalized offline status."""
        self.client.state.connected = False
        self.client.state.state = "unknown"
        self._emit(StatusChanged(self._snapshot_from_state(self.client.state), self.client.state))
