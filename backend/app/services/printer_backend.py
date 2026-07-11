"""Narrow provider boundary used by :mod:`printer_manager`."""

from typing import Protocol

from backend.app.services.printer_types import PrinterCapabilities, PrinterProvider, PrinterSnapshot


class BackendError(Exception):
    """Expected provider failure with a message safe for logs and API callers."""


class UnsupportedPrinterProviderError(BackendError):
    def __init__(self, provider: object):
        self.provider = str(provider)
        super().__init__(f"Unsupported printer provider: {self.provider}")


class PrinterBackend(Protocol):
    provider: PrinterProvider

    @property
    def capabilities(self) -> PrinterCapabilities: ...

    def connect(self) -> None: ...

    def disconnect(self, timeout: float = 0) -> None: ...

    def snapshot(self) -> PrinterSnapshot: ...

    def start_print(self, filename: str, *args: object, **options: object) -> bool: ...

    def pause(self) -> bool: ...

    def resume(self) -> bool: ...

    def cancel(self) -> bool: ...
