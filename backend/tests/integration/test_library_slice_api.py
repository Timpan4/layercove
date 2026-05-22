"""Integration tests for the slice-via-API flow.

Routes under test:
- POST /library/files/{id}/slice  (returns 202 + job_id; bg task does the work)
- POST /archives/{id}/slice        (same shape; result lands in archives table)
- GET /slice-jobs/{id}             (poll for terminal state)

The synchronous validation paths (404 missing source, 400 wrong file type)
are tested directly. The bg-task paths poll until the job finishes and then
assert on the captured state.
"""

from __future__ import annotations

import asyncio
import io
import json
import zipfile
from collections.abc import Callable

import httpx
import pytest
from httpx import AsyncClient

from backend.app.api.routes.library import _slicer_rejection_message
from backend.app.core.config import settings as app_settings
from backend.app.models.library import LibraryFile
from backend.app.models.local_preset import LocalPreset
from backend.app.models.settings import Settings as SettingsModel
from backend.app.services import slicer_api as slicer_api_module
from backend.app.services.slice_dispatch import slice_dispatch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_3mf_with_settings(settings_payload: dict | None = None) -> bytes:
    """Build a tiny in-memory 3MF zip with all the embedded-config files
    that real-world Bambu Studio / OrcaSlicer 3MFs ship with.

    The strip-before-forwarding helper has to remove ALL of these (not
    just `project_settings.config`) — leftover entries reference printer
    / filament IDs from the original slice and trip the CLI's input
    validation when a different `--load-settings` triplet is supplied.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr(
            "Metadata/project_settings.config",
            json.dumps(settings_payload or {"prime_tower_brim_width": "-1"}),
        )
        zf.writestr("Metadata/model_settings.config", "<config><object id='1'/></config>")
        zf.writestr(
            "Metadata/slice_info.config",
            "<config><plate><metadata key='filament' value='GFL00'/></plate></config>",
        )
        zf.writestr("Metadata/cut_information.xml", "<cut><part id='1'/></cut>")
    return buf.getvalue()


def _install_mock_sidecar(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    """Pin a MockTransport-backed httpx client onto the slicer_api singleton
    so per-request `SlicerApiService` instances reuse it instead of opening
    a real connection."""
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=10.0)
    slicer_api_module.set_shared_http_client(client)
    return client


async def _wait_for_job(client: AsyncClient, job_id: int, timeout: float = 5.0) -> dict:
    """Poll `/api/v1/slice-jobs/{id}` until the job hits a terminal state.

    The dispatcher runs work as an asyncio task on the same event loop, so
    poll-with-sleep here is enough — a few yields and the task finishes.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        r = await client.get(f"/api/v1/slice-jobs/{job_id}")
        if r.status_code != 200:
            raise AssertionError(f"slice-jobs poll failed: {r.status_code} {r.text}")
        body = r.json()
        if body["status"] in ("completed", "failed"):
            return body
        await asyncio.sleep(0.05)
    raise AssertionError(f"slice job {job_id} did not finish in {timeout}s")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
async def slice_test_setup(db_session, tmp_path):
    """Source LibraryFile + 3 LocalPresets + preferred_slicer=orcaslicer."""
    storage_dir = tmp_path / "library" / "files"
    storage_dir.mkdir(parents=True, exist_ok=True)
    src_path = storage_dir / "Cube.stl"
    src_path.write_bytes(b"solid Cube\nendsolid\n")

    original_base_dir = app_settings.base_dir
    app_settings.base_dir = tmp_path

    src_file = LibraryFile(
        filename="Cube.stl",
        file_path=str(src_path.relative_to(tmp_path)),
        file_type="stl",
        file_size=src_path.stat().st_size,
    )
    db_session.add(src_file)

    presets = {}
    for kind in ("printer", "process", "filament"):
        p = LocalPreset(
            name=f"Test {kind}",
            preset_type=kind,
            source="orcaslicer",
            setting=json.dumps({"name": f"Test {kind}", "type": kind}),
        )
        db_session.add(p)
        presets[kind] = p

    db_session.add(SettingsModel(key="preferred_slicer", value="orcaslicer"))
    await db_session.commit()

    for p in presets.values():
        await db_session.refresh(p)
    await db_session.refresh(src_file)

    yield {
        "src_file_id": src_file.id,
        "printer_id": presets["printer"].id,
        "process_id": presets["process"].id,
        "filament_id": presets["filament"].id,
        "tmp_path": tmp_path,
    }

    app_settings.base_dir = original_base_dir
    slicer_api_module.set_shared_http_client(None)


