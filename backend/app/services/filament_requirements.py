"""Parse per-slot filament requirements out of a 3MF file.

The scheduler used to own this logic (`PrintScheduler._get_filament_requirements`)
because it ran during dispatch decisions. Extracted here so the VP queue-mode
write path can use the same parser to populate `filament_overrides` /
`required_filament_types` at upload time (#1188 — Bambuddy was creating queue
items with no filament fields, which made the scheduler fall through to
model-only matching and dispatch onto whatever printer happened to be free
regardless of loaded colour).

The shape returned here matches the `filament_overrides` JSON shape the
scheduler validates against, minus the `force_color_match` flag — callers
add that themselves based on their own setting.
"""

from __future__ import annotations

import logging
import zipfile
from pathlib import Path

from backend.app.utils.threemf_tools import ThreeMFDocument, extract_nozzle_mapping_from_3mf

logger = logging.getLogger(__name__)


def extract_filament_requirements(file_path: Path, plate_id: int | None = None) -> list[dict]:
    """Parse `[{slot_id, type, color, tray_info_idx, used_grams, nozzle_id?}]` from a 3MF.

    Args:
        file_path: Path to the 3MF.
        plate_id: When set, only return filaments used on that plate. When
            None, return every filament with `used_g > 0` across the file.

    Returns:
        Sorted list (by `slot_id`) of filament dicts. Empty list when the
        3MF is unreadable, missing `Metadata/slice_info.config`, or has no
        filaments matching the plate filter — callers treat that as "no
        requirements" rather than an error so a malformed 3MF doesn't break
        the upload path.
    """
    if not file_path.exists():
        return []

    filaments: list[dict] = []
    try:
        with zipfile.ZipFile(file_path, "r") as zf:
            for filament in ThreeMFDocument(zf).consumed_filaments(plate_id):
                try:
                    slot_id = int(filament["slot_id"])
                except (KeyError, TypeError, ValueError):
                    continue
                filaments.append(
                    {
                        "slot_id": slot_id,
                        "type": filament["type"],
                        "color": filament["color"],
                        "tray_info_idx": filament["tray_info_idx"],
                        "used_grams": filament["used_grams"],
                    }
                )

            if plate_id is None:
                # Same slot can occur on multiple plates. Keep the highest
                # consumption; ties retain the first plate's entry.
                seen: dict[int, dict] = {}
                for filament in filaments:
                    slot_id = filament["slot_id"]
                    if slot_id not in seen or filament["used_grams"] > seen[slot_id]["used_grams"]:
                        seen[slot_id] = filament
                filaments = list(seen.values())

            filaments.sort(key=lambda x: x["slot_id"])
            for filament in filaments:
                filament["used_grams"] = round(filament["used_grams"], 1)

            # Dual-nozzle printers (H2D / X2D) — annotate which extruder each
            # slot is fed into. Empty mapping for single-nozzle printers, in
            # which case we just don't add the key.
            nozzle_mapping = extract_nozzle_mapping_from_3mf(zf)
            if nozzle_mapping:
                for filament in filaments:
                    filament["nozzle_id"] = nozzle_mapping.get(filament["slot_id"])
    except Exception as e:
        logger.warning("Failed to parse filament requirements from %s: %s", file_path, e)
        return []

    return filaments
