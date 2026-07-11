"""Provider-to-backend factory registry."""

from collections.abc import Callable
from typing import Any

from backend.app.services.printer_backend import PrinterBackend, UnsupportedPrinterProviderError
from backend.app.services.printer_types import PrinterProvider

BackendFactory = Callable[..., PrinterBackend]
_MISSING = object()


class PrinterBackendRegistry:
    def __init__(self):
        self._factories: dict[PrinterProvider, BackendFactory] = {}

    def register(self, provider: PrinterProvider, factory: BackendFactory) -> None:
        self._factories[provider] = factory

    def create(self, printer: Any, **kwargs: Any) -> PrinterBackend:
        provider = getattr(printer, "provider", _MISSING)
        if provider is _MISSING:
            provider = PrinterProvider.BAMBU
        elif not isinstance(provider, (str, PrinterProvider)):
            raise UnsupportedPrinterProviderError(provider)
        try:
            provider = PrinterProvider(provider)
        except (TypeError, ValueError) as exc:
            raise UnsupportedPrinterProviderError(provider) from exc

        factory = self._factories.get(provider)
        if factory is None:
            raise UnsupportedPrinterProviderError(provider)
        return factory(printer, **kwargs)
