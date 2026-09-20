"""Regression coverage for Orca's default model/material/duration convention."""

import pytest

from backend.app.utils.slicer_filename import default_klipper_filename


@pytest.mark.parametrize(
    "seconds,label",
    [
        (42, "42s"),
        (582, "9m42s"),
        (3599, "59m59s"),
        (3629, "1h0m"),
        (3630, "1h1m"),
        (86399, "1d0h0m"),
        (90030, "1d1h1m"),
    ],
)
def test_orca_short_time_matches_pinned_engine(seconds, label):
    assert (
        default_klipper_filename("3dbenchy.stl", b"; filament_type = PLA\nG28\n", seconds)
        == f"3dbenchy_PLA_{label}.gcode"
    )


@pytest.mark.parametrize(
    "filename", ["Cube.stl", "Cube.3mf", "Cube.gcode.3mf", "Cube.gcode.3mf.gcode.3mf", r"C:\models\Cube.stl"]
)
def test_source_suffixes_do_not_accumulate(filename):
    assert default_klipper_filename(filename, b"; filament_type = PLA\n", 582) == "Cube_PLA_9m42s.gcode"


@pytest.mark.parametrize("tool", [b"; initial_tool = 1\n", b"; initial_extruder = 1\n", b"T1\n"])
def test_initial_tool_selects_material_not_first_or_source_archive(tool):
    assert default_klipper_filename("Cube.stl", b"; filament_type = PLA;PETG\n" + tool, 582) == "Cube_PETG_9m42s.gcode"


def test_json_types_and_gcode_duration_fallback():
    content = (
        b'; filament_type = ["PLA", "ABS"]\n; initial_tool = 1\n; estimated printing time (normal mode) = 2h 59m 40s\n'
    )
    assert default_klipper_filename("Cube.stl", content, 0) == "Cube_ABS_3h0m.gcode"


@pytest.mark.parametrize(
    "content,seconds",
    [
        (b"G28\n", 582),
        (b"; filament_type = PLA\n", 0),
        (b"; filament_type = PLA;ABS\n", 582),
        (b"; filament_type = PLA\n; initial_tool = 999\n", 582),
        (b"; filament_type = [\n", 582),
    ],
)
def test_incomplete_metadata_retains_name_without_invented_labels(content, seconds, caplog):
    assert default_klipper_filename("Cube.stl", content, seconds) == "Cube.gcode"
    assert "lacks material/tool or duration metadata" in caplog.text


def test_config_at_end_of_large_artifact_and_unicode_names():
    content = b"G28\n" + b"; filler\n" * 600_000 + b"; filament_type = PLA\n"
    name = default_klipper_filename("模型" * 200 + ".stl", content, 582)
    assert len(name.encode("utf-8")) <= 255
    assert name.startswith("模型") and name.endswith("_PLA_9m42s.gcode")


def test_safe_spaces_are_preserved_and_unsafe_generated_characters_sanitized():
    assert default_klipper_filename("My Cube.stl", b"; filament_type = PETG/CF\n", 582) == "My Cube_PETG_CF_9m42s.gcode"
