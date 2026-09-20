"""Orca's default filename convention for raw G-code returned by legacy sidecars.

The current sidecar returns the artifact bytes and statistics, not Orca's
suggested export filename. Use the produced G-code's material/tool metadata,
never the source archive's potentially stale filament label.
"""

import csv
import json
import logging
import re

from backend.app.utils.filename import (
    INVALID_FILENAME_CHARS,
    MAX_FILENAME_BYTES,
    validate_moonraker_gcode_basename,
)

logger = logging.getLogger(__name__)
_WINDOW = 2 * 1024 * 1024
_OPTION = re.compile(r"^;\s*(filament_type|initial_tool|initial_extruder)\s*=\s*([^\r\n]{1,8192})$", re.MULTILINE)
_TOOL = re.compile(r"^T([0-9]{1,3})(?:\s|;|$)", re.MULTILINE)
_TIME = re.compile(r"^;\s*estimated printing time \(normal mode\)\s*=\s*([^\r\n]{1,128})$", re.MULTILINE)


def _safe_stem(filename: str) -> str:
    stem = filename.replace("\\", "/").rsplit("/", 1)[-1]
    while suffix := next(
        (
            ext
            for ext in (".gcode.3mf", ".3mf", ".gcode", ".stl", ".step", ".stp", ".obj")
            if stem.lower().endswith(ext)
        ),
        None,
    ):
        stem = stem[: -len(suffix)]
    return (
        "".join("_" if ch in INVALID_FILENAME_CHARS or not ch.isprintable() else ch for ch in stem).strip(" ._")
        or "print"
    )


def _orca_short_time(seconds: int) -> str:
    """Match pinned Orca Utils::short_time, including rounding hour-long jobs."""
    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, seconds = divmod(remainder, 60)
    if (days or hours) and seconds >= 30:
        minutes += 1
        hours += minutes // 60
        minutes %= 60
        days += hours // 24
        hours %= 24
    if days:
        return f"{days}d{hours}h{minutes}m"
    if hours:
        return f"{hours}h{minutes}m"
    if minutes:
        return f"{minutes}m{seconds}s"
    return f"{seconds}s"


def default_klipper_filename(filename: str, content: bytes, print_time_seconds: int) -> str:
    """Return model_material_time.gcode when the output establishes those values.

    Old or third-party sidecars may omit metadata. Keep their model basename
    with a warning rather than inventing a material or estimated duration.
    Bounds avoid decoding another complete copy of a large toolpath.
    """
    stem = _safe_stem(filename)
    if len(content) <= 2 * _WINDOW:
        text = content.decode("utf-8", errors="replace")
    else:
        text = (content[:_WINDOW] + b"\n" + content[-_WINDOW:]).decode("utf-8", errors="replace")
    values = dict(_OPTION.findall(text))
    types: list[str] = []
    raw_types = values.get("filament_type", "")
    try:
        parsed = json.loads(raw_types) if raw_types.startswith("[") else next(csv.reader([raw_types], delimiter=";"))
        if isinstance(parsed, list) and all(isinstance(value, str) for value in parsed):
            types = [value.strip() for value in parsed]
    except (ValueError, csv.Error):
        pass
    tool_text = values.get("initial_tool", values.get("initial_extruder"))
    if tool_text is None:
        match = _TOOL.search(text)
        tool_text = match[1] if match else ("0" if len(types) == 1 else None)
    tool = int(tool_text) if tool_text is not None and tool_text.isdecimal() and len(tool_text) <= 3 else -1
    material = types[tool] if 0 <= tool < len(types) else ""
    seconds = print_time_seconds
    if seconds <= 0 and (match := _TIME.search(text)):
        duration = match[1].strip()
        if re.fullmatch(r"(?:[0-9]{1,8}[dhms]\s*)+", duration):
            seconds = sum(
                int(number) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
                for number, unit in re.findall(r"([0-9]+)([dhms])", duration)
            )
    suffix = ".gcode"
    if material and seconds > 0:
        material = "".join("_" if ch in INVALID_FILENAME_CHARS or not ch.isprintable() else ch for ch in material)
        suffix = f"_{material}_{_orca_short_time(seconds)}.gcode"
        if len(suffix.encode("utf-8")) >= MAX_FILENAME_BYTES:
            raise ValueError("Slicer material label exceeds filename limit")
    else:
        logger.warning("Slicer output lacks material/tool or duration metadata; retaining the model basename")
    stem = (
        stem.encode("utf-8")[: MAX_FILENAME_BYTES - len(suffix.encode("utf-8"))]
        .decode("utf-8", errors="ignore")
        .rstrip(" ._")
    )
    if not stem:
        raise ValueError("Slicer filename has no room for a model name")
    result = f"{stem}{suffix}"
    validate_moonraker_gcode_basename(result)
    return result
