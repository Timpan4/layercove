"""Default Orca export names use real output metadata, not dispatch identifiers."""

import pytest

from backend.app.services.slicer_output import orca_gcode_filename, orca_print_time
from backend.app.utils.filename import InvalidFilenameError, validate_moonraker_gcode_basename


@pytest.mark.parametrize(
    "seconds,expected",
    [
        (0, "0s"),
        (59, "59s"),
        (60, "1m0s"),
        (582, "9m42s"),
        (3599, "59m59s"),
        (3600, "1h0m"),
        (3629, "1h0m"),
        (3630, "1h1m"),
        (86370, "1d0h0m"),
        (90000, "1d1h0m"),
    ],
)
def test_print_time_matches_orca_short_time(seconds, expected):
    assert orca_print_time(seconds) == expected


@pytest.mark.parametrize("seconds", [-1, True, 1.5, "582"])
def test_invalid_statistics_are_not_formatted_as_real_estimates(seconds):
    with pytest.raises(ValueError):
        orca_print_time(seconds)


@pytest.mark.parametrize("source", ["3dbenchy.stl", "3dbenchy.3mf", "3dbenchy.gcode.3mf"])
def test_default_export_name(source):
    assert orca_gcode_filename(source, b"; filament_type = PLA\nG28\n", 582) == "3dbenchy_PLA_9m42s.gcode"


def test_initial_tool_not_first_profile_determines_material():
    gcode = b"; initial_tool = 1\nG28\n; filament_type = PLA;ABS\n"
    assert orca_gcode_filename("Part.stl", gcode, 3600) == "Part_ABS_1h0m.gcode"


def test_virtual_tool_comment_determines_material():
    gcode = b";VT1\nG28\n; filament_type = PLA;ABS\n"
    assert orca_gcode_filename("Part.stl", gcode, 3600) == "Part_ABS_1h0m.gcode"


@pytest.mark.parametrize("gcode", [b"G28\n", b"; filament_type = \n; other = PLA\n", b"; filament_type = PLA;ABS\n"])
def test_missing_or_ambiguous_material_is_not_guessed(gcode, caplog):
    assert orca_gcode_filename("Part.stl", gcode, 582) == "Part.gcode"
    assert "unambiguous filament metadata" in caplog.text


def test_unicode_and_spaces_survive_while_total_length_is_bounded():
    name = orca_gcode_filename("Å part " + "å" * 120 + ".stl", b"; filament_type = PLA\n", 582)
    assert name.startswith("Å part ")
    assert name.endswith("_PLA_9m42s.gcode")
    validate_moonraker_gcode_basename(name)


def test_material_metadata_cannot_add_paths_or_controls():
    name = orca_gcode_filename("Part.stl", b"; filament_type = ../../PLA\x00\n", 60)
    assert "/" not in name and "\x00" not in name
    validate_moonraker_gcode_basename(name)


def test_source_filename_validation_is_not_weakened():
    with pytest.raises(InvalidFilenameError):
        orca_gcode_filename("Part\x00.stl", b"; filament_type = PLA\n", 60)


@pytest.mark.parametrize("stem", ["a" * 251, "å" * 125 + "a"])
@pytest.mark.parametrize("gcode,suffix", [(b"; filament_type = PLA\nG28\n", "_PLA_9m42s.gcode"), (b"G28\n", ".gcode")])
def test_maximum_source_basename_is_truncated_before_output_validation(stem, gcode, suffix):
    source = f"{stem}.stl"
    assert len(source.encode("utf-8")) == 255
    result = orca_gcode_filename(source, gcode, 582)
    assert result.endswith(suffix)
    assert len(result.encode("utf-8")) <= 255
    assert stem.startswith(result[: -len(suffix)])
    validate_moonraker_gcode_basename(result)


@pytest.mark.parametrize("source,material", [("Part.stl", "A" * 255), ("å.stl", "A" * 242)])
def test_filename_budget_errors_use_filename_exception(source, material):
    with pytest.raises(InvalidFilenameError, match="filename limit"):
        orca_gcode_filename(source, f"; filament_type = {material}\nG28\n".encode(), 60)


def test_truncation_does_not_hide_invalid_source_characters():
    with pytest.raises(InvalidFilenameError):
        orca_gcode_filename("a" * 240 + "?bad.stl", b"; filament_type = PLA\n", 582)
