"""Regression tests for provider-neutral webhook status and controls."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient

from backend.app.services.printer_types import (
    NormalizedPrinterState,
    PrinterProvider,
    PrinterSnapshot,
)


def _snapshot(
    *,
    connected: bool,
    state: NormalizedPrinterState,
    filename: str | None = None,
    progress: float | None = None,
    remaining_seconds: int | None = None,
) -> PrinterSnapshot:
    return PrinterSnapshot(
        provider=PrinterProvider.BAMBU,
        connected=connected,
        state=state,
        filename=filename,
        progress=progress,
        remaining_seconds=remaining_seconds,
    )


@pytest.fixture
async def api_key_data(async_client: AsyncClient, db_session):
    """API key with read_status + control_printer scopes — covers status,
    stop, and cancel in a single fixture."""
    from backend.app.core.auth import generate_api_key
    from backend.app.models.api_key import APIKey

    full_key, key_hash, key_prefix = generate_api_key()
    api_key = APIKey(
        name="webhook-status-test-key",
        key_hash=key_hash,
        key_prefix=key_prefix,
        can_read_status=True,
        can_control_printer=True,
        enabled=True,
    )
    db_session.add(api_key)
    await db_session.commit()
    return full_key


@pytest.fixture
async def printer_row(db_session):
    from backend.app.models.printer import Printer

    printer = Printer(
        name="StatusTest",
        ip_address="192.168.1.44",
        access_code="12345678",
        serial_number="00M00A000000010",
        model="P1S",
    )
    db_session.add(printer)
    await db_session.commit()
    return printer


class TestWebhookGetPrinterStatus:
    """``GET /api/v1/webhook/printer/{id}/status`` uses normalized snapshots."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_200_with_connected_dataclass_status(
        self,
        async_client: AsyncClient,
        api_key_data,
        printer_row,
    ):
        """A live normalized snapshot maps into the webhook response."""
        state = _snapshot(
            connected=True,
            state=NormalizedPrinterState.PRINTING,
            filename="bench.3mf",
            progress=42.0,
            remaining_seconds=1234,
        )
        with patch(
            "backend.app.api.routes.webhook.printer_manager.get_snapshot",
            MagicMock(return_value=state),
        ):
            resp = await async_client.get(
                f"/api/v1/webhook/printer/{printer_row.id}/status",
                headers={"X-API-Key": api_key_data},
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == printer_row.id
        assert body["name"] == "StatusTest"
        assert body["connected"] is True
        assert body["state"] == "printing"
        assert body["current_print"] == "bench.3mf"
        assert body["progress"] == 42.0
        assert body["remaining_time"] == 1234

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_200_when_status_is_none(
        self,
        async_client: AsyncClient,
        api_key_data,
        printer_row,
    ):
        """An unseen registered printer still returns sensible defaults."""
        with patch(
            "backend.app.api.routes.webhook.printer_manager.get_snapshot",
            MagicMock(return_value=None),
        ):
            resp = await async_client.get(
                f"/api/v1/webhook/printer/{printer_row.id}/status",
                headers={"X-API-Key": api_key_data},
            )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["id"] == printer_row.id
        assert body["connected"] is False
        assert body["state"] is None
        assert body["current_print"] is None
        assert body["progress"] is None
        assert body["remaining_time"] is None

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_404_when_printer_does_not_exist(
        self,
        async_client: AsyncClient,
        api_key_data,
    ):
        resp = await async_client.get(
            "/api/v1/webhook/printer/99999/status",
            headers={"X-API-Key": api_key_data},
        )
        assert resp.status_code == 404


class TestWebhookStopPrint:
    """``POST /api/v1/webhook/printer/{id}/stop`` uses normalized state."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_503_when_disconnected(
        self,
        async_client: AsyncClient,
        api_key_data,
        printer_row,
    ):
        state = _snapshot(connected=False, state=NormalizedPrinterState.OFFLINE)
        with patch(
            "backend.app.api.routes.webhook.printer_manager.get_snapshot",
            MagicMock(return_value=state),
        ):
            resp = await async_client.post(
                f"/api/v1/webhook/printer/{printer_row.id}/stop",
                headers={"X-API-Key": api_key_data},
            )
        # Pre-fix this would have 500'd on `status.get(...)`. Now it
        # cleanly returns the documented 503.
        assert resp.status_code == 503

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_409_when_not_running(
        self,
        async_client: AsyncClient,
        api_key_data,
        printer_row,
    ):
        state = _snapshot(connected=True, state=NormalizedPrinterState.COMPLETED)
        with patch(
            "backend.app.api.routes.webhook.printer_manager.get_snapshot",
            MagicMock(return_value=state),
        ):
            resp = await async_client.post(
                f"/api/v1/webhook/printer/{printer_row.id}/stop",
                headers={"X-API-Key": api_key_data},
            )
        assert resp.status_code == 409

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stops_normalized_printing_snapshot(self, async_client, api_key_data, printer_row):
        state = _snapshot(connected=True, state=NormalizedPrinterState.PRINTING)
        with (
            patch("backend.app.api.routes.webhook.printer_manager.get_snapshot", return_value=state),
            patch(
                "backend.app.api.routes.webhook.printer_manager.stop_print_async",
                new=AsyncMock(return_value=True),
            ) as stop,
        ):
            resp = await async_client.post(
                f"/api/v1/webhook/printer/{printer_row.id}/stop",
                headers={"X-API-Key": api_key_data},
            )

        assert resp.status_code == 200
        stop.assert_awaited_once_with(printer_row.id)


class TestWebhookCancelPrint:
    """``POST /api/v1/webhook/printer/{id}/cancel`` — same fix shape."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_503_when_disconnected(
        self,
        async_client: AsyncClient,
        api_key_data,
        printer_row,
    ):
        state = _snapshot(connected=False, state=NormalizedPrinterState.OFFLINE)
        with patch(
            "backend.app.api.routes.webhook.printer_manager.get_snapshot",
            MagicMock(return_value=state),
        ):
            resp = await async_client.post(
                f"/api/v1/webhook/printer/{printer_row.id}/cancel",
                headers={"X-API-Key": api_key_data},
            )
        assert resp.status_code == 503

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_409_when_not_running_or_paused(
        self,
        async_client: AsyncClient,
        api_key_data,
        printer_row,
    ):
        state = _snapshot(connected=True, state=NormalizedPrinterState.IDLE)
        with patch(
            "backend.app.api.routes.webhook.printer_manager.get_snapshot",
            MagicMock(return_value=state),
        ):
            resp = await async_client.post(
                f"/api/v1/webhook/printer/{printer_row.id}/cancel",
                headers={"X-API-Key": api_key_data},
            )
        assert resp.status_code == 409

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_cancels_normalized_paused_snapshot(self, async_client, api_key_data, printer_row):
        state = _snapshot(connected=True, state=NormalizedPrinterState.PAUSED)
        with (
            patch("backend.app.api.routes.webhook.printer_manager.get_snapshot", return_value=state),
            patch(
                "backend.app.api.routes.webhook.printer_manager.stop_print_async",
                new=AsyncMock(return_value=True),
            ) as stop,
        ):
            resp = await async_client.post(
                f"/api/v1/webhook/printer/{printer_row.id}/cancel",
                headers={"X-API-Key": api_key_data},
            )

        assert resp.status_code == 200
        stop.assert_awaited_once_with(printer_row.id)
