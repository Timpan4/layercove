import json
import logging
from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from typing import NamedTuple
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
from backend.app.models.printer import Printer
from backend.app.models.printer_camera import PrinterCamera
from backend.app.services.external_camera import _sanitize_camera_url
from backend.app.services.moonraker_http import MoonrakerHTTPClient, MoonrakerHTTPError, MoonrakerHTTPResponse

logger = logging.getLogger(__name__)

HISTORY_AFTER = timedelta(hours=24)
_MJPEG_SERVICES = {"mjpegstreamer", "adaptive", "uv4l-mjpeg", "ipstream"}
_UNSUPPORTED_SERVICES = {"webrtc-camerastreamer", "webrtc-go2rtc", "hlsstream", "jmuxer-stream", "iframe"}


class CameraCaptureSettings(NamedTuple):
    enabled: bool
    stream_url: str | None
    camera_type: str | None
    snapshot_url: str | None
    rotation: int


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _json_result(response: MoonrakerHTTPResponse) -> dict:
    if not 200 <= response.status_code < 300:
        raise MoonrakerHTTPError("http_status", f"Moonraker returned HTTP {response.status_code}.")
    try:
        payload = json.loads(response.body)
    except (TypeError, ValueError) as exc:
        raise MoonrakerHTTPError("invalid_response", "Moonraker returned invalid JSON.") from exc
    result = payload.get("result") if isinstance(payload, dict) else None
    if not isinstance(result, dict):
        raise MoonrakerHTTPError("invalid_response", "Moonraker returned an invalid webcam response.")
    return result


def _loopback_host(host: str | None) -> bool:
    if not host:
        return True
    if host.lower() == "localhost":
        return True
    try:
        address = ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_unspecified


def resolve_webcam_url(raw_url: str | None, tested_url: str | None, base_url: str) -> str | None:
    candidate = (tested_url or raw_url or "").strip()
    if not candidate:
        return None

    base = urlsplit(base_url)
    parsed = urlsplit(candidate)
    if not parsed.scheme or not parsed.hostname:
        parsed = urlsplit(urlunsplit((base.scheme, base.hostname or "", parsed.path, parsed.query, "")))
    elif _loopback_host(parsed.hostname):
        host = base.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        default_port = 443 if parsed.scheme == "https" else 80
        netloc = f"{host}:{parsed.port}" if parsed.port and parsed.port != default_port else host
        parsed = urlsplit(urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, "")))

    return _sanitize_camera_url(urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, "")))


def _url_key(url: str | None) -> tuple[str, str] | None:
    if not url:
        return None
    parsed = urlsplit(url)
    return parsed.path.rstrip("/"), parsed.query


def camera_urls_equivalent(
    first_stream: str | None,
    first_snapshot: str | None,
    second_stream: str | None,
    second_snapshot: str | None,
) -> bool:
    first = {_url_key(url) for url in (first_stream, first_snapshot) if url}
    second = {_url_key(url) for url in (second_stream, second_snapshot) if url}
    return bool(first.intersection(second))


def _camera_type(service: str, stream_url: str | None, snapshot_url: str | None) -> str:
    scheme = urlsplit(stream_url or "").scheme.lower()
    if scheme == "rtsp":
        return "rtsp"
    if service in _MJPEG_SERVICES and stream_url:
        return "mjpeg"
    if service in _UNSUPPORTED_SERVICES:
        return "unsupported"
    if snapshot_url:
        return "snapshot"
    if stream_url:
        return "unsupported"
    return "unsupported"


def camera_capture_type(camera: PrinterCamera) -> str:
    """Return the existing capture mode, including snapshot fallback."""
    if camera.camera_type == "unsupported" and camera.snapshot_url:
        return "snapshot"
    return camera.camera_type


def camera_is_history(camera: PrinterCamera, *, now: datetime | None = None) -> bool:
    return camera.missing_since is not None and (now or _utcnow()) - camera.missing_since >= HISTORY_AFTER


def _client_for(config: MoonrakerPrinterConfig) -> MoonrakerHTTPClient:
    return MoonrakerHTTPClient(
        base_url=config.base_url,
        api_key=config.api_key,
        authorization=config.authorization,
        tls_verify=config.tls_verify,
    )


