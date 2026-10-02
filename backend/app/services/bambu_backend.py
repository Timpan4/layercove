"""Bambu implementation of the printer backend boundary."""

import asyncio
import math
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

from backend.app.services.bambu_mqtt import BambuMQTTClient, PrinterState
from backend.app.services.printer_backend import (
    BackendError,
    BackendEventSink,
    BambuStartJob,
    JobLifecycle,
    ProviderEvent,
    StartJob,
    StartResult,
    StatusChanged,
)
from backend.app.services.printer_types import (
    AMSUnitSnapshot,
    FilamentTraySnapshot,
    NormalizedPrinterState,
    NozzleSnapshot,
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


def _sensor_value(value: object) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _ams_has_filament(ams_data: dict) -> bool:
    bits = ams_data.get("tray_exist_bits")
    if isinstance(bits, str) and bits.strip():
        try:
            return int(bits, 16) > 0
        except ValueError:
            pass
    trays = ams_data.get("tray")
    return isinstance(trays, list) and any(
        isinstance(tray, dict) and isinstance(tray.get("tray_type"), str) and tray["tray_type"].strip()
        for tray in trays
    )


def _filament_trays(raw: object, default_id: int = 0) -> tuple[FilamentTraySnapshot, ...]:
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        return ()
    trays = []
    for tray in raw:
        if not isinstance(tray, dict):
            continue
        try:
            tray_id = int(tray.get("id", default_id))
        except (TypeError, ValueError):
            continue
        trays.append(
            FilamentTraySnapshot(
                tray_id=tray_id,
                material_type=tray.get("tray_type") if isinstance(tray.get("tray_type"), str) else "",
                color=tray.get("tray_color") if isinstance(tray.get("tray_color"), str) else "",
                profile_id=tray.get("tray_info_idx") if isinstance(tray.get("tray_info_idx"), str) else "",
                remaining_percent=_sensor_value(tray.get("remain")),
            )
        )
    return tuple(trays)


def _ams_units(state: PrinterState) -> tuple[AMSUnitSnapshot, ...]:
    raw = state.raw_data.get("ams")
    if isinstance(raw, dict):
        raw = raw.get("ams")
    if not isinstance(raw, list):
        return ()
    units = []
    extruders = state.ams_extruder_map if isinstance(state.ams_extruder_map, dict) else {}
    for unit in raw:
        if not isinstance(unit, dict):
            continue
        try:
            ams_id = int(unit.get("id", 0))
        except (TypeError, ValueError):
            continue
        humidity_raw = _sensor_value(unit.get("humidity_raw"))
        units.append(
            AMSUnitSnapshot(
                ams_id=ams_id,
                trays=_filament_trays(unit.get("tray")),
                extruder_id=extruders.get(str(ams_id)),
                humidity=humidity_raw if humidity_raw is not None else _sensor_value(unit.get("humidity")),
                humidity_raw=humidity_raw,
                temperature=_sensor_value(unit.get("temp")),
                has_filament=_ams_has_filament(unit),
            )
        )
    return tuple(units)


def _external_spools(state: PrinterState) -> tuple[FilamentTraySnapshot, ...]:
    from dataclasses import replace

    trays = _filament_trays(state.raw_data.get("vt_tray"), default_id=254)
    return tuple(replace(tray, extruder_id=255 - tray.tray_id if state.ams_extruder_map else None) for tray in trays)


def _nozzle_snapshots(state: PrinterState) -> tuple[NozzleSnapshot, ...]:
    raw_nozzles = state.nozzles if isinstance(state.nozzles, (list, tuple)) else ()
    snapshots = []
    for tool_index, nozzle in enumerate(raw_nozzles):
        try:
            diameter = float(nozzle.nozzle_diameter)
        except (AttributeError, TypeError, ValueError):
            diameter = None
        if diameter is None or not math.isfinite(diameter) or diameter <= 0:
            snapshots.append(NozzleSnapshot(tool_index, None, "unknown"))
        else:
            snapshots.append(NozzleSnapshot(tool_index, diameter, "confirmed"))
    return tuple(snapshots)


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
        stale = self.client.is_stale()
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
            nozzles=_nozzle_snapshots(state),
            telemetry_stale=stale if isinstance(stale, bool) else False,
            ams_units=_ams_units(state),
            external_spools=_external_spools(state),
            ams_filament_backup=state.ams_filament_backup if isinstance(state.ams_filament_backup, bool) else None,
            filament_track_switch_installed=state.fila_switch.installed is True,
        )

    async def start(self, job: StartJob) -> StartResult:
        if (
            not isinstance(job, BambuStartJob)
            or not isinstance(job.filename, str)
            or not job.filename
            or job.filename.startswith("/")
            or "\\" in job.filename
            or any(part in {".", ".."} for part in PurePosixPath(job.filename).parts)
            or isinstance(job.plate_id, bool)
            or not isinstance(job.plate_id, int)
            or job.plate_id < 1
        ):
            raise BackendError("Bambu start job is invalid", code="invalid_start_job")
        try:
            started = self.client.start_print(job.filename, job.plate_id)
        except OSError as exc:
            raise BackendError("Bambu print command could not be sent.", code="unavailable", retryable=True) from exc
        if not started:
            raise BackendError("Bambu print command is unavailable.", code="command_unavailable")
        return StartResult(started=True)

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
