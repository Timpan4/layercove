from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
from backend.app.models.printer import Printer
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_manager import init_printer_connections


async def _stored_moonraker(db_session, name):
    printer = Printer(name=name, provider="moonraker", is_active=True)
    printer.moonraker_config = MoonrakerPrinterConfig(base_url="http://klipper.local:7125")
    db_session.add(printer)
    await db_session.commit()
    printer_id = printer.id
    db_session.expire_all()
    return printer_id


@pytest.mark.asyncio
async def test_startup_eager_loads_moonraker_config_before_connect(db_session):
    printer_id = await _stored_moonraker(db_session, "Startup Klipper")
    connected = []

    async def connect(printer):
        connected.append((printer.id, printer.moonraker_config.base_url))
        return True

    with patch(
        "backend.app.services.printer_manager.printer_manager.connect_printer",
        new=AsyncMock(side_effect=connect),
    ):
        await init_printer_connections(db_session)

    assert (printer_id, "http://klipper.local:7125") in connected


@pytest.mark.asyncio
async def test_smart_plug_reconnect_eager_loads_moonraker_config(db_session):
    printer_id = await _stored_moonraker(db_session, "Powered Klipper")
    scheduler = PrintScheduler()
    scheduler._power_on_wait_time = 31
    service = AsyncMock()
    service.get_status.return_value = {"reachable": True, "state": "ON"}

    async def connect(printer):
        assert printer.moonraker_config.base_url == "http://klipper.local:7125"
        return True

    with (
        patch(
            "backend.app.services.print_scheduler.smart_plug_manager.get_service_for_plug",
            new=AsyncMock(return_value=service),
        ),
        patch(
            "backend.app.services.print_scheduler.printer_manager.connect_printer",
            new=AsyncMock(side_effect=connect),
        ),
        patch("backend.app.services.print_scheduler.asyncio.sleep", new=AsyncMock()),
    ):
        assert await scheduler._power_on_and_wait(SimpleNamespace(name="Klipper plug"), printer_id, db_session)
