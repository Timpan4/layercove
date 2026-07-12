from dataclasses import asdict

import pytest
from pydantic import ValidationError

from backend.app.schemas.printer import MoonrakerPrinterConfigInput, PrinterCreate
from backend.app.services.printer_types import (
    NormalizedPrinterState,
    PrinterProvider,
    PrinterSnapshot,
    capabilities_for_provider,
)


def test_existing_bambu_create_defaults_provider_and_keeps_required_fields():
    printer = PrinterCreate(
        name="X1C",
        serial_number=" 01p00abc ",
        ip_address="192.168.1.20",
        access_code="12345678",
    )

    assert printer.provider is PrinterProvider.BAMBU
    assert printer.serial_number == "01P00ABC"
    assert printer.moonraker_config is None


@pytest.mark.parametrize("missing", ["serial_number", "ip_address", "access_code"])
def test_bambu_create_rejects_missing_connection_field(missing):
    data = {
        "name": "X1C",
        "serial_number": "01P00ABC",
        "ip_address": "192.168.1.20",
        "access_code": "12345678",
    }
    data.pop(missing)

    with pytest.raises(ValidationError, match=missing):
        PrinterCreate(**data)


def test_moonraker_create_accepts_only_focused_config_and_normalizes_urls():
    printer = PrinterCreate(
        name="Voron",
        provider="moonraker",
        moonraker_config={
            "base_url": "HTTPS://Klipper.Local:7125/",
            "websocket_url_override": "WSS://Klipper.Local:7125/websocket",
            "api_key": "secret-token",
        },
    )

    assert printer.provider is PrinterProvider.MOONRAKER
    assert printer.serial_number is None
    assert printer.ip_address is None
    assert printer.access_code is None
    assert printer.moonraker_config == MoonrakerPrinterConfigInput(
        base_url="https://klipper.local:7125",
        websocket_url_override="wss://klipper.local:7125/websocket",
        api_key="secret-token",
    )


def test_moonraker_create_rejects_bambu_fields_and_multiple_auth_values():
    with pytest.raises(ValidationError):
        PrinterCreate(
            name="Voron",
            provider="moonraker",
            serial_number="FAKE",
            moonraker_config={
                "base_url": "http://klipper.local:7125",
                "api_key": "secret-token",
                "authorization": "Bearer other-secret",
            },
        )


def test_moonraker_base_url_allows_private_lan_address():
    config = MoonrakerPrinterConfigInput(base_url="http://192.168.1.20:7125")

    assert config.base_url == "http://192.168.1.20:7125"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://klipper.local",
        "http://user:password@klipper.local",
        "http://klipper.local/path",
        "http://klipper.local?token=secret",
        "http://127.0.0.1:7125",
        "http://169.254.169.254:7125",
        "http://100.100.100.200:7125",
        "http://224.0.0.1:7125",
        "http://0.0.0.0:7125",
        "http://2130706433:7125",
        "http://0x7f000001:7125",
        "http://127.1:7125",
    ],
)
def test_moonraker_base_url_rejects_non_origin_or_embedded_credentials(url):
    with pytest.raises(ValidationError):
        MoonrakerPrinterConfigInput(base_url=url)


def test_normalized_state_and_capabilities_are_exact_mvp_contract():
    assert {state.value for state in NormalizedPrinterState} == {
        "offline",
        "connecting",
        "idle",
        "preparing",
        "printing",
        "paused",
        "completed",
        "cancelled",
        "error",
        "unknown",
    }

    moonraker = asdict(capabilities_for_provider(PrinterProvider.MOONRAKER))
    assert set(moonraker) == {
        "upload_gcode",
        "upload_3mf",
        "start_print",
        "pause",
        "resume",
        "cancel",
        "emergency_stop",
        "camera",
        "bed_temperature",
        "extruder_temperature",
        "chamber_temperature",
        "ams",
        "plate_selection",
        "speed_control",
        "firmware_information",
        "object_cancellation",
    }
    assert moonraker["upload_gcode"] is False
    assert moonraker["upload_3mf"] is False
    assert moonraker["emergency_stop"] is False
    assert moonraker["ams"] is False
    assert moonraker["plate_selection"] is False
    assert not any(moonraker.values())


def test_normalized_snapshot_keeps_provider_detail_internal_to_backend_contract():
    snapshot = PrinterSnapshot(
        provider=PrinterProvider.MOONRAKER,
        connected=True,
        state=NormalizedPrinterState.PRINTING,
        filename="cube.gcode",
        progress=42.5,
        provider_detail={"raw": "never serialized by printer response"},
    )

    assert snapshot.state is NormalizedPrinterState.PRINTING
    assert snapshot.provider_detail == {"raw": "never serialized by printer response"}
