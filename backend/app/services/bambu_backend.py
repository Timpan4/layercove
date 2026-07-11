"""Bambu implementation of the printer backend boundary."""

import asyncio
from collections.abc import Callable
from typing import Any

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
        make_client = client_factory or BambuMQTTClient
        self.client = make_client(
            ip_address=printer.ip_address,
            serial_number=printer.serial_number,
            access_code=printer.access_code,
            model=printer.model,
            on_state_change=lambda state: emit(StatusChanged(self._snapshot_from_state(state), state)),
            on_print_start=lambda data: emit(JobLifecycle("started", data)),
            on_print_complete=lambda data: emit(JobLifecycle("completed", data)),
            on_ams_change=lambda data: emit(ProviderEvent("ams_changed", data)),
            on_layer_change=lambda layer: emit(ProviderEvent("layer_changed", layer)),
            on_bed_temp_update=lambda temp: emit(ProviderEvent("bed_temperature_changed", temp)),
            on_drying_complete=lambda ams_id: emit(ProviderEvent("drying_completed", ams_id)),
            on_print_running_observed=lambda data: emit(ProviderEvent("print_running_observed", data)),
            on_finish_photo_moment=lambda data: emit(ProviderEvent("finish_photo_moment", data)),
        )

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
