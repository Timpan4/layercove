"""Prepare a raw G-code stream; never upload a 3MF container to Moonraker."""

from __future__ import annotations

import asyncio
import json
import re
import tempfile
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import BinaryIO, NamedTuple

from backend.app.services.moonraker_http import MOONRAKER_MAX_UPLOAD_BYTES

_MAX_METADATA_BYTES = 8 * 1024 * 1024
_CHUNK_BYTES = 64 * 1024
_PLATE = re.compile(r"(?:Metadata/)?plate_([1-9][0-9]*)\.gcode\Z")
_FLAVOR = re.compile(rb";\s*gcode_flavor\s*=\s*(.*?)\s*\Z")
_RESLICE = "Re-slice the model for this Klipper printer."


class ArtifactValidationError(ValueError):
    """Safe diagnostic that can be shown on a failed queue item."""


class PreparedGCode(NamedTuple):
    file: BinaryIO
    size: int


def validate_raw_gcode(content: bytes) -> None:
    """Reject empty/binary/container responses rather than renaming them .gcode."""
    if (
        not content.strip()
        or content.startswith((b"PK\x03\x04", b"PK\x05\x06", b"\x1f\x8b", b"GCDE"))
        or b"\0" in content
    ):
        raise ArtifactValidationError(
            f"Expected raw text G-code, but received empty or packaged/binary data. {_RESLICE}"
        )


def _project_flavor(bundle: zipfile.ZipFile) -> str | None:
    matches = [info for info in bundle.infolist() if info.filename == "Metadata/project_settings.config"]
    if not matches:
        return None
    if len(matches) != 1 or matches[0].file_size > _MAX_METADATA_BYTES:
        raise ArtifactValidationError(f"3MF printer metadata is ambiguous or exceeds the size limit. {_RESLICE}")
    with bundle.open(matches[0]) as member:
        content = member.read(_MAX_METADATA_BYTES + 1)
    if len(content) > _MAX_METADATA_BYTES:
        raise ArtifactValidationError(f"3MF printer metadata exceeds the size limit. {_RESLICE}")
    try:
        settings = json.loads(content)
        if not isinstance(settings, dict):
            raise ValueError("Expected printer settings object")
        flavor = settings.get("gcode_flavor")
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        raise ArtifactValidationError(f"3MF printer metadata is invalid. {_RESLICE}") from exc
    if flavor is None:
        return None
    if not isinstance(flavor, str) or flavor.strip().lower() != "klipper":
        raise ArtifactValidationError(f"3MF printer settings are not compatible with Klipper. {_RESLICE}")
    return "klipper"


def _prepare(path: Path, plate_id: int | None) -> PreparedGCode:
    if path.suffix.lower() != ".3mf":
        source = path.open("rb")
        try:
            size = path.stat().st_size
            if size > MOONRAKER_MAX_UPLOAD_BYTES:
                raise ArtifactValidationError("G-code exceeds the Moonraker upload size limit.")
            validate_raw_gcode(source.read(_CHUNK_BYTES))
            source.seek(0)
            return PreparedGCode(source, size)
        except BaseException:
            source.close()
            raise

    # Ownership passes to the async context manager after extraction completes.
    output = tempfile.SpooledTemporaryFile(max_size=_MAX_METADATA_BYTES, mode="w+b")  # noqa: SIM115
    try:
        with zipfile.ZipFile(path) as bundle:
            flavor = _project_flavor(bundle)
            candidates = [
                info
                for info in bundle.infolist()
                if (match := _PLATE.fullmatch(info.filename)) and (plate_id is None or int(match[1]) == plate_id)
            ]
            if len(candidates) != 1:
                raise ArtifactValidationError(
                    f"3MF must contain exactly one G-code entry for the selected plate ({plate_id or 'unspecified'}). "
                    f"Choose one plate and re-slice if necessary."
                )
            info = candidates[0]
            if info.file_size <= 0 or info.file_size > MOONRAKER_MAX_UPLOAD_BYTES:
                raise ArtifactValidationError("3MF plate G-code is empty or exceeds the Moonraker upload size limit.")
            total = 0
            at_line_start = True
            with bundle.open(info) as member:
                while chunk := member.readline(_CHUNK_BYTES):
                    total += len(chunk)
                    if total > MOONRAKER_MAX_UPLOAD_BYTES:
                        raise ArtifactValidationError("3MF plate G-code exceeds the Moonraker upload size limit.")
                    # Blank lines are valid within a nonempty G-code stream.
                    if chunk.strip():
                        validate_raw_gcode(chunk)
                    if at_line_start and (match := _FLAVOR.fullmatch(chunk.strip())):
                        if match[1].lower() != b"klipper":
                            raise ArtifactValidationError(f"Embedded G-code is not compatible with Klipper. {_RESLICE}")
                        flavor = "klipper"
                    at_line_start = chunk.endswith(b"\n")
                    output.write(chunk)
            if flavor != "klipper":
                raise ArtifactValidationError(f"Cannot confirm this 3MF contains Klipper G-code. {_RESLICE}")
        output.seek(0)
        validate_raw_gcode(output.read(_CHUNK_BYTES))
        output.seek(0)
        return PreparedGCode(output, total)
    except BaseException as exc:
        output.close()
        if isinstance(exc, (zipfile.BadZipFile, OSError, RuntimeError, NotImplementedError)):
            raise ArtifactValidationError(f"Could not read the selected 3MF plate. {_RESLICE}") from exc
        raise


@asynccontextmanager
async def moonraker_gcode_source(path: Path, plate_id: int | None):
    """Bounded extraction off the event loop, with cleanup even on cancellation."""
    task = asyncio.create_task(asyncio.to_thread(_prepare, path, plate_id))
    try:
        prepared = await asyncio.shield(task)
    except asyncio.CancelledError:

        def close_when_ready(completed):
            if not completed.cancelled() and completed.exception() is None:
                completed.result().file.close()

        task.add_done_callback(close_when_ready)
        raise
    try:
        yield prepared
    finally:
        prepared.file.close()
