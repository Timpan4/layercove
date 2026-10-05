"""3MF expansion is bounded by the shared 4 GiB cap (patched small here)."""

import io
import json
import zipfile

import pytest
from fastapi import HTTPException

from backend.app.api.routes import library
from backend.app.services import plate_thumbnail, zip_limits
from backend.app.services.archive import ThreeMFParser


def _bomb(sentinel: bool = False) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if sentinel:
            zf.writestr("Metadata/project_settings.config", json.dumps({"raft_first_layer_expansion": "-1"}))
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr("Metadata/plate_1.gcode", b"0" * 200_000)
    return buf.getvalue()


@pytest.fixture(autouse=True)
def small_cap(monkeypatch):
    monkeypatch.setattr(zip_limits, "MAX_ZIP_UNCOMPRESSED_BYTES", 100_000)


def test_cap_reuses_upload_cap():
    from backend.app.services.virtual_printer.ftp_server import MAX_UPLOAD_BYTES

    assert zip_limits.MAX_UPLOAD_BYTES == MAX_UPLOAD_BYTES == 4 * 1024**3


def test_sentinel_sanitizer_rejects_bomb():
    with pytest.raises(HTTPException) as exc:
        library._sanitize_project_settings_sentinels(_bomb(sentinel=True))
    assert exc.value.status_code == 413


def test_strip_configs_rejects_bomb():
    with pytest.raises(zip_limits.ZipTooLargeError):
        library._strip_3mf_embedded_settings(_bomb())


def test_thumbnail_injection_rejects_bomb():
    with pytest.raises(zip_limits.ZipTooLargeError):
        plate_thumbnail.inject_plate_thumbnails_if_missing(_bomb())


def test_streaming_budget_bounds_actual_bytes(tmp_path):
    zf = zipfile.ZipFile(io.BytesIO(_bomb()))
    with pytest.raises(zip_limits.ZipTooLargeError), zipfile.ZipFile(io.BytesIO(), "w") as dst:
        zip_limits.ZipBudget().copy_member(zf, dst, zf.getinfo("Metadata/plate_1.gcode"))


def test_parser_skips_bomb(tmp_path):
    path = tmp_path / "a.3mf"
    path.write_bytes(_bomb())
    assert ThreeMFParser(path).parse() == {}
