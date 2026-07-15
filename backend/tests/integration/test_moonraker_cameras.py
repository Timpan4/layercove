import json
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
from backend.app.models.printer_camera import PrinterCamera
from backend.app.services.moonraker_http import MoonrakerHTTPResponse


class FakeWebcamClient:
    def __init__(self, webcams, tested=None):
        self.webcams = webcams
        self.tested = tested or {}

    async def list_webcams(self):
        return MoonrakerHTTPResponse(
            status_code=200,
            headers={},
            body=json.dumps({"result": {"webcams": self.webcams}}).encode(),
        )

    async def test_webcam(self, uid):
        return MoonrakerHTTPResponse(
            status_code=200,
            headers={},
            body=json.dumps({"result": self.tested.get(uid, {})}).encode(),
        )


@pytest.mark.asyncio
async def test_sync_discovers_moonraker_camera_and_translates_loopback_url(db_session, printer_factory):
    from backend.app.services.moonraker_cameras import sync_moonraker_cameras

    printer = await printer_factory(
        provider="moonraker",
        external_camera_url="http://printer.lan/webcam/?action=stream",
        external_camera_type="mjpeg",
        external_camera_enabled=True,
        camera_rotation=180,
    )
    db_session.add(MoonrakerPrinterConfig(printer_id=printer.id, base_url="http://printer.lan:7125"))
    await db_session.flush()

    client = FakeWebcamClient(
        [
            {
                "uid": "cam-1",
                "name": "Toolhead",
                "location": "printer",
                "service": "mjpegstreamer",
                "enabled": True,
                "stream_url": "/webcam/?action=stream",
                "snapshot_url": "/webcam/?action=snapshot",
                "rotation": 0,
            }
        ],
        {
            "cam-1": {
                "stream_url": "http://127.0.0.1:80/webcam/?action=stream",
                "snapshot_url": "http://localhost:80/webcam/?action=snapshot",
                "snapshot_reachable": True,
            }
        },
    )

    cameras = await sync_moonraker_cameras(db_session, printer, client=client)
    await db_session.commit()

    assert len(cameras) == 1
    camera = cameras[0]
    assert camera.source_uid == "cam-1"
    assert camera.stream_url == "http://printer.lan/webcam/?action=stream"
    assert camera.snapshot_url == "http://printer.lan/webcam/?action=snapshot"
    assert camera.camera_type == "mjpeg"
    assert camera.is_primary is True
    assert camera.rotation == 180


@pytest.mark.asyncio
async def test_sync_marks_missing_camera_without_deleting_history(db_session, printer_factory):
    from backend.app.services.moonraker_cameras import sync_moonraker_cameras

    printer = await printer_factory(provider="moonraker")
    db_session.add(MoonrakerPrinterConfig(printer_id=printer.id, base_url="http://printer.lan:7125"))
    camera = PrinterCamera(
        printer_id=printer.id,
        source="moonraker",
        source_uid="gone",
        name="Old camera",
        camera_type="mjpeg",
        stream_url="http://printer.lan/webcam/old",
        is_primary=True,
    )
    db_session.add(camera)
    await db_session.flush()

    await sync_moonraker_cameras(db_session, printer, client=FakeWebcamClient([]))
    await db_session.commit()

    stored = (await db_session.execute(select(PrinterCamera).where(PrinterCamera.id == camera.id))).scalar_one()
    assert stored.missing_since is not None
    assert stored.stream_url == "http://printer.lan/webcam/old"


@pytest.mark.asyncio
async def test_effective_camera_falls_back_without_changing_saved_primary(db_session, printer_factory):
    from backend.app.services.moonraker_cameras import get_effective_camera

    printer = await printer_factory(provider="moonraker")
    primary = PrinterCamera(
        printer_id=printer.id,
        source="moonraker",
        source_uid="primary",
        name="Primary",
        camera_type="mjpeg",
        stream_url="http://printer.lan/primary",
        is_primary=True,
        missing_since=datetime.utcnow(),
    )
    fallback = PrinterCamera(
        printer_id=printer.id,
        source="moonraker",
        source_uid="fallback",
        name="Fallback",
        camera_type="snapshot",
        snapshot_url="http://printer.lan/fallback.jpg",
        sort_order=1,
    )
    db_session.add_all([primary, fallback])
    await db_session.flush()

    selected = await get_effective_camera(db_session, printer.id)

    assert selected is fallback
    assert primary.is_primary is True
    assert fallback.is_primary is False


@pytest.mark.asyncio
async def test_sync_clears_missing_state_when_uid_returns(db_session, printer_factory):
    from backend.app.services.moonraker_cameras import sync_moonraker_cameras

    printer = await printer_factory(provider="moonraker")
    db_session.add(MoonrakerPrinterConfig(printer_id=printer.id, base_url="http://printer.lan:7125"))
    camera = PrinterCamera(
        printer_id=printer.id,
        source="moonraker",
        source_uid="returning",
        name="Returning",
        camera_type="mjpeg",
        stream_url="http://printer.lan/old",
        missing_since=datetime.utcnow() - timedelta(days=2),
    )
    db_session.add(camera)
    await db_session.flush()

    await sync_moonraker_cameras(
        db_session,
        printer,
        client=FakeWebcamClient([
            {
                "uid": "returning",
                "name": "Returning",
                "service": "mjpegstreamer",
                "enabled": True,
                "stream_url": "/webcam/stream",
            }
        ]),
    )

    assert camera.missing_since is None
    assert camera.stream_url == "http://printer.lan/webcam/stream"


