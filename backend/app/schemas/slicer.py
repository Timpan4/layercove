"""Pydantic schemas for slice requests."""

import json
import math
import re
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class PresetRef(BaseModel):
    """A source-aware reference to a printer / process / filament preset.

    The SliceModal pulls dropdown options from four tiers (orca_cloud /
    cloud / local / standard). At submit time the client sends one of these
    per slot so the backend knows where to fetch the preset content from at
    slice time. ``cloud`` is Bambu Cloud (kept as the bare name for backward
    compatibility with existing requests); ``orca_cloud`` is Orca Cloud.
    """

    source: Literal["orca_cloud", "cloud", "local", "standard"]
    id: str = Field(
        ...,
        description=(
            "Orca Cloud profile id, Bambu Cloud setting_id, local DB row id (stringified), or standard preset name."
        ),
    )


class DestinationArtifactKind(str, Enum):
    """Explicit slicer output contract; never inferred from profile names."""

    BAMBU_3MF = "bambu_3mf"
    KLIPPER_GCODE = "klipper_gcode"


SettingValue = str | int | float | bool | None | list[str | int | float | bool]
_SETTING_KEY = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")


def _validate_overrides(overrides: dict[str, SettingValue], *, field_name: str, max_bytes: int) -> None:
    invalid_key = next((key for key in overrides if not _SETTING_KEY.fullmatch(key)), None)
    if invalid_key is not None:
        raise ValueError(f"{field_name} contains invalid setting key: {invalid_key!r}")
    for value in overrides.values():
        values = value if isinstance(value, list) else [value]
        if any(isinstance(item, float) and not math.isfinite(item) for item in values):
            raise ValueError(f"{field_name} values must be finite")
    if len(json.dumps(overrides, separators=(",", ":")).encode()) > max_bytes:
        raise ValueError(f"{field_name} exceeds {max_bytes} bytes")


class ModelTransform(BaseModel):
    position: tuple[float, float, float] = (0.0, 0.0, 0.0)
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0)
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)

    @model_validator(mode="after")
    def validate_transform(self) -> "ModelTransform":
        values = (*self.position, *self.rotation, *self.scale)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("transform values must be finite")
        if any(value <= 0 for value in self.scale):
            raise ValueError("scale values must be greater than zero")
        return self


class ModelObjectState(BaseModel):
    id: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")
    transform: ModelTransform | None = None
    overrides: dict[str, SettingValue] = Field(default_factory=dict, max_length=128)

    @model_validator(mode="after")
    def validate_object_overrides(self) -> "ModelObjectState":
        _validate_overrides(self.overrides, field_name="object overrides", max_bytes=32 * 1024)
        return self


class ModelState(BaseModel):
    objects: list[ModelObjectState] = Field(default_factory=list, max_length=256)
    hidden_object_ids: list[str] = Field(default_factory=list, max_length=256)
    lay_flat_object_ids: list[str] = Field(default_factory=list, max_length=256)
    arrange: bool = False

    @model_validator(mode="after")
    def validate_object_ids(self) -> "ModelState":
        object_ids = [obj.id for obj in self.objects]
        if len(object_ids) != len(set(object_ids)):
            raise ValueError("model_state object IDs must be unique")
        known_ids = set(object_ids)
        for field_name, ids in (
            ("hidden_object_ids", self.hidden_object_ids),
            ("lay_flat_object_ids", self.lay_flat_object_ids),
        ):
            if len(ids) != len(set(ids)):
                raise ValueError(f"{field_name} must contain unique IDs")
            if unknown := set(ids) - known_ids:
                raise ValueError(f"{field_name} contains unknown object ID: {sorted(unknown)[0]!r}")
        if len(json.dumps(self.model_dump(mode="json"), separators=(",", ":")).encode()) > 256 * 1024:
            raise ValueError("model_state exceeds 262144 bytes")
        return self


