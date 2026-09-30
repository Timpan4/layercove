"""Photo normalization and ingress limits through the public evidence route."""
import io

import httpx
from PIL import Image

from backend.tests._fixtures.calibration import filament_schema  # noqa: F401
from backend.tests.integration.test_calibration_sessions import create_session


async def test_photo_pixels_are_saved_without_metadata(async_client, db_session, monkeypatch, tmp_path):
    from backend.app.core.config import settings
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    session = await create_session(async_client, db_session)
    image = Image.new("RGB", (2, 2), "red")
    metadata = image.getexif()
    metadata[270] = "Private source metadata"
    source = io.BytesIO()
    image.save(source, format="JPEG", exif=metadata)
    base = f"/api/v1/calibration/sessions/{session['id']}/evidence"
    uploaded = await async_client.post(base + "/temperature", files={"file": ("photo.jpg", source.getvalue(), "image/jpeg")})
    assert uploaded.status_code == 201, uploaded.text
    downloaded = await async_client.get(base + f"/{uploaded.json()['id']}/image")
    assert downloaded.headers["cache-control"] == "private, no-store"
    with Image.open(io.BytesIO(downloaded.content)) as normalized:
        assert normalized.format == "PNG" and normalized.size == (2, 2)
        assert not normalized.getexif()
    assert (await async_client.get(base)).json()[0]["id"] == uploaded.json()["id"]
    invalid = await async_client.post(base + "/temperature", files={"file": ("fake.png", b"not an image", "image/png")})
    assert invalid.status_code == 422


async def test_photo_ingress_rejects_declared_and_streamed_oversize_before_spooling(monkeypatch):
    from backend.app.core import moonraker_upload_limit as limits
    monkeypatch.setattr(limits, "MAX_IMAGE_UPLOAD_BYTES", 4)
    monkeypatch.setattr(limits, "_MULTIPART_OVERHEAD_BYTES", 1)
    reached = []

    async def application(scope, receive, send):
        reached.append(True)
        while (await receive()).get("more_body", False):
            pass
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def chunks():
        yield b"123"
        yield b"456"

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=limits.MoonrakerUploadBodyLimitMiddleware(application)), base_url="http://test") as client:
        declared = await client.post("/api/v1/calibration/sessions/1/evidence/temperature", content=b"", headers={"content-length": "6"})
        assert declared.status_code == 413 and not reached
        streamed = await client.post("/api/v1/calibration/sessions/1/evidence/temperature", content=chunks())
        assert streamed.status_code == 413 and reached
