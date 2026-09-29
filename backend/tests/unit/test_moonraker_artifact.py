"""Only positively identified Klipper plates may cross the container boundary."""

import asyncio
import json
import threading
import warnings
import zipfile

import pytest

from backend.app.services import moonraker_artifact as artifact
from backend.app.services.moonraker_artifact import ArtifactValidationError, moonraker_gcode_source


def make_bundle(tmp_path, entries):
    path = tmp_path / "cube.gcode.3mf"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)  # Deliberately duplicated ZIP entries.
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as bundle:
            for name, value in entries:
                bundle.writestr(name, value)
    return path


@pytest.mark.parametrize("source", ["project", "gcode", "both"])
async def test_extracts_only_selected_plate_and_closes_stream(tmp_path, source):
    gcode = b"; gcode_flavor = klipper\nG28\n" if source != "project" else b"G28\n"
    entries = [("Metadata/plate_1.gcode", b"G1 X999\n"), ("Metadata/plate_2.gcode", gcode)]
    if source != "gcode":
        entries.append(("Metadata/project_settings.config", json.dumps({"gcode_flavor": "klipper"})))
    path = make_bundle(tmp_path, entries)
    original = path.read_bytes()
    async with moonraker_gcode_source(path, 2) as prepared:
        assert prepared.file.read() == gcode
        assert prepared.size == len(gcode)
    assert prepared.file.closed
    assert path.read_bytes() == original


@pytest.mark.parametrize(
    "entries,plate,error",
    [
        ([("Metadata/plate_1.gcode", "G28\n")], 1, "Cannot confirm"),
        ([("Metadata/plate_1.gcode", "; gcode_flavor = marlin\nG28\n")], 1, "not compatible"),
        (
            [
                ("Metadata/plate_1.gcode", "; gcode_flavor = klipper\nG28\n"),
                ("Metadata/project_settings.config", '{"gcode_flavor":"marlin"}'),
            ],
            1,
            "not compatible",
        ),
        (
            [
                ("Metadata/plate_1.gcode", "; gcode_flavor = marlin\nG28\n"),
                ("Metadata/project_settings.config", '{"gcode_flavor":"klipper"}'),
            ],
            1,
            "not compatible",
        ),
        (
            [
                ("Metadata/plate_1.gcode", "; gcode_flavor = klipper\nG28\n"),
                ("Metadata/project_settings.config", "not json"),
            ],
            1,
            "metadata is invalid",
        ),
        (
            [("Metadata/plate_1.gcode", "; gcode_flavor = klipper\nG28\n"), ("Metadata/project_settings.config", "[]")],
            1,
            "metadata is invalid",
        ),
        ([("Metadata/plate_1.gcode", "; gcode_flavor = klipper\nG28\n")], 2, "exactly one"),
        (
            [
                ("Metadata/plate_1.gcode", "; gcode_flavor = klipper\nG28\n"),
                ("Metadata/plate_2.gcode", "; gcode_flavor = klipper\nG28\n"),
            ],
            None,
            "exactly one",
        ),
        ([("Metadata/plate_1.gcode", "G28\n"), ("Metadata/plate_1.gcode", "G28\n")], 1, "exactly one"),
        (
            [
                ("Metadata/plate_1.gcode", "G28\n"),
                ("Metadata/project_settings.config", "{}"),
                ("Metadata/project_settings.config", "{}"),
            ],
            1,
            "ambiguous",
        ),
        ([("../plate_1.gcode", "; gcode_flavor = klipper\nG28\n")], 1, "exactly one"),
        ([("Metadata/plate_1.gcode", b"\0bad")], 1, "binary"),
        ([("Metadata/plate_1.gcode", b"PK\x03\x04nested")], 1, "binary"),
    ],
)
async def test_rejects_unverified_ambiguous_or_binary_plate(tmp_path, entries, plate, error):
    path = make_bundle(tmp_path, entries)
    with pytest.raises(ArtifactValidationError, match=error):
        async with moonraker_gcode_source(path, plate):
            pytest.fail("unsafe artifact was accepted")
    assert not (tmp_path.parent / "plate_1.gcode").exists()


@pytest.mark.parametrize("content", [b"", b"   \n", b"PK\x03\x04zip", b"GCDEbinary", b"\x1f\x8bgzip", b"G28\0"])
async def test_raw_filename_cannot_disguise_container_or_binary(tmp_path, content):
    path = tmp_path / "cube.gcode"
    path.write_bytes(content)
    with pytest.raises(ArtifactValidationError, match="raw text G-code"):
        async with moonraker_gcode_source(path, None):
            pytest.fail("non-G-code was accepted")


async def test_raw_stream_is_closed_on_upload_error(tmp_path):
    path = tmp_path / "cube.gcode"
    path.write_bytes(b"G28\n")
    with pytest.raises(RuntimeError, match="upload failed"):
        async with moonraker_gcode_source(path, None) as prepared:
            assert prepared.file.read() == b"G28\n"
            raise RuntimeError("upload failed")
    assert prepared.file.closed


async def test_bounded_member_and_metadata_reads(tmp_path, monkeypatch):
    path = make_bundle(tmp_path, [("Metadata/plate_1.gcode", "; gcode_flavor = klipper\nG28\n")])
    monkeypatch.setattr(artifact, "MOONRAKER_MAX_UPLOAD_BYTES", 8)
    with pytest.raises(ArtifactValidationError, match="size limit"):
        async with moonraker_gcode_source(path, 1):
            pytest.fail("oversized member was accepted")
    path = make_bundle(tmp_path, [("Metadata/project_settings.config", '{"gcode_flavor":"klipper"}')])
    monkeypatch.setattr(artifact, "_MAX_METADATA_BYTES", 8)
    with pytest.raises(ArtifactValidationError, match="size limit"):
        async with moonraker_gcode_source(path, 1):
            pytest.fail("oversized metadata was accepted")


async def test_cancelled_extraction_closes_its_late_result(tmp_path, monkeypatch):
    path = tmp_path / "cube.gcode"
    path.write_bytes(b"G28\n")
    started = threading.Event()
    release = threading.Event()
    output = []
    prepare = artifact._prepare

    def delayed_prepare(*args):
        started.set()
        assert release.wait(5)
        result = prepare(*args)
        output.append(result.file)
        return result

    monkeypatch.setattr(artifact, "_prepare", delayed_prepare)

    async def extract():
        async with moonraker_gcode_source(path, None):
            pytest.fail("cancelled extraction must not upload")

    task = asyncio.create_task(extract())
    try:
        assert await asyncio.to_thread(started.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        release.set()
    async with asyncio.timeout(5):
        while not output or not output[0].closed:
            await asyncio.sleep(0)
