from dataclasses import dataclass, field
from typing import Any

from backend.app.core.compat import StrEnum


class PrinterProvider(StrEnum):
    BAMBU = "bambu"
    MOONRAKER = "moonraker"


class NormalizedPrinterState(StrEnum):
    OFFLINE = "offline"
    CONNECTING = "connecting"
    IDLE = "idle"
    PREPARING = "preparing"
    PRINTING = "printing"
    PAUSED = "paused"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    ERROR = "error"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class PrinterCapabilities:
    upload_gcode: bool = False
    upload_3mf: bool = False
    start_print: bool = False
    pause: bool = False
    resume: bool = False
    cancel: bool = False
    emergency_stop: bool = False
    camera: bool = False
    bed_temperature: bool = False
    extruder_temperature: bool = False
    chamber_temperature: bool = False
    ams: bool = False
    plate_selection: bool = False
    speed_control: bool = False
    firmware_information: bool = False
    object_cancellation: bool = False


def capabilities_for_provider(
    provider: PrinterProvider,
    *,
    camera_configured: bool = False,
) -> PrinterCapabilities:
    if provider is PrinterProvider.MOONRAKER:
        return PrinterCapabilities(
            upload_gcode=True,
            start_print=True,
            pause=True,
            resume=True,
            cancel=True,
            emergency_stop=True,
            camera=camera_configured,
            bed_temperature=True,
            extruder_temperature=True,
            speed_control=True,
            firmware_information=True,
            object_cancellation=True,
        )
    return PrinterCapabilities(
        upload_3mf=True,
        start_print=True,
        pause=True,
        resume=True,
        cancel=True,
        camera=True,
        bed_temperature=True,
        extruder_temperature=True,
        chamber_temperature=True,
        ams=True,
        plate_selection=True,
        speed_control=True,
        firmware_information=True,
        object_cancellation=True,
    )


@dataclass(frozen=True)
class PrinterSnapshot:
    provider: PrinterProvider
    connected: bool
    state: NormalizedPrinterState
    message: str | None = None
    filename: str | None = None
    progress: float | None = None
    elapsed_seconds: int | None = None
    remaining_seconds: int | None = None
    current_layer: int | None = None
    total_layers: int | None = None
    temperatures: dict[str, float | None] = field(default_factory=dict)
    provider_detail: dict[str, Any] = field(default_factory=dict, repr=False)
