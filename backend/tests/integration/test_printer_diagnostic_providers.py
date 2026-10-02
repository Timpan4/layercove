"""Public provider diagnostics with stored configuration and inert printer state."""

import ipaddress
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
from backend.app.services import moonraker_http, printer_diagnostic
from backend.app.services.diagnostic_snapshot import collect_diagnostic_snapshot
from backend.app.services.printer_manager import PrinterManager
from backend.app.services.printer_types import NormalizedPrinterState, PrinterProvider, PrinterSnapshot


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("entry_point", ["saved_printer", "support_snapshot"])
@pytest.mark.parametrize(
    ("api_status", "snapshot_state", "api_check", "state_check", "overall"),
    [
        (200, NormalizedPrinterState.COMPLETED, "pass", "pass", "ok"),
        (503, NormalizedPrinterState.COMPLETED, "fail", "pass", "problems"),
        (200, None, "pass", "warn", "warnings"),
        (200, NormalizedPrinterState.UNKNOWN, "pass", "warn", "warnings"),
    ],
)
async def test_moonraker_diagnostic_reports_api_and_klipper_evidence(
    async_client,
    printer_factory,
    test_engine,
    monkeypatch,
    entry_point,
    api_status,
    snapshot_state,
    api_check,
    state_check,
    overall,
):
    config = MoonrakerPrinterConfig(base_url="http://fixture-printer.lan:7125")
    config.api_key = "fictional-diagnostic-secret"
    printer = await printer_factory(
        name="Fictional Voron",
        provider="moonraker",
        model="Voron",
        moonraker_config=config,
    )
    manager = PrinterManager()
    if snapshot_state is not None:
        snapshot = PrinterSnapshot(
            provider=PrinterProvider.MOONRAKER,
            connected=True,
            state=snapshot_state,
        )
        manager._backends[printer.id] = SimpleNamespace(snapshot=lambda: snapshot)
    monkeypatch.setattr(printer_diagnostic, "printer_manager", manager)

    # All traffic stays in this native client transport. Stored encrypted
    # credentials must reach its GET request, while responses never expose them.
    requests = []
    native_client = moonraker_http.MoonrakerHTTPClient

    async def resolver(host, port):
        return {ipaddress.ip_address("192.168.1.25")}

    def respond(request):
        requests.append(request)
        return httpx.Response(api_status, json={"result": {"klippy_connected": True}})

    def client_factory(**options):
        return native_client(
            **options,
            resolver=resolver,
            transport_factory=lambda *_: httpx.MockTransport(respond),
        )

    monkeypatch.setattr(moonraker_http, "MoonrakerHTTPClient", client_factory)
    monkeypatch.setattr(printer_diagnostic, "MoonrakerHTTPClient", client_factory, raising=False)
    # The unfixed Bambu path must also stay entirely inert. Closed Bambu ports
    # reproduce the reported false failure without contacting any device.
    monkeypatch.setattr(printer_diagnostic, "_check_port", AsyncMock(return_value=False))
    monkeypatch.setattr(printer_diagnostic, "is_running_in_docker", lambda: False)
    monkeypatch.setattr(printer_diagnostic, "_get_host_ip", lambda: None)
    monkeypatch.setattr(
        "backend.app.services.diagnostic_snapshot._run_log_health",
        AsyncMock(return_value={"findings": []}),
    )

    if entry_point == "saved_printer":
        response = await async_client.get(f"/api/v1/printers/{printer.id}/diagnostic")
        assert response.status_code == 200
        result = response.json()
    else:
        # A new session exercises the collector's actual relationship loading,
        # rather than reusing the configured printer in the factory identity map.
        async with async_sessionmaker(test_engine, expire_on_commit=False)() as db:
            bundle_snapshot = await collect_diagnostic_snapshot(db)
        assert len(bundle_snapshot["connection_diagnostics"]) == 1
        entry = bundle_snapshot["connection_diagnostics"][0]
        assert "error" not in entry
        result = entry["result"]

    checks = {check["id"]: check for check in result["checks"]}
    assert set(checks) == {"moonraker_api", "klipper_state"}
    assert checks["moonraker_api"]["status"] == api_check
    assert checks["klipper_state"]["status"] == state_check
    assert result["overall"] == overall
    assert "fictional-diagnostic-secret" not in str(result)
    assert requests
    assert all(request.method == "GET" and request.url.path == "/server/info" for request in requests)
    assert all(request.headers.get("X-Api-Key") == "fictional-diagnostic-secret" for request in requests)
