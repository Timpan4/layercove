"""Keep Orca basenames; dispatch directories own attempt uniqueness."""

from uuid import UUID

import pytest

from backend.app.utils.filename import (
    MAX_FILENAME_BYTES,
    InvalidFilenameError,
    derive_moonraker_upload_filename,
    validate_moonraker_gcode_basename,
)

DISPATCH = "12345678-1234-4234-8234-123456789abc"


@pytest.mark.parametrize(
    "filename", ["Calibration Cube.gcode", "Calibration Cube.GCODE.3MF", "Calibration Cube.3mf.gcode.3mf"]
)
def test_model_basename_does_not_gain_dispatch_or_plate_suffix(filename):
    assert derive_moonraker_upload_filename(filename, DISPATCH, 2) == ("Calibration Cube.gcode")


@pytest.mark.parametrize(
    "filename,stem",
    [
        ("../../parts/Cube.gcode", "Cube"),
        (r"C:\parts\Cube.gcode", "Cube"),
        ('Bad<name>:"?*.gcode', "Bad_name"),
        ("..", "print"),
        (".gcode.3mf", "print"),
        ("", "print"),
        ("   ", "print"),
        ("Part\x00\r\n\x7f\u202e.gcode", "Part"),
        ("Räksmörgås.gcode", "Räksmörgås"),
    ],
)
def test_legacy_names_are_safe_basenames(filename, stem):
    actual = derive_moonraker_upload_filename(filename, DISPATCH)
    assert actual == f"{stem}.gcode"
    validate_moonraker_gcode_basename(actual)


@pytest.mark.parametrize("prefix", ["x", "å", "模型", "🧱"])
def test_utf8_truncation_preserves_gcode_extension(prefix):
    actual = derive_moonraker_upload_filename(prefix * 500 + ".gcode.3mf", DISPATCH, 1)
    assert len(actual.encode("utf-8")) <= MAX_FILENAME_BYTES
    assert actual.startswith(prefix)
    assert actual.endswith(".gcode")
    validate_moonraker_gcode_basename(actual)


def test_retries_and_plates_keep_the_original_basename():
    other = "12345678-1234-4234-8234-123456789abd"
    first = derive_moonraker_upload_filename("Cube.gcode", DISPATCH, 1)
    assert first == derive_moonraker_upload_filename("Cube.gcode", other, 1)
    assert first == derive_moonraker_upload_filename("Cube.gcode", DISPATCH, 2)
    assert first == derive_moonraker_upload_filename("Cube.gcode", DISPATCH, 1)


@pytest.mark.parametrize("plate", [0, -1, True, "2", 1.5])
def test_invalid_plate_ids_are_rejected(plate):
    with pytest.raises(InvalidFilenameError):
        derive_moonraker_upload_filename("Cube.gcode", DISPATCH, plate)


def test_dispatch_id_cannot_be_a_path():
    with pytest.raises(ValueError):
        derive_moonraker_upload_filename("Cube.gcode", "../another-job")


def test_source_must_be_a_real_string():
    with pytest.raises(TypeError):
        derive_moonraker_upload_filename(None, DISPATCH)


@pytest.mark.parametrize("filename", ["3dbenchy_PLA_9m42s.gcode", "Paper Towel Holder_PLA_7h46m.gcode"])
def test_orca_export_basename_survives_queue_dispatch(filename):
    assert derive_moonraker_upload_filename(filename, DISPATCH, 1) == filename
