"""Bambu implementation of the printer backend boundary."""

from collections.abc import Callable
from typing import Any

from backend.app.services.bambu_mqtt import BambuMQTTClient, PrinterState
from backend.app.services.printer_backend import BackendError
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
        client_factory: Callable[..., BambuMQTTClient] | None = None,
        on_state_change: Callable[[PrinterState], None] | None = None,
        on_print_start: Callable[[dict], None] | None = None,
        on_print_complete: Callable[[dict], None] | None = None,
        on_ams_change: Callable[[list], None] | None = None,
        on_layer_change: Callable[[int], None] | None = None,
        on_bed_temp_update: Callable[[float], None] | None = None,
        on_drying_complete: Callable[[int], None] | None = None,
        on_print_running_observed: Callable[[dict], None] | None = None,
        on_finish_photo_moment: Callable[[dict], None] | None = None,
    ):
        if not all((printer.ip_address, printer.serial_number, printer.access_code)):
            raise BackendError("Bambu printer configuration is incomplete")
        make_client = client_factory or BambuMQTTClient
        self.client = make_client(
            ip_address=printer.ip_address,
            serial_number=printer.serial_number,
            access_code=printer.access_code,
            model=printer.model,
            on_state_change=on_state_change,
            on_print_start=on_print_start,
            on_print_complete=on_print_complete,
            on_ams_change=on_ams_change,
            on_layer_change=on_layer_change,
            on_bed_temp_update=on_bed_temp_update,
            on_drying_complete=on_drying_complete,
            on_print_running_observed=on_print_running_observed,
            on_finish_photo_moment=on_finish_photo_moment,
        )

    @property
    def capabilities(self) -> PrinterCapabilities:
        return capabilities_for_provider(self.provider)

    def connect(self) -> None:
        self.client.connect()

    def disconnect(self, timeout: float = 0) -> None:
        self.client.disconnect(timeout=timeout)

    def legacy_state(self) -> PrinterState:
        self.client.check_staleness()
        return self.client.state

    def snapshot(self) -> PrinterSnapshot:
        state = self.legacy_state()
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

    def start_print(self, filename: str, plate_id: int = 1, **options: object) -> bool:
        return self.client.start_print(filename, plate_id, **options)

    def pause(self) -> bool:
        return self.client.pause_print()

    def resume(self) -> bool:
        return self.client.resume_print()

    def cancel(self) -> bool:
        return self.client.stop_print()
