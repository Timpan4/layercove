"""Display names for headless Orca output, separate from storage identities."""

import logging
import re
from pathlib import Path

from backend.app.utils.filename import INVALID_FILENAME_CHARS, MAX_FILENAME_BYTES, validate_moonraker_gcode_basename

logger = logging.getLogger(__name__)
_SETTINGS_BYTES = 2 * 1024 * 1024
_HEADER_BYTES = 256 * 1024
_FILAMENT_TYPES = re.compile(rb"(?m)^;[ \t]*filament_type[ \t]*=[ \t]*([^\r\n]{1,4096})\r?$")
_INITIAL_TOOL = re.compile(rb"(?m)^(?:;\s*(?:initial_tool|initial_extruder)\s*=\s*|;VT|T)([0-9]+)(?:\s|;|$)")


def orca_print_time(seconds: int) -> str:
    """Match Orca's short_time: retain seconds below one hour, round above it."""
    if type(seconds) is not int or seconds < 0:
        raise ValueError("Slicer print time must be a nonnegative integer")
    if seconds >= 3600:
        seconds = ((seconds + 30) // 60) * 60
    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, seconds = divmod(remainder, 60)
    if days:
        return f"{days}d{hours}h{minutes}m"
    if hours:
        return f"{hours}h{minutes}m"
    if minutes:
        return f"{minutes}m{seconds}s"
    return f"{seconds}s"


def _initial_material(gcode: bytes) -> str | None:
    # Orca writes its resolved settings at the end. Keep scanning/allocation
    # bounded even for very large prints; also accept header-style metadata.
    match = _FILAMENT_TYPES.search(gcode, max(0, len(gcode) - _SETTINGS_BYTES))
    if match is None:
        match = _FILAMENT_TYPES.search(gcode, 0, min(len(gcode), _HEADER_BYTES))
    if match is None:
        return None
    try:
        materials = [part.strip().strip('"') for part in match[1].decode("utf-8").split(";")]
    except UnicodeDecodeError:
        return None
    if not materials or not all(materials):
        return None
    if len(set(materials)) == 1:
        return materials[0]
    tool = _INITIAL_TOOL.search(gcode, 0, min(len(gcode), _HEADER_BYTES))
    if tool is None or len(tool[1]) > 3:
        return None
    index = int(tool[1])
    return materials[index] if index < len(materials) else None


def orca_gcode_filename(model_filename: str, gcode: bytes, print_time_seconds: int) -> str:
    """Apply Orca's default model/material/time pattern to raw G-code exports.

    The pinned CLI names temporary output plate_N.gcode; it does not run the
    desktop export-name formatter. Use actual output material metadata and
    sidecar statistics, never a printer label, queue ID or guessed material.
    Older/non-Orca responses without sufficient metadata retain a model-only
    name with a diagnostic rather than inventing a filament type.
    """
    base = Path(model_filename.replace("\\", "/")).name
    if base.lower().endswith(".gcode.3mf"):
        base = base[:-10]
    else:
        base = base.rsplit(".", 1)[0]
    validate_moonraker_gcode_basename(f"{base}.gcode")
    material = _initial_material(gcode)
    if material is None:
        logger.warning("Slicer output lacks unambiguous filament metadata; retaining model-only filename")
        return f"{base}.gcode"
    material = "".join("_" if char in INVALID_FILENAME_CHARS or not char.isprintable() else char for char in material)
    suffix = f"_{material}_{orca_print_time(print_time_seconds)}.gcode"
    budget = MAX_FILENAME_BYTES - len(suffix.encode("utf-8"))
    if budget < 1:
        raise ValueError("Slicer filament metadata exceeds the filename limit")
    base = base.encode("utf-8")[:budget].decode("utf-8", errors="ignore").rstrip(" .")
    if not base:
        raise ValueError("Slicer filename exceeds the filename limit")
    result = f"{base}{suffix}"
    validate_moonraker_gcode_basename(result)
    return result