# ---------------------------------------------------------------------------
# POST /library/files/{id}/slice — synchronous validation paths
# ---------------------------------------------------------------------------


class TestSliceValidation:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_404_when_source_missing(self, async_client: AsyncClient, slice_test_setup):
        _install_mock_sidecar(lambda r: httpx.Response(200, content=b""))
        response = await async_client.post(
            "/api/v1/library/files/999999/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_returns_400_for_wrong_file_type(self, async_client: AsyncClient, db_session, slice_test_setup):
        gcode_path = slice_test_setup["tmp_path"] / "library" / "files" / "out.gcode"
        gcode_path.write_bytes(b"; gcode\n")
        gfile = LibraryFile(
            filename="out.gcode",
            file_path=str(gcode_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="gcode",
            file_size=10,
        )
        db_session.add(gfile)
        await db_session.commit()
        await db_session.refresh(gfile)

        _install_mock_sidecar(lambda r: httpx.Response(200, content=b""))
        response = await async_client.post(
            f"/api/v1/library/files/{gfile.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 400
        assert "STL, 3MF, or STEP" in response.json()["detail"]


# ---------------------------------------------------------------------------
# POST /library/files/{id}/slice — async dispatch + bg job
# ---------------------------------------------------------------------------


class TestSliceLibraryFile:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_happy_path_returns_202_then_job_completes_with_library_file(
        self, async_client: AsyncClient, slice_test_setup
    ):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["url"] = str(request.url)
            return httpx.Response(
                status_code=200,
                content=b"PK\x03\x04 fake-3mf",
                headers={
                    "x-print-time-seconds": "656",
                    "x-filament-used-g": "0.94",
                    "x-filament-used-mm": "302.5",
                },
            )

        _install_mock_sidecar(handler)

        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202, response.text
        body = response.json()
        assert body["status"] == "pending"
        assert body["status_url"].startswith("/api/v1/slice-jobs/")

        final = await _wait_for_job(async_client, body["job_id"])
        assert final["status"] == "completed", final
        assert final["result"]["library_file_id"] != slice_test_setup["src_file_id"]
        assert final["result"]["print_time_seconds"] == 656
        assert captured["url"].endswith("/slice")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bed_type_override_patches_process_profile(self, async_client: AsyncClient, slice_test_setup):
        """#1337: when SliceRequest.bed_type is set, the process JSON sent to
        the sidecar must carry curr_bed_type with that exact value. Without
        the patch, slicing high-temp filaments on a "Cool Plate" process
        preset fails inside the slicer CLI with "does not support filament 1"
        and the user has no way to switch plates from the SliceModal."""
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = bytes(request.content)
            return httpx.Response(
                status_code=200,
                content=b"PK\x03\x04 fake",
                headers={
                    "x-print-time-seconds": "10",
                    "x-filament-used-g": "0.1",
                    "x-filament-used-mm": "1.0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
                "bed_type": "Textured PEI Plate",
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final

        # The presetProfile part of the multipart upload now carries the
        # override. Searching the raw body avoids parsing the multipart by
        # hand — the substring is unique enough since we control the JSON
        # being patched.
        assert b'"curr_bed_type": "Textured PEI Plate"' in captured["body"], (
            "bed_type override must appear in the process JSON sent to the sidecar"
        )

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bed_type_omitted_leaves_process_profile_untouched(self, async_client: AsyncClient, slice_test_setup):
        """Companion to the override test: the patch must NOT fire when the
        client omits bed_type, so the process preset's own curr_bed_type
        (or absence thereof) is forwarded to the sidecar unchanged."""
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = bytes(request.content)
            return httpx.Response(
                status_code=200,
                content=b"PK\x03\x04 fake",
                headers={
                    "x-print-time-seconds": "10",
                    "x-filament-used-g": "0.1",
                    "x-filament-used-mm": "1.0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final
        assert b"curr_bed_type" not in captured["body"], (
            "bed_type must stay out of the process JSON when no override is set"
        )

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_invalid_preset_id_surfaces_as_failed_job_with_status_400(
        self, async_client: AsyncClient, slice_test_setup
    ):
        _install_mock_sidecar(lambda r: httpx.Response(200, content=b""))
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                # Swap printer/filament — both exist but wrong preset_type.
                "printer_preset_id": slice_test_setup["filament_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["printer_id"],
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 400
        assert "preset_type" in (final["error_detail"] or "")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unknown_preferred_slicer_fails_with_400(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        await db_session.execute(
            SettingsModel.__table__.update().where(SettingsModel.key == "preferred_slicer").values(value="prusaslicer")
        )
        await db_session.commit()

        _install_mock_sidecar(lambda r: httpx.Response(200, content=b""))
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 400
        assert "preferred_slicer" in (final["error_detail"] or "")

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_sidecar_unreachable_fails_with_502(self, async_client: AsyncClient, slice_test_setup):
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 502
        assert "unreachable" in (final["error_detail"] or "").lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_3mf_falls_back_to_embedded_settings_on_cli_failure(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        # When the slicer CLI fails on the --load-settings path (segfault
        # on complex H2D models), Bambuddy retries with no profile triplet
        # so the CLI uses the file's embedded settings.
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "complex.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings({"prime_tower_brim_width": "-1"}))
        threemf = LibraryFile(
            filename="complex.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        db_session.add(threemf)
        await db_session.commit()
        await db_session.refresh(threemf)

        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            call_count["n"] += 1
            # First call: profile triplet present → simulate CLI 5xx
            if call_count["n"] == 1:
                return httpx.Response(
                    status_code=500,
                    json={"message": "Failed to slice the model"},
                )
            # Retry: no profile triplet → succeed with embedded settings
            return httpx.Response(
                status_code=200,
                content=b"PK\x03\x04 fake-3mf",
                headers={
                    "x-print-time-seconds": "100",
                    "x-filament-used-g": "1.0",
                    "x-filament-used-mm": "100",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final
        assert final["result"]["used_embedded_settings"] is True
        assert call_count["n"] == 2  # primary + fallback retry

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_stl_does_not_fall_back_on_cli_failure(self, async_client: AsyncClient, slice_test_setup):
        # STL has no embedded settings — the CLI 5xx is terminal.
        call_count = {"n": 0}

        def handler(_: httpx.Request) -> httpx.Response:
            call_count["n"] += 1
            return httpx.Response(
                status_code=500,
                json={"message": "Failed to slice the model"},
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 502
        assert call_count["n"] == 1  # No retry for STL

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_3mf_input_forwarded_unmodified_to_sidecar(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        # 3MF input must be forwarded to the sidecar verbatim — every
        # Metadata/*.config the source carries (project_settings,
        # model_settings, slice_info, cut_information) is needed by the
        # CLI to find plate definitions and baseline config; an earlier
        # version of this code stripped them and caused the CLI to
        # silently exit immediately after "Initializing StaticPrintConfigs"
        # for every 3MF slice. --load-settings overrides the specific
        # fields the user changed; the rest comes from the embedded data.
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "real.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings({"prime_tower_brim_width": "-1"}))
        threemf = LibraryFile(
            filename="real.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        db_session.add(threemf)
        await db_session.commit()
        await db_session.refresh(threemf)

        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = request.content
            return httpx.Response(
                status_code=200,
                content=b"PK\x03\x04 fake-3mf",
                headers={
                    "x-print-time-seconds": "1",
                    "x-filament-used-g": "0",
                    "x-filament-used-mm": "0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final

        # Recover the embedded zip from the multipart body and assert ALL
        # the source's Metadata/*.config files are still present — the
        # opposite of the previous (broken) "strip everything" test.
        body = captured["body"]
        pk = body.find(b"PK\x03\x04")
        assert pk >= 0, "3MF body not found in multipart payload"
        with zipfile.ZipFile(io.BytesIO(body[pk:]), "r") as zin:
            names = set(zin.namelist())
        assert "Metadata/project_settings.config" in names
        assert "Metadata/model_settings.config" in names
        assert "Metadata/slice_info.config" in names
        assert "Metadata/cut_information.xml" in names
        assert "3D/3dmodel.model" in names


class TestSliceWithBundle:
    """Bundle dispatch path: when SliceRequest.bundle is set, the dispatch
    forwards bundle id + per-category preset names to the sidecar instead
    of resolving cloud/local/standard PresetRefs. Same fallback semantics
    apply for 3MF inputs whose CLI run fails."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bundle_dispatch_forwards_form_fields(self, async_client: AsyncClient, slice_test_setup):
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = request.content
            return httpx.Response(
                status_code=200,
                content=b"PK\x03\x04 fake-3mf",
                headers={
                    "x-print-time-seconds": "200",
                    "x-filament-used-g": "1.5",
                    "x-filament-used-mm": "150",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "bundle": {
                    "bundle_id": "abc123def456abcd",
                    "printer_name": "# Bambu Lab H2D 0.4 nozzle",
                    "process_name": "# 0.20mm Standard @BBL H2D",
                    "filament_names": [
                        "# Bambu PLA Basic @BBL H2D",
                        "# Bambu PETG HF @BBL H2D 0.4 nozzle",
                    ],
                },
            },
        )
        assert response.status_code == 202, response.text
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final

        # Multipart form body should carry the bundle selectors instead of
        # the JSON profile attachments. Quick string-level check is enough
        # to confirm the dispatch picked the bundle branch.
        body = captured["body"]
        assert b'name="bundle"' in body
        assert b"abc123def456abcd" in body
        assert b'name="printerName"' in body
        assert b'name="processName"' in body
        assert b'name="filamentNames"' in body
        # Multi-color filament list joined with ';' on the wire.
        assert b"# Bambu PLA Basic @BBL H2D;# Bambu PETG HF @BBL H2D 0.4 nozzle" in body
        # Profile attachments must NOT be present — bundle dispatch skips
        # PresetRef resolution entirely.
        assert b'name="printerProfile"' not in body
        assert b'name="presetProfile"' not in body
        assert b'name="filamentProfile"' not in body

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bundle_dispatch_forwards_bed_type_when_set(self, async_client: AsyncClient, slice_test_setup):
        """#1337 follow-up: bed-type override flows through the bundle path
        as a `bedType` form field so the sidecar can pass
        `--curr_bed_type` to the CLI. Bambuddy can't patch the bundle's
        process JSON locally — the sidecar materialises it from the stored
        .bbscfg — so the form field is the only handle."""
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = bytes(request.content)
            return httpx.Response(
                status_code=200,
                content=b"PK\x03\x04 fake",
                headers={
                    "x-print-time-seconds": "10",
                    "x-filament-used-g": "0.1",
                    "x-filament-used-mm": "1.0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "bundle": {
                    "bundle_id": "abc",
                    "printer_name": "# X1C",
                    "process_name": "# 0.20mm",
                    "filament_names": ["# Bambu PLA"],
                },
                "bed_type": "Engineering Plate",
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final
        body = captured["body"]
        assert b'name="bedType"' in body
        assert b"Engineering Plate" in body

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bundle_dispatch_omits_bed_type_when_unset(self, async_client: AsyncClient, slice_test_setup):
        """Companion test: no bed_type ⇒ no bedType form field, so the
        bundle's own curr_bed_type is preserved end-to-end."""
        captured: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["body"] = bytes(request.content)
            return httpx.Response(
                status_code=200,
                content=b"PK\x03\x04 fake",
                headers={
                    "x-print-time-seconds": "10",
                    "x-filament-used-g": "0.1",
                    "x-filament-used-mm": "1.0",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "bundle": {
                    "bundle_id": "abc",
                    "printer_name": "# X1C",
                    "process_name": "# 0.20mm",
                    "filament_names": ["# Bambu PLA"],
                },
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final
        assert b'name="bedType"' not in captured["body"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bundle_dispatch_3mf_falls_back_to_embedded_on_5xx(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        # Same fallback as the preset-based path: if the resolved bundle
        # triplet crashes the CLI on a 3MF, retry with embedded settings
        # so the user gets *something* rather than a hard failure.
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "complex_bundle.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings({"prime_tower_brim_width": "-1"}))
        threemf = LibraryFile(
            filename="complex_bundle.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        db_session.add(threemf)
        await db_session.commit()
        await db_session.refresh(threemf)

        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            call_count["n"] += 1
            # First call: bundle path → simulate CLI 5xx
            if call_count["n"] == 1:
                return httpx.Response(
                    status_code=500,
                    json={"message": "Failed to slice the model"},
                )
            # Retry: no profiles / no bundle → succeed with embedded settings
            return httpx.Response(
                status_code=200,
                content=b"PK\x03\x04 fake-3mf",
                headers={
                    "x-print-time-seconds": "100",
                    "x-filament-used-g": "1.0",
                    "x-filament-used-mm": "100",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "bundle": {
                    "bundle_id": "abc",
                    "printer_name": "P",
                    "process_name": "Q",
                    "filament_names": ["F"],
                },
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "completed", final
        assert final["result"]["used_embedded_settings"] is True
        assert call_count["n"] == 2  # bundle attempt + embedded fallback

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_bundle_dispatch_404_surfaces_as_400(self, async_client: AsyncClient, slice_test_setup):
        # Sidecar returns 404 when the bundle / preset name isn't found —
        # the slicer client classifies this as user-correctable input
        # error so the dispatch returns 400 to the caller, not 502.
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status_code=404,
                json={"message": 'process preset "Imaginary" not found in bundle "abc"'},
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{slice_test_setup['src_file_id']}/slice",
            json={
                "bundle": {
                    "bundle_id": "abc",
                    "printer_name": "P",
                    "process_name": "Imaginary",
                    "filament_names": ["F"],
                },
            },
        )
        assert response.status_code == 202
        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed"
        assert final["error_status"] == 400
        assert "imaginary" in (final["error_detail"] or "").lower()


# ---------------------------------------------------------------------------
# GET /slice-jobs/{id}
# ---------------------------------------------------------------------------


class TestSliceJobs:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_unknown_job_returns_404(self, async_client: AsyncClient):
        # Sweep dispatcher state so a fresh ID is unknown.
        slice_dispatch._jobs.clear()
        r = await async_client.get("/api/v1/slice-jobs/999999")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# POST /archives/{id}/slice — re-sliced archive reflects the target printer
# ---------------------------------------------------------------------------


def _make_sliced_3mf(printer_model_id: str) -> bytes:
    """A minimal sliced-output 3MF that embeds a printer_model_id in
    slice_info.config, the way a real Bambu Studio / OrcaSlicer export does.
    ThreeMFParser reads this into metadata['sliced_for_model']."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("3D/3dmodel.model", "<model/>")
        zf.writestr(
            "Metadata/slice_info.config",
            f"<config><plate><metadata key='printer_model_id' value='{printer_model_id}'/></plate></config>",
        )
    return buf.getvalue()


class TestSliceArchiveResliceModel:
    """Re-slicing an archive for a different printer must stamp the new
    archive with the printer it was sliced FOR, not the source's printer."""

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_reslice_uses_target_model_not_source_model(
        self, async_client: AsyncClient, db_session, slice_test_setup, printer_factory, archive_factory, monkeypatch
    ):
        from backend.app.models.archive import PrintArchive

        tmp_path = slice_test_setup["tmp_path"]
        # archive_dir is a static path off the real data dir; point it under
        # base_dir (= tmp_path) so the new archive's file resolves there.
        monkeypatch.setattr(app_settings, "archive_dir", tmp_path / "archive")

        # Source archive: a 3MF that was sliced for an X1C.
        src_dir = tmp_path / "archives" / "src"
        src_dir.mkdir(parents=True, exist_ok=True)
        src_3mf = src_dir / "cube.3mf"
        src_3mf.write_bytes(_make_3mf_with_settings())
        printer = await printer_factory()
        source = await archive_factory(
            printer.id,
            filename="cube.3mf",
            file_path=str(src_3mf.relative_to(tmp_path)),
            sliced_for_model="X1C",
            with_run=False,
        )
        source_id = source.id

        # The slicer returns a 3MF whose embedded printer_model_id is O1D (H2D).
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status_code=200,
                content=_make_sliced_3mf("O1D"),
                headers={
                    "x-print-time-seconds": "600",
                    "x-filament-used-g": "5.0",
                    "x-filament-used-mm": "1600.0",
                },
            )

        _install_mock_sidecar(handler)

        resp = await async_client.post(
            f"/api/v1/archives/{source_id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert resp.status_code == 202, resp.text

        final = await _wait_for_job(async_client, resp.json()["job_id"])
        assert final["status"] == "completed", final

        new_id = final["result"]["archive_id"]
        assert new_id != source_id

        new_archive = await db_session.get(PrintArchive, new_id)
        # The fix: the re-sliced archive reflects H2D — the printer it was
        # sliced for — instead of inheriting X1C from the source archive.
        assert new_archive.sliced_for_model == "H2D"

        # Source archive is untouched.
        source_reloaded = await db_session.get(PrintArchive, source_id)
        assert source_reloaded.sliced_for_model == "X1C"


# ---------------------------------------------------------------------------
# Slicer content rejections surface instead of silently falling back
# ---------------------------------------------------------------------------


class TestSlicerRejectionMessage:
    """_slicer_rejection_message distinguishes a real slicer content rejection
    (surface it to the user) from a CLI crash (fall back to embedded)."""

    def test_extracts_bed_boundary_reason(self):
        text = (
            "Slicer CLI failed (500): Slicing failed with error from slicer: "
            "Some objects are located over the boundary of the heated bed.: "
            "Slicer process failed (exit code 204)\nstdout: trace ..."
        )
        assert _slicer_rejection_message(text) == "Some objects are located over the boundary of the heated bed."

    def test_extracts_filament_temp_reason(self):
        text = (
            "Slicer CLI failed (500): Slicing failed with error from slicer: "
            "The temperature difference of the filaments used is too large.: "
            "Slicer process failed (exit code 194)"
        )
        assert _slicer_rejection_message(text) == "The temperature difference of the filaments used is too large."

    def test_generic_cli_failure_is_not_a_rejection(self):
        # The #1201 CLI-crash signature carries no slicer error_string, so it
        # must still fall through to the embedded-settings fallback.
        assert _slicer_rejection_message("Slicer CLI failed (500): Failed to slice the model") is None

    def test_empty_or_unrelated_text(self):
        assert _slicer_rejection_message("") is None
        assert _slicer_rejection_message("Slicer sidecar unreachable: connection reset") is None


class TestSliceSlicerRejection:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_3mf_surfaces_slicer_rejection_instead_of_falling_back(
        self, async_client: AsyncClient, db_session, slice_test_setup
    ):
        """A real slicer content rejection (e.g. re-slicing for a printer with
        a smaller bed) must surface as a 400 — not silently fall back to the
        source 3MF's embedded settings, which would re-slice for the original
        printer and hide the problem."""
        src_3mf_path = slice_test_setup["tmp_path"] / "library" / "files" / "toobig.3mf"
        src_3mf_path.write_bytes(_make_3mf_with_settings())
        threemf = LibraryFile(
            filename="toobig.3mf",
            file_path=str(src_3mf_path.relative_to(slice_test_setup["tmp_path"])),
            file_type="3mf",
            file_size=src_3mf_path.stat().st_size,
        )
        db_session.add(threemf)
        await db_session.commit()
        await db_session.refresh(threemf)

        call_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            call_count["n"] += 1
            return httpx.Response(
                status_code=500,
                json={
                    "message": (
                        "Slicing failed with error from slicer: Some objects are "
                        "located over the boundary of the heated bed."
                    ),
                    "details": "Slicer process failed (exit code 204)",
                },
            )

        _install_mock_sidecar(handler)
        response = await async_client.post(
            f"/api/v1/library/files/{threemf.id}/slice",
            json={
                "printer_preset_id": slice_test_setup["printer_id"],
                "process_preset_id": slice_test_setup["process_id"],
                "filament_preset_id": slice_test_setup["filament_id"],
            },
        )
        assert response.status_code == 202

        final = await _wait_for_job(async_client, response.json()["job_id"])
        assert final["status"] == "failed", final
        assert final["error_status"] == 400
        assert "boundary of the heated bed" in (final["error_detail"] or "")
        # The slicer rejection must NOT trigger the embedded-settings retry.
        assert call_count["n"] == 1


# ---------------------------------------------------------------------------
# Nozzle-class re-slice guard — single-nozzle <-> dual-nozzle (H2D) is blocked
# ---------------------------------------------------------------------------

from fastapi import HTTPException  # noqa: E402

from backend.app.api.routes.library import (  # noqa: E402
    _canonical_printer_model,
    guard_nozzle_class_reslice,
)


class TestCanonicalPrinterModel:
    """_canonical_printer_model strips the '# ' clone prefix and the
    ' 0.4 nozzle' variant suffix so preset names resolve to a model code."""

    def test_strips_nozzle_suffix(self):
        assert _canonical_printer_model("Bambu Lab H2D 0.4 nozzle") == "H2D"

    def test_strips_clone_prefix_and_suffix(self):
        assert _canonical_printer_model("# Bambu Lab X1 Carbon 0.4 nozzle") == "X1C"

    def test_bare_model_and_empty(self):
        assert _canonical_printer_model("Bambu Lab H2D") == "H2D"
        assert _canonical_printer_model(None) is None
        assert _canonical_printer_model("") is None


class TestNozzleClassGuard:
    """guard_nozzle_class_reslice blocks a re-slice that crosses the
    single-nozzle <-> dual-nozzle boundary."""

    @pytest.mark.asyncio
    async def test_single_to_dual_is_blocked(self, monkeypatch):
        import backend.app.api.routes.library as lib

        async def _target(_db, _user, _request):
            return "H2D"

        monkeypatch.setattr(lib, "_resolve_target_printer_model", _target)
        with pytest.raises(HTTPException) as exc:
            await guard_nozzle_class_reslice(None, None, None, "X1C")
        assert exc.value.status_code == 400
        assert "H2D" in exc.value.detail and "X1C" in exc.value.detail

    @pytest.mark.asyncio
    async def test_dual_to_single_is_blocked(self, monkeypatch):
        import backend.app.api.routes.library as lib

        async def _target(_db, _user, _request):
            return "X1C"

        monkeypatch.setattr(lib, "_resolve_target_printer_model", _target)
        with pytest.raises(HTTPException):
            await guard_nozzle_class_reslice(None, None, None, "H2D")

    @pytest.mark.asyncio
    async def test_same_nozzle_class_is_allowed(self, monkeypatch):
        import backend.app.api.routes.library as lib

        async def _target(_db, _user, _request):
            return "P1S"

        monkeypatch.setattr(lib, "_resolve_target_printer_model", _target)
        # X1C -> P1S: both single-nozzle — no raise.
        await guard_nozzle_class_reslice(None, None, None, "X1C")

    @pytest.mark.asyncio
    async def test_no_source_model_is_a_noop(self, monkeypatch):
        import backend.app.api.routes.library as lib

        async def _target(_db, _user, _request):
            return "H2D"

        monkeypatch.setattr(lib, "_resolve_target_printer_model", _target)
        # Un-sliced source (no sliced_for_model) — first-time slice, never blocked.
        await guard_nozzle_class_reslice(None, None, None, None)

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_archive_reslice_x1c_to_h2d_returns_400(
        self, async_client: AsyncClient, db_session, slice_test_setup, printer_factory, archive_factory, monkeypatch
    ):
        """End to end: re-slicing an X1C archive for an H2D printer preset is
        rejected synchronously with a 400 — before any job is enqueued."""
        tmp_path = slice_test_setup["tmp_path"]
        monkeypatch.setattr(app_settings, "archive_dir", tmp_path / "archive")

        src_dir = tmp_path / "archives" / "src"
        src_dir.mkdir(parents=True, exist_ok=True)
        src_3mf = src_dir / "cube.3mf"
        src_3mf.write_bytes(_make_3mf_with_settings())
        printer = await printer_factory()
        source = await archive_factory(
            printer.id,
            filename="cube.3mf",
            file_path=str(src_3mf.relative_to(tmp_path)),
            sliced_for_model="X1C",
            with_run=False,
        )

        # A printer preset whose resolved JSON is an H2D — dual-nozzle.
        h2d = LocalPreset(
            name="# Bambu Lab H2D 0.4 nozzle",
            preset_type="printer",
            source="orcaslicer",
            setting=json.dumps({"name": "Bambu Lab H2D 0.4 nozzle", "printer_model": "Bambu Lab H2D"}),
        )
        db_session.add(h2d)
        await db_session.commit()
        await db_session.refresh(h2d)

        resp = await async_client.post(
            f"/api/v1/archives/{source.id}/slice",
            json={
                "printer_preset": {"source": "local", "id": str(h2d.id)},
                "process_preset": {"source": "local", "id": str(slice_test_setup["process_id"])},
                "filament_presets": [{"source": "local", "id": str(slice_test_setup["filament_id"])}],
            },
        )
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        assert "H2D" in detail and "X1C" in detail