class SliceRequest(BaseModel):
    """Body for `POST /library/files/{file_id}/slice`.

    Two preset shapes are accepted per slot for backwards-compatibility:

    - **Legacy** — bare integer ``*_preset_id`` fields point into the
      ``local_presets`` table. Existing clients (and stale browser tabs after
      a Bambuddy upgrade) keep working unchanged.
    - **Source-aware** — ``*_preset`` carries an explicit
      ``{source, id}``. Required for cloud / standard tiers; also accepted
      (and equivalent) for local presets when the client is on the new modal.

    Exactly one of each pair must be set; the validator normalises legacy
    integer ids into a ``PresetRef(source='local', id=str(id))`` so the
    downstream resolver only deals with one shape.
    """

    # Legacy fields — kept optional so older clients continue to work.
    printer_preset_id: int | None = Field(
        default=None,
        description="DEPRECATED: prefer printer_preset. LocalPreset id with preset_type='printer'.",
    )
    process_preset_id: int | None = Field(
        default=None,
        description="DEPRECATED: prefer process_preset. LocalPreset id with preset_type='process'.",
    )
    filament_preset_id: int | None = Field(
        default=None,
        description="DEPRECATED: prefer filament_preset. LocalPreset id with preset_type='filament'.",
    )

    # Source-aware fields — set by the new SliceModal.
    printer_preset: PresetRef | None = None
    process_preset: PresetRef | None = None
    filament_preset: PresetRef | None = None

    # Multi-color: one PresetRef per AMS slot the source plate uses. Order is
    # significant — the slicer matches index-by-index against the plate's
    # filament slots. Always preferred over the legacy singular field; the
    # validator promotes a singular field into ``[singular]`` when the list
    # is empty so older clients keep working.
    filament_presets: list[PresetRef] = Field(default_factory=list)

    plate: int | None = Field(
        default=None,
        ge=0,
        description=(
            "Plate number to slice. ``None`` defaults to plate 1 on the sidecar "
            "(matches the pre-multi-plate behaviour). ``0`` is the sidecar's "
            "'all plates' sentinel — produces a single multi-plate 3MF whose "
            "``Metadata/plate_N.gcode`` entries cover every plate in the "
            "source. ``>= 1`` slices that one plate."
        ),
    )
    export_3mf: bool = Field(
        default=False,
        description="Legacy sidecar option; new clients use destination_artifact_kind.",
    )
    destination_artifact_kind: DestinationArtifactKind = Field(
        default=DestinationArtifactKind.BAMBU_3MF,
        description="Explicit destination artifact; defaults to legacy Bambu 3MF output.",
    )
    bed_type: str | None = Field(
        default=None,
        max_length=64,
        description=(
            "Override the process preset's curr_bed_type for this slice. Canonical "
            "BambuStudio / OrcaSlicer values: 'Cool Plate', 'Engineering Plate', "
            "'High Temp Plate', 'Textured PEI Plate', 'Smooth PEI Plate', "
            "'Cool Plate (SuperTack)', 'Supertack Plate'. None ⇒ inherit from the "
            "process preset unchanged (#1337)."
        ),
    )
    schema_hash: str | None = Field(
        default=None,
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-f]{64}$",
        description="Authoritative process schema hash used to validate workbench overrides.",
    )
    process_overrides: dict[str, SettingValue] = Field(default_factory=dict, max_length=256)
    model_state: ModelState | None = None
    catalog_printer_id: int | None = Field(default=None, gt=0)
    catalog_binding_id: int | None = Field(default=None, gt=0)
    catalog_process_profile_id: int | None = Field(default=None, gt=0)
    catalog_filament_profile_ids: list[int] = Field(default_factory=list, max_length=64)
    catalog_acknowledgement: dict[str, Any] | None = None
    catalog_selection_evidence: dict[str, Any] = Field(default_factory=dict)
    catalog_history_job_id: int | None = Field(default=None, gt=0)
    catalog_history_mode: Literal["exact", "upgrade"] | None = None
    catalog_tombstone_acknowledgement: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_catalog_history(self) -> "SliceRequest":
        if (self.catalog_history_job_id is None) != (self.catalog_history_mode is None):
            raise ValueError("catalog_history_job_id and catalog_history_mode are required together")
        if self.catalog_tombstone_acknowledgement is not None and self.catalog_history_mode != "exact":
            raise ValueError("catalog_tombstone_acknowledgement is valid only for exact historical re-slicing")
        return self

    @model_validator(mode="after")
    def validate_catalog_selection(self) -> "SliceRequest":
        supplied = (
            self.catalog_printer_id is not None
            or self.catalog_binding_id is not None
            or self.catalog_process_profile_id is not None
            or bool(self.catalog_filament_profile_ids)
        )
        if supplied and (
            self.catalog_printer_id is None
            or self.catalog_binding_id is None
            or self.catalog_process_profile_id is None
        ):
            raise ValueError(
                "catalog_printer_id, catalog_binding_id, catalog_process_profile_id, "
                "and catalog_filament_profile_ids are required together"
            )
        if len(json.dumps(self.catalog_selection_evidence, separators=(",", ":")).encode()) > 64 * 1024:
            raise ValueError("catalog_selection_evidence exceeds 65536 bytes")
        return self

    @model_validator(mode="after")
    def validate_workbench_state(self) -> "SliceRequest":
        _validate_overrides(self.process_overrides, field_name="process_overrides", max_bytes=64 * 1024)
        if (self.process_overrides or self.model_state is not None) and self.schema_hash is None:
            raise ValueError("schema_hash is required when process_overrides or model_state is provided")
        return self

    @model_validator(mode="after")
    def normalise_preset_refs(self) -> "SliceRequest":
        """Each slot must end up with a `PresetRef` set. Legacy integer ids
        become `(source='local', id=str(int))` so the route handler only
        deals with the canonical shape. For filament: a non-empty
        ``filament_presets`` list satisfies the requirement on its own; an
        empty list falls back to the singular fields, which then promote
        into a one-element list.
        """
        for slot, ref_attr, legacy_attr in (
            ("printer", "printer_preset", "printer_preset_id"),
            ("process", "process_preset", "process_preset_id"),
        ):
            ref = getattr(self, ref_attr)
            legacy_id = getattr(self, legacy_attr)
            if ref is None and legacy_id is None:
                raise ValueError(
                    f"{slot} preset is required: provide '{ref_attr}' (preferred) or legacy '{legacy_attr}'"
                )
            if ref is None:
                setattr(self, ref_attr, PresetRef(source="local", id=str(legacy_id)))

        # Filament accepts THREE shapes, in priority order:
        #   1. filament_presets    — multi-color array (new clients)
        #   2. filament_preset     — source-aware singular (single-color new clients)
        #   3. filament_preset_id  — legacy bare integer (old clients)
        # The first non-empty shape wins; missing all three raises.
        if not self.filament_presets:
            if self.filament_preset is not None:
                self.filament_presets = [self.filament_preset]
            elif self.filament_preset_id is not None:
                fallback = PresetRef(source="local", id=str(self.filament_preset_id))
                self.filament_preset = fallback
                self.filament_presets = [fallback]
            else:
                raise ValueError(
                    "filament preset is required: provide 'filament_presets' (preferred), "
                    "'filament_preset', or legacy 'filament_preset_id'"
                )
        elif self.filament_preset is None:
            # Multi-color caller: backfill the singular from the first slot
            # so callers that still read the legacy field see a stable value.
            self.filament_preset = self.filament_presets[0]
        if (
            self.catalog_printer_id is not None
            or self.catalog_binding_id is not None
            or self.catalog_process_profile_id is not None
            or self.catalog_filament_profile_ids
        ) and len(self.catalog_filament_profile_ids) != len(self.filament_presets):
            raise ValueError("catalog_filament_profile_ids must match filament_presets")
        return self


