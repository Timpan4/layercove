"""Narrow provider boundary used by :mod:`printer_manager`."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol, TypeAlias

from backend.app.services.printer_types import PrinterCapabilities, PrinterProvider, PrinterSnapshot


class BackendError(Exception):
    """Expected provider failure with a message safe for logs and API callers."""


class UnsupportedPrinterProviderError(BackendError):
    def __init__(self, provider: object):
        self.provider = str(provider)
        super().__init__(f"Unsupported printer provider: {self.provider}")


@dataclass(frozen=True)
class StatusChanged:
    """Normalized status plus an optional provider value for compatibility."""

    snapshot: PrinterSnapshot
    provider_state: object | None = None


@dataclass(frozen=True)
class JobLifecycle:
    kind: Literal["started", "completed", "failed", "cancelled"]
    correlation_id: str
    provider_job_id: str | None
    filename: str | None
    occurred_at: datetime
    reason: str | None
    data: dict


@dataclass(frozen=True)
class ProviderEvent:
    """Provider-specific callback retained while Bambu features are migrated."""

    kind: Literal[
        "ams_changed",
        "layer_changed",
        "bed_temperature_changed",
        "drying_completed",
        "print_running_observed",
        "finish_photo_moment",
    ]
    data: object


BackendEvent: TypeAlias = StatusChanged | JobLifecycle | ProviderEvent
BackendEventSink: TypeAlias = Callable[[BackendEvent], None]


class PrinterBackend(Protocol):
    provider: PrinterProvider

    @property
    def capabilities(self) -> PrinterCapabilities: ...

    async def connect(self) -> None: ...

    async def disconnect(self, timeout: float = 0) -> None: ...

    def snapshot(self) -> PrinterSnapshot: ...

    async def start_print(self, filename: str, *args: object, **options: object) -> bool: ...

    async def pause(self) -> bool: ...

    async def resume(self) -> bool: ...

    async def cancel(self) -> bool: ...
