"""Check actual print requirements before queue submission and provider I/O."""

import asyncio
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.printer import Printer
from backend.app.services.filament_requirements import extract_filament_requirements
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_types import PrinterProvider, capabilities_for_provider


@dataclass
class PrintMaterialCheck:
    external_spool: bool
    filaments: list[dict]
    blocking: list[str]
    advisories: list[str]
    confirmation_key: str | None
    supports_ams: bool = False
    material_unknown: bool = False


def source_path(source: PrintArchive | LibraryFile, base_dir: Path) -> Path:
    path = Path(source.file_path)
    return path if path.is_absolute() else base_dir / path


def _file_hash(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


async def check_print_material(
    printer: Printer,
    source: PrintArchive | LibraryFile,
    file_path: Path,
    plate_id: int | None,
    ams_mapping: list[int] | None,
    use_ams: bool = True,
    nozzle_mapping: list[int] | None = None,
) -> PrintMaterialCheck:
    # Keep the scheduler's established material equivalence rules.
    from backend.app.services.print_scheduler import _canonical_filament_type

    backend = printer_manager.get_backend(printer.id)
    capabilities = backend.capabilities if backend else capabilities_for_provider(PrinterProvider(printer.provider))
    snapshot = printer_manager.get_snapshot(printer.id)
    status = printer_manager.get_status(printer.id) if capabilities.ams else None
    raw = getattr(status, "raw_data", {}) or {}
    telemetry_available = bool(snapshot and snapshot.connected and not snapshot.telemetry_stale)
    ams_units = raw.get("ams") or []
    external = not capabilities.ams or not use_ams or not ams_units
    blocking: list[str] = []
    advisories: list[str] = []
    if not file_path.is_file():
        return PrintMaterialCheck(external, [], ["Source file is unavailable."], [], None)

    filaments = (
        await asyncio.to_thread(extract_filament_requirements, file_path, plate_id)
        if file_path.name.lower().endswith(".3mf")
        else []
    )
    metadata = source.extra_data if isinstance(source, PrintArchive) else source.file_metadata
    metadata = metadata or {}
    nozzle = source.nozzle_diameter if isinstance(source, PrintArchive) else metadata.get("nozzle_diameter")
    # Aggregate archive metadata is useful for single-material raw G-code;
    # absent metadata remains unknown rather than an invented requirement.
    if not filaments and isinstance(source, PrintArchive) and source.filament_type:
        types = [value.strip() for value in source.filament_type.split(",") if value.strip()]
        if len(types) == 1:
            filaments = [{"slot_id": 1, "type": types[0]}]
    material_unknown = not filaments or any(not filament.get("type") for filament in filaments)
    if material_unknown:
        advisories.append("The file's required material is unknown. Check the file and loaded filament.")

    loaded: dict[int, str] = {}
    if telemetry_available and capabilities.ams:
        for unit in ams_units:
            ams_id = int(unit.get("id", 0))
            for tray in unit.get("tray") or []:
                tray_id = ams_id if ams_id >= 128 else ams_id * 4 + int(tray.get("id", 0))
                loaded[tray_id] = tray.get("tray_type") or ""
        for tray in raw.get("vt_tray") or []:
            loaded[int(tray.get("id", 254))] = tray.get("tray_type") or ""

    for filament in filaments:
        required = filament.get("type") or ""
        index = int(filament["slot_id"]) - 1
        selected = ams_mapping[index] if ams_mapping is not None and index < len(ams_mapping) else None
        if external and selected == -1:
            # The existing mapper uses -1 when external-spool telemetry cannot
            # suggest a slot. Validate the actual external tray when reported.
            selected = None
        is_external_slot = external or (selected is not None and selected >= 254)
        if not capabilities.ams:
            selected_type = None
        elif not use_ams and selected is not None and selected < 254:
            blocking.append("AMS slots cannot be selected when AMS use is disabled. Select the external spool.")
            continue
        elif selected is not None:
            if selected < 0 or (selected < 254 and selected not in loaded and telemetry_available):
                blocking.append(f"Choose a loaded filament slot for filament {index + 1}.")
                continue
            selected_type = loaded.get(selected)
        elif is_external_slot:
            candidates = [value for key, value in loaded.items() if key >= 254 and value]
            selected_type = candidates[0] if len(candidates) == 1 else None
        else:
            # Unmapped model-based jobs keep the scheduler's matching choice.
            matches = [
                value
                for key, value in loaded.items()
                if key < 254 and value and _canonical_filament_type(value) == _canonical_filament_type(required)
            ]
            if required and telemetry_available and not matches:
                blocking.append(f"No loaded AMS slot matches required {required}.")
            selected_type = matches[0] if matches else None
        if not selected_type:
            material_unknown = True
            advisories.append("Loaded material is not reported. Check the loaded filament before printing.")
        elif required and _canonical_filament_type(selected_type) != _canonical_filament_type(required):
            blocking.append(f"Filament {index + 1} requires {required}, but the selected slot reports {selected_type}.")

    if nozzle is not None:
        try:
            required_nozzle = float(nozzle)
        except (TypeError, ValueError):
            required_nozzle = None
        if required_nozzle is not None and (not math.isfinite(required_nozzle) or required_nozzle <= 0):
            required_nozzle = None
        tools = {int(f.get("nozzle_id") or 0) for f in filaments} or {0}
        if nozzle_mapping:
            # Rack position identifiers are not tool indices. Firmware owns
            # rack assignment; inspect the reported rack diameters below.
            rack = {int(slot.get("id", -1)): slot for slot in (raw.get("nozzle_rack") or []) if telemetry_available}
            indices = {int(f["slot_id"]) - 1 for f in filaments}
            positions = (
                [nozzle_mapping[index] if 0 <= index < len(nozzle_mapping) else None for index in indices]
                if indices
                else [position for position in nozzle_mapping if position >= 0]
            )
            diameters = [rack.get(position, {}).get("diameter") for position in positions or [None]]
        else:
            diameters = [
                next((n.diameter for n in snapshot.nozzles if n.tool_index == tool and n.status == "confirmed"), None)
                if telemetry_available
                else None
                for tool in tools
            ]
        for diameter in diameters:
            try:
                installed = float(diameter) if diameter is not None else None
            except (TypeError, ValueError):
                installed = None
            if installed is not None and (not math.isfinite(installed) or installed <= 0):
                installed = None
            if required_nozzle is None or installed is None:
                advisories.append("Nozzle size is not verified. Check the file and installed nozzle.")
            elif installed != required_nozzle:
                blocking.append(
                    f"The file requires a {required_nozzle:g} mm nozzle; the printer reports {installed:g} mm."
                )
    else:
        advisories.append("The file's nozzle size is unknown. Check the file and installed nozzle.")

    advisories = list(dict.fromkeys(advisories))
    try:
        file_hash = await asyncio.to_thread(_file_hash, file_path)
    except OSError:
        return PrintMaterialCheck(external, filaments, ["Source file is unavailable."], [], None, capabilities.ams)
    fingerprint = {
        "file": file_hash,
        "printer": printer.id,
        "provider": printer.provider,
        "supports_ams": capabilities.ams,
        "plate": plate_id,
        "ams_mapping": ams_mapping,
        "use_ams": use_ams,
        "nozzle_mapping": nozzle_mapping,
        "filaments": filaments,
        "nozzle": nozzle,
        "advisories": advisories,
    }
    key = (
        hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest()
        if advisories and not blocking
        else None
    )
    external = external or bool(ams_mapping and any(tray >= 254 for tray in ams_mapping))
    return PrintMaterialCheck(external, filaments, blocking, advisories, key, capabilities.ams, material_unknown)
