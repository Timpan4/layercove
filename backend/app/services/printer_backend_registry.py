"""Provider-to-backend factory registry."""

from collections.abc import Callable
from typing import Any

from backend.app.services.printer_backend import PrinterBackend, UnsupportedPrinterProviderError
from backend.app.services.printer_types import PrinterProvider

BackendFactory = Callable[..., PrinterBackend]


class PrinterBackendRegistry:
    def __init__(self):
        self._factories: dict[PrinterProvider, BackendFactory] = {}

    def register(self, provider: PrinterProvider, factory: BackendFactory) -> None:
        self._factories[provider] = factory

    def create(self, printer: Any, **kwargs: Any) -> PrinterBackend:
        provider = getattr(printer, "provider", PrinterProvider.BAMBU)
        if not isinstance(provider, (str, PrinterProvider)):
            provider = PrinterProvider.BAMBU
        try:
            provider = PrinterProvider(provider)
        except ValueError as exc:
            raise UnsupportedPrinterProviderError(provider) from exc

        factory = self._factories.get(provider)
        if factory is None:
            raise UnsupportedPrinterProviderError(provider)
        return factory(printer, **kwargs)
