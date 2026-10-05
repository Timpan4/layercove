"""Specific-printer queue items enforce "Force color match" like model-based ones."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.app.services import print_scheduler as scheduler_module
from backend.app.services.print_scheduler import PrintScheduler

OVERRIDES = [{"slot_id": 1, "type": "PLA", "color": "#FF0000", "force_color_match": True}]


def _item():
    return SimpleNamespace(
        id=1,
        printer_id=7,
        scheduled_time=None,
        manual_start=False,
        waiting_reason=None,
        require_previous_success=False,
        ams_mapping="[0]",
        filament_overrides=json.dumps(OVERRIDES),
        target_model=None,
    )


def _status(tray_color: str):
    return SimpleNamespace(raw_data={"ams": [{"tray": [{"tray_type": "PLA", "tray_color": tray_color}]}]})


async def _dispatch(tray_color: str):
    scheduler = PrintScheduler()
    item = _item()
    db = AsyncMock()
    with (
        patch.object(scheduler_module.printer_manager, "is_connected", return_value=True),
        patch.object(scheduler_module.printer_manager, "get_backend", return_value=None),
        patch.object(scheduler_module.printer_manager, "get_status", return_value=_status(tray_color)),
        patch.object(scheduler, "_is_printer_idle", return_value=True),
        patch.object(scheduler, "_block_on_filament_deficit", AsyncMock(return_value=False)),
        patch.object(scheduler, "_start_print", AsyncMock()) as start_print,
    ):
        await scheduler._dispatch_pending_item(db, item, set(), {}, False, False)
    return item, start_print


@pytest.mark.asyncio
async def test_wrong_loaded_color_blocks_specific_printer_job():
    item, start_print = await _dispatch("00FF00FF")

    start_print.assert_not_called()
    assert item.waiting_reason == "No matching material/color. Waiting on PLA (#FF0000)"


@pytest.mark.asyncio
async def test_matching_loaded_color_starts_specific_printer_job():
    item, start_print = await _dispatch("FF0000FF")

    start_print.assert_awaited_once()
    assert item.waiting_reason is None
