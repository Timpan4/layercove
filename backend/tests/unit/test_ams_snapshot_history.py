"""Actual normalized snapshots must not abort AMS history for other printers."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app import main
from backend.app.models.ams_history import AMSSensorHistory
from backend.app.services.bambu_backend import BambuBackend
from backend.app.services.bambu_mqtt import PrinterState
from backend.app.services.printer_types import NormalizedPrinterState, PrinterProvider, PrinterSnapshot


@pytest.mark.asyncio
async def test_history_skips_voron_and_records_loaded_and_empty_bambu_units(caplog):
    state = PrinterState(connected=True, state="IDLE")
    state.raw_data = {
        "ams": [
            {
                "id": "0",
                "humidity_raw": "80",
                "temp": "40",
                "tray_exist_bits": "1",
                "tray": [{"id": "0", "tray_type": "PA"}],
            },
            {"id": "1", "humidity_raw": "80", "temp": "40", "tray_exist_bits": "0", "tray": []},
            {"id": "128", "humidity": "4", "temp": "bad", "tray": [{"id": "0", "tray_type": "PLA"}]},
        ]
    }
    client = MagicMock(state=state)
    client.is_stale.return_value = False
    backend = BambuBackend(
        SimpleNamespace(ip_address="192.168.1.2", serial_number="SERIAL", access_code="code", model="H2D"),
        client_factory=lambda **kwargs: client,
        emit=lambda event: None,
    )
    snapshots = {
        1: PrinterSnapshot(PrinterProvider.MOONRAKER, True, NormalizedPrinterState.IDLE),
        2: backend.snapshot(),
    }
    printers = [SimpleNamespace(id=1, name="Voron"), SimpleNamespace(id=2, name="Bambu")]
    printer_result = MagicMock()
    printer_result.scalars.return_value.all.return_value = printers
    no_setting = MagicMock()
    no_setting.scalar_one_or_none.return_value = None
    threshold_setting = MagicMock()
    threshold_setting.scalar_one_or_none.return_value = SimpleNamespace(value='{"PA": 20}')
    db = MagicMock()
    db.execute = AsyncMock(side_effect=[printer_result, no_setting, no_setting, threshold_setting])
    db.commit = AsyncMock()
    session = MagicMock()
    session.__aenter__ = AsyncMock(return_value=db)
    session.__aexit__ = AsyncMock(return_value=False)
    notifications = SimpleNamespace(
        on_ams_humidity_high=AsyncMock(),
        on_ams_temperature_high=AsyncMock(),
        on_ams_ht_humidity_high=AsyncMock(),
        on_ams_ht_temperature_high=AsyncMock(),
    )

    async def finish_after_one_recording(seconds):
        if seconds != 10:
            raise asyncio.CancelledError

    with (
        patch.object(main, "async_session", return_value=session),
        patch.object(main.printer_manager, "get_status", side_effect=snapshots.get),
        patch.object(main.printer_manager, "get_snapshot", side_effect=snapshots.get),
        patch.object(main, "notification_service", notifications),
        patch.object(main, "_ams_alarm_cooldown", {}),
        patch.object(main, "_ams_cleanup_counter", 0),
        patch.object(main.asyncio, "sleep", side_effect=finish_after_one_recording),
    ):
        try:
            await main.record_ams_history()
        except asyncio.CancelledError:
            pass

    history = [call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], AMSSensorHistory)]
    assert [(h.printer_id, h.ams_id, h.humidity, h.humidity_raw, h.temperature) for h in history] == [
        (2, 0, 80.0, 80.0, 40.0),
        (2, 1, 80.0, 80.0, 40.0),
        (2, 128, 4.0, None, None),
    ]
    assert [call.args[:5] for call in notifications.on_ams_humidity_high.await_args_list] == [
        (2, "Bambu", "AMS-A", 80.0, 20.0),
    ]
    assert [call.args[:5] for call in notifications.on_ams_temperature_high.await_args_list] == [
        (2, "Bambu", "AMS-A", 40.0, 35.0),
    ]
    assert not notifications.on_ams_ht_humidity_high.await_args_list
    assert "AMS history recording failed" not in caplog.text