@pytest.mark.asyncio
async def test_unsupported_camera_keeps_protocol_and_uses_snapshot_fallback(
    async_client, db_session, printer_factory
):
    from backend.app.services.moonraker_cameras import get_effective_camera, sync_moonraker_cameras

    printer = await printer_factory(provider="moonraker")
    db_session.add(MoonrakerPrinterConfig(printer_id=printer.id, base_url="http://printer.lan:7125"))
    await db_session.flush()
    cameras = await sync_moonraker_cameras(
        db_session,
        printer,
        client=FakeWebcamClient([
            {
                "uid": "webrtc-1",
                "name": "WebRTC camera",
                "service": "webrtc-go2rtc",
                "enabled": True,
                "stream_url": "/webcam/webrtc",
                "snapshot_url": "/webcam/snapshot.jpg",
            }
        ]),
    )
    await db_session.commit()

    camera = cameras[0]
    assert camera.camera_type == "unsupported"
    assert await get_effective_camera(db_session, printer.id) is camera

    fake_jpeg = b"\xff\xd8image\xff\xd9"
    with patch(
        "backend.app.services.external_camera.capture_frame", new_callable=AsyncMock, return_value=fake_jpeg
    ) as capture:
        response = await async_client.get(
            f"/api/v1/printers/{printer.id}/cameras/{camera.id}/snapshot"
        )

    assert response.status_code == 200
    capture.assert_awaited_once_with(
        "http://printer.lan/webcam/snapshot.jpg",
        "snapshot",
        timeout=15,
        snapshot_url="http://printer.lan/webcam/snapshot.jpg",
    )


@pytest.mark.asyncio
async def test_camera_api_lists_safe_history_and_restores_manual(
    async_client, db_session, printer_factory
):
    printer = await printer_factory(provider="moonraker")
    camera = PrinterCamera(
        printer_id=printer.id,
        source="moonraker",
        source_uid="history-cam",
        name="Old camera",
        service="mjpegstreamer",
        camera_type="mjpeg",
        stream_url="http://printer.lan/webcam/old",
        snapshot_url="http://printer.lan/webcam/old/snapshot",
        location="toolhead",
        enabled=False,
        missing_since=datetime.utcnow() - timedelta(hours=25),
    )
    db_session.add(camera)
    await db_session.commit()

    listed = await async_client.get(f"/api/v1/printers/{printer.id}/cameras?include_history=true")

    assert listed.status_code == 200
    assert listed.json()[0]["history"] is True
    assert "stream_url" not in listed.json()[0]

    restored = await async_client.post(
        f"/api/v1/printers/{printer.id}/cameras/{camera.id}/restore-as-manual"
    )

    assert restored.status_code == 200
    assert restored.json()["source"] == "manual"
    assert restored.json()["location"] == "toolhead"
    assert restored.json()["enabled"] is False
    after = await async_client.get(f"/api/v1/printers/{printer.id}/cameras?include_history=true")
    assert len(after.json()) == 2


@pytest.mark.asyncio
async def test_restore_deduplicates_equivalent_manual_camera_path(
    async_client, db_session, printer_factory
):
    printer = await printer_factory(provider="moonraker")
    history = PrinterCamera(
        printer_id=printer.id,
        source="moonraker",
        source_uid="history-equivalent",
        name="Old camera",
        camera_type="mjpeg",
        stream_url="http://old-host/webcam/stream",
        missing_since=datetime.utcnow() - timedelta(hours=25),
    )
    manual = PrinterCamera(
        printer_id=printer.id,
        source="manual",
        source_uid="manual-equivalent",
        name="Manual camera",
        camera_type="mjpeg",
        stream_url="http://new-host/webcam/stream",
    )
    db_session.add_all([history, manual])
    await db_session.commit()

    restored = await async_client.post(
        f"/api/v1/printers/{printer.id}/cameras/{history.id}/restore-as-manual"
    )

    assert restored.status_code == 200
    assert restored.json()["id"] == manual.id
    rows = (await db_session.execute(select(PrinterCamera))).scalars().all()
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_camera_snapshot_routes_use_selected_moonraker_camera(async_client, db_session, printer_factory):
    printer = await printer_factory(
        provider="moonraker",
        external_camera_url=None,
        external_camera_type=None,
        external_camera_enabled=False,
    )
    camera = PrinterCamera(
        printer_id=printer.id,
        source="moonraker",
        source_uid="cam-1",
        name="Toolhead",
        camera_type="mjpeg",
        stream_url="http://printer.lan/webcam/stream",
        snapshot_url="http://printer.lan/webcam/snapshot",
        is_primary=True,
    )
    db_session.add(camera)
    await db_session.commit()

    fake_jpeg = b"\xff\xd8image\xff\xd9"
    with patch(
        "backend.app.services.external_camera.capture_frame", new_callable=AsyncMock, return_value=fake_jpeg
    ) as capture:
        selected = await async_client.get(
            f"/api/v1/printers/{printer.id}/cameras/{camera.id}/snapshot"
        )
        primary = await async_client.get(f"/api/v1/printers/{printer.id}/camera/snapshot")

    assert selected.status_code == 200
    assert primary.status_code == 200
    assert capture.await_count == 2
