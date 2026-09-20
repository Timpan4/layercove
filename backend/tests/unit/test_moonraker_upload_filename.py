"""The exported basename stays readable; the upload directory owns uniqueness."""

import pytest

from backend.app.utils.filename import (
    MAX_FILENAME_BYTES,
    InvalidFilenameError,
    derive_moonraker_upload_filename,
    validate_moonraker_gcode_basename,
    validate_moonraker_upload_directory,
)


@pytest.mark.parametrize(
    "filename",
    [
        "Calibration Cube_PLA_9m42s.gcode",
        "Calibration Cube_PLA_9m42s.GCODE.3MF",
        "Calibration Cube_PLA_9m42s.3mf.gcode.3mf",
    ],
)
def test_orca_basename_is_not_decorated_with_plate_or_dispatch_id(filename):
    assert derive_moonraker_upload_filename(filename) == "Calibration Cube_PLA_9m42s.gcode"


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
    actual = derive_moonraker_upload_filename(filename)
    assert actual == f"{stem}.gcode"
    validate_moonraker_gcode_basename(actual)


@pytest.mark.parametrize("prefix", ["x", "å", "模型", "🧱"])
def test_utf8_truncation_preserves_extension(prefix):
    actual = derive_moonraker_upload_filename(prefix * 500 + ".gcode.3mf")
    assert len(actual.encode("utf-8")) <= MAX_FILENAME_BYTES
    assert actual.startswith(prefix)
    assert actual.endswith(".gcode")
    validate_moonraker_gcode_basename(actual)


@pytest.mark.parametrize(
    "directory",
    [
        "",
        "/root",
        "../other",
        "safe/../other",
        "safe/./other",
        "safe//other",
        "safe/",
        r"safe\other",
        "safe/\x00",
        "safe/\u202e",
        "x" * 256,
    ],
)
def test_upload_directory_cannot_escape_root_or_be_normalized(directory):
    with pytest.raises(InvalidFilenameError):
        validate_moonraker_upload_directory(directory)


def test_safe_dispatch_directory():
    validate_moonraker_upload_directory("layercove/12345678123442348234123456789abc")


def test_source_must_be_a_real_string():
    with pytest.raises(TypeError):
        derive_moonraker_upload_filename(None)