async def sync_moonraker_cameras(
    db: AsyncSession,
    printer: Printer,
    *,
    client: MoonrakerHTTPClient | None = None,
) -> list[PrinterCamera]:
    if getattr(printer, "provider", "bambulab") != "moonraker":
        raise MoonrakerHTTPError("invalid_provider", "Camera discovery requires a Moonraker printer.")

    config = await db.get(MoonrakerPrinterConfig, printer.id)
    if config is None:
        raise MoonrakerHTTPError("missing_config", "Printer does not have a Moonraker configuration.")
    client = client or _client_for(config)
    result = _json_result(await client.list_webcams())
    webcams = result.get("webcams")
    if not isinstance(webcams, list) or any(not isinstance(item, dict) for item in webcams):
        raise MoonrakerHTTPError("invalid_response", "Moonraker returned an invalid webcam list.")

    tested: dict[str, dict] = {}
    for webcam in webcams:
        uid = webcam.get("uid")
        if not isinstance(uid, str) or not uid:
            raise MoonrakerHTTPError("invalid_response", "Moonraker webcam is missing a stable UID.")
        try:
            tested[uid] = _json_result(await client.test_webcam(uid))
        except MoonrakerHTTPError:
            logger.warning("Moonraker webcam test failed for printer %s camera %s", printer.id, uid)
            tested[uid] = {}

    rows = list(
        (await db.execute(select(PrinterCamera).where(PrinterCamera.printer_id == printer.id))).scalars().all()
    )
    by_uid = {(row.source, row.source_uid): row for row in rows}
    now = _utcnow()
    seen: set[str] = set()
    legacy_url = printer.external_camera_url if not rows else None
    legacy_match: PrinterCamera | None = None

    for order, webcam in enumerate(webcams):
        uid = webcam["uid"]
        seen.add(uid)
        probe = tested[uid]
        stream_url = resolve_webcam_url(webcam.get("stream_url"), probe.get("stream_url"), config.base_url)
        snapshot_url = resolve_webcam_url(
            webcam.get("snapshot_url"), probe.get("snapshot_url"), config.base_url
        )
        service = str(webcam.get("service") or "").lower()
        row = by_uid.get(("moonraker", uid))
        if row is None:
            row = PrinterCamera(
                printer_id=printer.id,
                source="moonraker",
                source_uid=uid,
                name=str(webcam.get("name") or "Camera")[:100],
            )
            db.add(row)
            rows.append(row)
            by_uid[("moonraker", uid)] = row
        row.name = str(webcam.get("name") or "Camera")[:100]
        row.location = str(webcam.get("location"))[:100] if webcam.get("location") is not None else None
        row.service = service[:50] or None
        row.stream_url = stream_url
        row.snapshot_url = snapshot_url
        row.camera_type = _camera_type(service, stream_url, snapshot_url)
        row.source_enabled = bool(webcam.get("enabled", True))
        row.sort_order = order
        row.last_seen_at = now
        row.missing_since = None
        if legacy_url and camera_urls_equivalent(
            legacy_url,
            printer.external_camera_snapshot_url,
            stream_url,
            snapshot_url,
        ):
            legacy_match = row
            row.enabled = printer.external_camera_enabled
            row.rotation = printer.camera_rotation
            row.is_primary = True

    for row in rows:
        if row.source == "moonraker" and row.source_uid not in seen and row.missing_since is None:
            row.missing_since = now

    if legacy_url and legacy_match is None:
        manual = PrinterCamera(
            printer_id=printer.id,
            source="manual",
            source_uid=str(uuid4()),
            name="Manual camera",
            stream_url=legacy_url,
            snapshot_url=printer.external_camera_snapshot_url,
            camera_type=printer.external_camera_type or "mjpeg",
            source_enabled=True,
            enabled=printer.external_camera_enabled,
            is_primary=True,
            rotation=printer.camera_rotation,
        )
        db.add(manual)
        rows.append(manual)

    primaries = sorted((row for row in rows if row.is_primary), key=lambda item: (item.sort_order, item.id or 0))
    primary = primaries[0] if primaries else None
    for duplicate in primaries[1:]:
        duplicate.is_primary = False
    if primary is None:
        primary = next(
            (
                row
                for row in sorted(rows, key=lambda item: item.sort_order)
                if row.enabled
                and row.source_enabled
                and (row.camera_type != "unsupported" or row.snapshot_url)
                and row.missing_since is None
            ),
            None,
        )
        if primary is not None:
            primary.is_primary = True

    if primary is not None:
        printer.external_camera_url = primary.stream_url
        printer.external_camera_snapshot_url = primary.snapshot_url
        printer.external_camera_type = camera_capture_type(primary)
        printer.external_camera_enabled = primary.enabled
        printer.camera_rotation = primary.rotation

    await db.flush()
    return rows


async def get_effective_camera(db: AsyncSession, printer_id: int) -> PrinterCamera | None:
    rows = list(
        (
            await db.execute(
                select(PrinterCamera)
                .where(PrinterCamera.printer_id == printer_id)
                .order_by(PrinterCamera.is_primary.desc(), PrinterCamera.sort_order, PrinterCamera.id)
            )
        )
        .scalars()
        .all()
    )
    return next(
        (
            row
            for row in rows
            if row.enabled
            and row.source_enabled
            and row.missing_since is None
            and (row.camera_type != "unsupported" or row.snapshot_url)
            and (row.stream_url or row.snapshot_url)
        ),
        None,
    )


async def get_effective_capture_settings(
    db: AsyncSession, printer: Printer
) -> CameraCaptureSettings:
    """Return effective capture fields without changing Bambu behavior."""
    if getattr(printer, "provider", "bambulab") != "moonraker":
        return CameraCaptureSettings(
            printer.external_camera_enabled,
            printer.external_camera_url,
            printer.external_camera_type,
            printer.external_camera_snapshot_url,
            getattr(printer, "camera_rotation", 0),
        )

    camera = await get_effective_camera(db, printer.id)
    if camera is None:
        return CameraCaptureSettings(False, None, None, None, 0)
    capture_type = camera_capture_type(camera)
    return CameraCaptureSettings(
        True,
        camera.snapshot_url if capture_type == "snapshot" else camera.stream_url or camera.snapshot_url,
        capture_type,
        camera.snapshot_url,
        camera.rotation,
    )


async def sync_moonraker_cameras_for_printer(printer_id: int) -> None:
    from backend.app.core.database import async_session

    async with async_session() as db:
        printer = await db.get(Printer, printer_id)
        if printer is None or printer.provider != "moonraker":
            return
        await sync_moonraker_cameras(db, printer)
        await db.commit()
