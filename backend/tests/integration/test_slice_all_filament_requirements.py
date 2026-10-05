"""Slice-all asks filament-requirements for the whole file (no plate_id).

A slot used on several plates must come back once, matching the dedup the
slice enqueue validation applies via ``extract_filament_requirements``.
"""

import io
import zipfile
from pathlib import Path

import pytest
from httpx import AsyncClient

from backend.app.core.config import settings as app_settings

SLICE_INFO = """<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="index" value="1"/>
    <filament id="1" type="PLA" color="#FF0000" used_g="5.0" used_m="1.5" tray_info_idx="GFA00"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <filament id="1" type="PLA" color="#FF0000" used_g="7.0" used_m="2.0" tray_info_idx="GFA00"/>
    <filament id="2" type="PETG" color="#00FF00" used_g="3.0" used_m="1.0" tray_info_idx="GFG00"/>
  </plate>
</config>
"""


@pytest.fixture(autouse=True)
def _isolated_base_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(app_settings, "base_dir", tmp_path)


def _write_3mf(relative_path: str) -> None:
    path = Path(app_settings.base_dir) / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Metadata/slice_info.config", SLICE_INFO)
    path.write_bytes(buf.getvalue())


def _slot_ids(response) -> list[int]:
    assert response.status_code == 200, response.text
    return [f["slot_id"] for f in response.json()["filaments"]]


class TestSliceAllFilamentRequirements:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_library_file_dedupes_slots_across_plates(self, async_client: AsyncClient, db_session):
        from backend.app.models.library import LibraryFile

        _write_3mf("library/files/slice_all_reqs.gcode.3mf")
        lib_file = LibraryFile(
            filename="slice_all_reqs.gcode.3mf",
            file_path="library/files/slice_all_reqs.gcode.3mf",
            file_size=1,
            file_type="3mf",
        )
        db_session.add(lib_file)
        await db_session.commit()
        await db_session.refresh(lib_file)

        response = await async_client.get(f"/api/v1/library/files/{lib_file.id}/filament-requirements")
        assert _slot_ids(response) == [1, 2]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_archive_dedupes_slots_across_plates(
        self, async_client: AsyncClient, printer_factory, archive_factory
    ):
        _write_3mf("archives/slice_all_reqs/slice_all_reqs.gcode.3mf")
        printer = await printer_factory()
        archive = await archive_factory(printer.id, file_path="archives/slice_all_reqs/slice_all_reqs.gcode.3mf")

        response = await async_client.get(f"/api/v1/archives/{archive.id}/filament-requirements")
        assert _slot_ids(response) == [1, 2]


class TestUnknownPlateRejected:
    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_library_file_rejects_plate_not_in_3mf(self, async_client: AsyncClient, db_session):
        from backend.app.models.library import LibraryFile

        _write_3mf("library/files/unknown_plate.gcode.3mf")
        lib_file = LibraryFile(
            filename="unknown_plate.gcode.3mf",
            file_path="library/files/unknown_plate.gcode.3mf",
            file_size=1,
            file_type="3mf",
        )
        db_session.add(lib_file)
        await db_session.commit()
        await db_session.refresh(lib_file)

        base = f"/api/v1/library/files/{lib_file.id}/filament-requirements"
        assert (await async_client.get(base, params={"plate_id": 999})).status_code == 400
        assert (await async_client.get(base, params={"plate_id": 2})).status_code == 200

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_archive_rejects_plate_not_in_3mf(self, async_client: AsyncClient, printer_factory, archive_factory):
        _write_3mf("archives/unknown_plate/unknown_plate.gcode.3mf")
        printer = await printer_factory()
        archive = await archive_factory(printer.id, file_path="archives/unknown_plate/unknown_plate.gcode.3mf")

        base = f"/api/v1/archives/{archive.id}/filament-requirements"
        assert (await async_client.get(base, params={"plate_id": 999})).status_code == 400
        assert (await async_client.get(base, params={"plate_id": 2})).status_code == 200
