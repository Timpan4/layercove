"""Public support ZIP output for inert Moonraker and Bambu printers."""

import io
import ipaddress
import json
import zipfile
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.api.routes import support
from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
from backend.app.models.settings import Settings
from backend.app.services import diagnostic_snapshot, moonraker_http, printer_diagnostic, spoolman
from backend.app.services.bambu_mqtt import PrinterState
from backend.app.services.printer_manager import PrinterManager
from backend.app.services.printer_types import NormalizedPrinterState, PrinterProvider, PrinterSnapshot


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("fleet", ["moonraker", "mixed", "bambu"])
async def test_public_support_bundle_preserves_provider_output_and_redaction(
    async_client,
    db_session,
    printer_factory,
    test_engine,
    monkeypatch,
    tmp_path,
    caplog,
    fleet,
):
    manager = PrinterManager()
    printers = []
    sensitive = []
    config = None
    if fleet != "bambu":
        config = MoonrakerPrinterConfig(base_url="http://fixture-printer.lan:7125")
        config.api_key = "fictional-support-diagnostic-secret"
        sensitive.extend([config.api_key, config.api_key_ciphertext])
        moon = await printer_factory(
            name="Fictional Voron",
            provider="moonraker",
            model="Voron",
            moonraker_config=config,
        )
        printers.append(moon)
        snapshot = PrinterSnapshot(
            provider=PrinterProvider.MOONRAKER,
            connected=True,
            state=NormalizedPrinterState.IDLE,
            message=moon.name,
            filename="fictional-private-part.gcode",
            provider_detail={"private": "fictional-support-diagnostic-secret"},
        )
        manager._backends[moon.id] = SimpleNamespace(snapshot=lambda: snapshot)
    if fleet != "moonraker":
        bambu = await printer_factory(name="Fictional Bambu", provider="bambu", model="H2C")
        printers.append(bambu)
        raw_data = {
            "ams": {
                "ams": [
                    {
                        "id": "0",
                        "tray": [
                            {"id": "0", "tray_type": "PLA", "uuid": bambu.serial_number},
                            {"id": "1", "tray_type": "PETG"},
                            {"id": "2", "tray_type": ""},
                        ],
                    }
                ]
            },
            "vt_tray": {"tray_type": "ABS"},
            "cfg": "40000",
            "subtask_name": "fictional-private-part.gcode",
            "gcode_file": "private.3mf",
            "net": {"info": [{"ip": bambu.ip_address}]},
            "private_name": bambu.name,
        }
        bambu_state = PrinterState(
            connected=True,
            state="IDLE",
            firmware_version="01.09.01.00",
            wifi_signal=-42,
            raw_data=raw_data,
            hms_errors=[{"code": "fixture-hms"}],
            nozzle_rack=[{"id": 0}, {"id": 1}],
            developer_mode=True,
        )
        manager._clients[bambu.id] = SimpleNamespace(
            state=bambu_state,
            check_staleness=lambda: True,
            report_messages_since_connect=1,
        )
    for printer in printers:
        sensitive.extend([printer.name, printer.ip_address, printer.serial_number, printer.access_code])
    sensitive.append("fictional-private-part.gcode")
    db_session.add(Settings(key="debug_logging_enabled", value="true"))
    await db_session.commit()
    monkeypatch.setattr(support, "printer_manager", manager)
    monkeypatch.setattr(printer_diagnostic, "printer_manager", manager)
    session_factory = async_sessionmaker(test_engine, expire_on_commit=False)

    @asynccontextmanager
    async def test_session():
        async with session_factory() as db:
            yield db

    monkeypatch.setattr(support, "async_session", test_session)
    monkeypatch.setattr(support, "is_running_in_docker", lambda: False)
    monkeypatch.setattr(printer_diagnostic, "is_running_in_docker", lambda: False)
    monkeypatch.setattr(printer_diagnostic, "_get_host_ip", lambda: None)
    tcp_probes = []

    async def inert_port_probe(host, port):
        tcp_probes.append((host, port))
        return False

    monkeypatch.setattr(support, "_check_port", inert_port_probe)
    monkeypatch.setattr(printer_diagnostic, "_check_port", inert_port_probe)
    monkeypatch.setattr(support, "_fetch_slicer_health", AsyncMock(return_value=None))
    monkeypatch.setattr(spoolman, "get_spoolman_client", AsyncMock(return_value=None))
    monkeypatch.setattr(diagnostic_snapshot, "_run_log_health", AsyncMock(return_value={"findings": []}))
    requests = []
    native_client = moonraker_http.MoonrakerHTTPClient

    async def resolver(host, port):
        return {ipaddress.ip_address("192.168.1.25")}

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"result": {"klippy_connected": True}})

    def inert_moonraker_client(**options):
        return native_client(
            **options,
            resolver=resolver,
            transport_factory=lambda *_: httpx.MockTransport(respond),
        )

    monkeypatch.setattr(printer_diagnostic, "MoonrakerHTTPClient", inert_moonraker_client)
    monkeypatch.setattr(support.settings, "log_dir", tmp_path)
    log = "2026-10-02 00:00:00,000 INFO inert fixture " + " ".join(sensitive[:-1])
    (tmp_path / "bambuddy.log").write_text(log + "\n")
    response = await async_client.get("/api/v1/support/bundle")

    assert response.status_code == 200, f"support bundle failed with HTTP {response.status_code}"
    assert response.headers["content-type"].startswith("application/zip")
    with zipfile.ZipFile(io.BytesIO(response.content)) as bundle:
        entries = {name: bundle.read(name).decode() for name in bundle.namelist()}
    for text in entries.values():
        for token in sensitive:
            assert token not in text
    support_info = json.loads(entries["support-info.json"])
    assert len(support_info["printers"]) == len(printers)
    diagnostics = support_info["diagnostics"]["connection_diagnostics"]
    assert len(diagnostics) == len(printers)
    assert all("error" not in diagnostic for diagnostic in diagnostics)
    assert "Connection diagnostic failed" not in caplog.text
    for index, printer in enumerate(printers, 1):
        summary = support_info["printers"][index - 1]
        assert summary["index"] == index
        assert summary["model"] == printer.model
        if printer.provider == "moonraker":
            assert summary["provider"] == "moonraker"
            assert summary["connected"] is True
            assert summary["state"] == "idle"
            assert summary["telemetry_stale"] is False
            assert (
                not {"mqtt_connected", "reachable", "ams_unit_count", "hms_error_count", "nozzle_rack_count"}
                & summary.keys()
            )
            assert f"push-status/printer-{index}.json" not in entries
            checks = diagnostics[index - 1]["result"]["checks"]
            assert {check["id"] for check in checks} == {"moonraker_api", "klipper_state"}
            assert all(check["status"] == "pass" for check in checks)
            assert not any(host == printer.ip_address for host, _ in tcp_probes)
        else:
            assert summary["mqtt_connected"] is True
            assert summary["state"] == "IDLE"
            assert summary["firmware_version"] == "01.09.01.00"
            assert summary["wifi_signal"] == -42
            assert summary["ams_unit_count"] == 1
            assert summary["ams_tray_count"] == 2
            assert summary["has_vt_tray"] is True
            assert summary["hms_error_count"] == 1
            assert summary["nozzle_rack_count"] == 2
            dump = json.loads(entries[f"push-status/printer-{index}.json"])
            assert dump["model"] == "H2C"
            assert dump["firmware_version"] == "01.09.01.00"
            assert dump["raw_data"]["cfg"] == "40000"
            assert dump["raw_data"]["ams"]["ams"][0]["tray"][0]["tray_type"] == "PLA"
            assert dump["raw_data"]["vt_tray"]["tray_type"] == "ABS"
            assert dump["raw_data"]["net"]["info"][0]["ip"] == "[IP]"
            assert "subtask_name" not in dump["raw_data"]
            assert "gcode_file" not in dump["raw_data"]
            assert bambu_state.raw_data == raw_data
    if fleet != "bambu":
        assert any(request.method == "GET" and request.url.path == "/server/info" for request in requests)
