from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from backend.app.services.spoolman_tracking import _report_moonraker_usage


@pytest.mark.asyncio
async def test_moonraker_completed_usage_charges_selected_spool_once():
    client = SimpleNamespace(use_spool=AsyncMock())
    tracking = SimpleNamespace(
        filament_usage=[{"slot_id": 1, "used_g": 12.345}],
        spoolman_spool_id=42,
    )
    with patch(
        "backend.app.services.spoolman_tracking._get_spoolman_client_with_fallback",
        AsyncMock(return_value=client),
    ):
        await _report_moonraker_usage(tracking, completed=True)

    client.use_spool.assert_awaited_once_with(42, 12.35)


@pytest.mark.asyncio
async def test_moonraker_partial_usage_is_progress_scaled_and_bounded():
    client = SimpleNamespace(use_spool=AsyncMock())
    tracking = SimpleNamespace(
        filament_usage=[{"slot_id": 1, "used_g": 20.0}],
        spoolman_spool_id=7,
    )
    with patch(
        "backend.app.services.spoolman_tracking._get_spoolman_client_with_fallback",
        AsyncMock(return_value=client),
    ):
        await _report_moonraker_usage(tracking, completed=False, progress=25)

    client.use_spool.assert_awaited_once_with(7, 5.0)


@pytest.mark.asyncio
@pytest.mark.parametrize("progress", [None, 0])
async def test_moonraker_partial_usage_without_progress_does_not_charge(progress):
    client = SimpleNamespace(use_spool=AsyncMock())
    tracking = SimpleNamespace(
        filament_usage=[{"slot_id": 1, "used_g": 20.0}],
        spoolman_spool_id=7,
    )
    with patch(
        "backend.app.services.spoolman_tracking._get_spoolman_client_with_fallback",
        AsyncMock(return_value=client),
    ):
        await _report_moonraker_usage(tracking, completed=False, progress=progress)

    client.use_spool.assert_not_awaited()