class HistoricalReslicePrepareRequest(BaseModel):
    mode: Literal["exact", "upgrade"]
    catalog_acknowledgement: dict[str, Any] | None = None
    catalog_tombstone_acknowledgement: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_tombstone_acknowledgement(self) -> "HistoricalReslicePrepareRequest":
        if self.catalog_tombstone_acknowledgement is not None and self.mode != "exact":
            raise ValueError("catalog_tombstone_acknowledgement is valid only for exact historical re-slicing")
        return self


class HistoricalRevisionIds(BaseModel):
    printer: int
    process: int
    filaments: list[int]


class HistoricalReslicePrepareResponse(BaseModel):
    source_kind: Literal["library_file", "archive"]
    source_id: int
    request: SliceRequest
    tombstoned: bool
    revision_ids: HistoricalRevisionIds


class PlateFilament(BaseModel):
    """Filament consumed by one source 3MF plate."""

    slot_id: int
    type: str
    color: str
    used_grams: float
    used_meters: float
    used_in_plate: bool | None = None


class PlateMetadata(BaseModel):
    """Metadata returned for a selectable source 3MF plate."""

    index: int
    name: str | None
    objects: list[str]
    object_ids: list[str] = Field(default_factory=list)
    object_count: int
    has_thumbnail: bool
    thumbnail_url: str | None
    print_time_seconds: int | None
    filament_used_grams: float | None
    filaments: list[PlateFilament]
    bed_type: str | None = None


class LibraryFilePlatesResponse(BaseModel):
    file_id: int
    filename: str
    plates: list[PlateMetadata]
    is_multi_plate: bool
    embedded_printer: str | None = None
    embedded_process: str | None = None


class ArchivePlatesResponse(BaseModel):
    archive_id: int
    filename: str
    plates: list[PlateMetadata]
    is_multi_plate: bool
    has_gcode: bool | None = None
    embedded_printer: str | None = None
    embedded_process: str | None = None


class SliceResponse(BaseModel):
    """Response from `POST /library/files/{file_id}/slice`. The result lands
    in the user's library as a new ``LibraryFile`` (in the same folder as
    the source)."""

    library_file_id: int
    name: str
    print_time_seconds: int
    filament_used_g: float
    filament_used_mm: float
    used_embedded_settings: bool = False


class SliceArchiveResponse(BaseModel):
    """Response from `POST /archives/{archive_id}/slice`. The result lands
    in the user's archives as a new ``PrintArchive`` row, inheriting
    printer / project metadata from the source archive."""

    archive_id: int
    name: str
    print_time_seconds: int
    filament_used_g: float
    filament_used_mm: float
    used_embedded_settings: bool = False
