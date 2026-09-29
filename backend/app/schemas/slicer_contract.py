"""Versioned contract exposed by the pinned Orca sidecar."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

ORCA_CONTRACT_VERSION = "1"
ORCA_VERSION = "2.4.2"
ORCA_COMMIT = "8500fcdccaa10b5099ac20d252af3a7c560046f1"

_SCHEMA_MAX_ENTRIES = 4096
_SCHEMA_MAX_DEPTH = 16
_SCHEMA_MAX_STRING_LENGTH = 16 * 1024


def _validate_schema_value(value: Any, *, depth: int = 0) -> None:
    if depth > _SCHEMA_MAX_DEPTH:
        raise ValueError("slicer schema nesting is too deep")
    if isinstance(value, str):
        if len(value) > _SCHEMA_MAX_STRING_LENGTH:
            raise ValueError("slicer schema string is too long")
        return
    if isinstance(value, list):
        if len(value) > _SCHEMA_MAX_ENTRIES:
            raise ValueError("slicer schema list has too many entries")
        for item in value:
            _validate_schema_value(item, depth=depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > _SCHEMA_MAX_ENTRIES:
            raise ValueError("slicer schema mapping has too many entries")
        for key, item in value.items():
            _validate_schema_value(key, depth=depth + 1)
            _validate_schema_value(item, depth=depth + 1)


class SlicerEngineIdentity(BaseModel):
    name: Literal["OrcaSlicer"]
    version: str
    commit: str


class SlicerImageIdentity(BaseModel):
    digest: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")


class SlicerCapabilities(BaseModel):
    process_schema: bool
    model_state: bool
    progress: bool
    cancel: bool


class SlicerCapabilitiesResponse(BaseModel):
    contract_version: str
    engine: SlicerEngineIdentity
    image_identity: SlicerImageIdentity
    schema_hash: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    capabilities: SlicerCapabilities
    supported_scopes: list[Literal["global", "object"]] = Field(max_length=2)


class SlicerSchemaGroup(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    options: list[str] = Field(max_length=_SCHEMA_MAX_ENTRIES)


class SlicerSchemaPage(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    groups: list[SlicerSchemaGroup] = Field(max_length=256)


class SlicerProcessSchemaResponse(SlicerCapabilitiesResponse):
    pages: list[SlicerSchemaPage] = Field(max_length=128)
    options: list[dict[str, Any]] = Field(max_length=_SCHEMA_MAX_ENTRIES)
    scopes: dict[str, str | list[str]] = Field(max_length=_SCHEMA_MAX_ENTRIES)
    samples: dict[str, Any] = Field(max_length=_SCHEMA_MAX_ENTRIES)

    @model_validator(mode="after")
    def validate_dynamic_schema_bounds(self) -> "SlicerProcessSchemaResponse":
        _validate_schema_value([page.model_dump(mode="json") for page in self.pages])
        _validate_schema_value(self.options)
        _validate_schema_value(self.scopes)
        _validate_schema_value(self.samples)
        return self


class ResolvedSlicerProfileResponse(BaseModel):
    preset_type: Literal["printer", "process", "filament"]
    source: Literal["orca_cloud", "cloud", "local", "standard"]
    id: str
    values: dict[str, Any]


class SliceJobProvenanceResponse(BaseModel):
    state: Literal["provenance_unknown", "resolved"]
    printer_revision_id: int | None = None
    process_revision_id: int | None = None
    filament_revision_ids: list[int] | None = None
    selection_evidence: dict[str, Any] | None = None
    created_at: datetime


class SliceJobStateResponse(BaseModel):
    job_id: int
    status: Literal["pending", "running", "completed", "failed", "cancel-requested", "cancelled"]
    kind: Literal["library_file", "archive"]
    source_id: int
    source_name: str
    schema_hash: str | None = None
    request_fingerprint: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    progress: dict[str, Any] | None = None
    provenance: SliceJobProvenanceResponse | None = None
    result: dict[str, Any] | None = None
    error_status: int | None = None
    error_code: str | None = None
    error_detail: str | None = None
