from types import SimpleNamespace

import pytest

from backend.app.services.printer_backend import UnsupportedPrinterProviderError
from backend.app.services.printer_backend_registry import PrinterBackendRegistry
from backend.app.services.printer_types import PrinterProvider


def test_registry_creates_registered_bambu_backend():
    backend = object()
    registry = PrinterBackendRegistry()
    registry.register(PrinterProvider.BAMBU, lambda printer, **_: backend)

    assert registry.create(SimpleNamespace(provider="bambu")) is backend


def test_registry_rejects_unknown_provider_with_safe_visible_error():
    registry = PrinterBackendRegistry()

    with pytest.raises(UnsupportedPrinterProviderError, match="Unsupported printer provider: unknown"):
        registry.create(SimpleNamespace(provider="unknown"))
