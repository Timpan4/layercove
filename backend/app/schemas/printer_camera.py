from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

CameraType = Literal["mjpeg", "rtsp", "snapshot", "unsupported"]


class PrinterCameraResponse(BaseModel):
    id: int
    printer_id: int
    source: Literal["moonraker", "manual"]
    source_uid: str
    name: str
    location: str | None
    service: str | None
    camera_type: CameraType
    source_enabled: bool
    enabled: bool
    is_primary: bool
    rotation: int
    sort_order: int
    available: bool
    supported_live: bool
    snapshot_available: bool
    history: bool
    first_seen_at: datetime
    last_seen_at: datetime
    missing_since: datetime | None


class PrinterCameraUpdate(BaseModel):
    enabled: bool | None = None
    is_primary: bool | None = None
    rotation: Literal[0, 90, 180, 270] | None = None
    name: str | None = Field(default=None, min_length=1, max_length=100)
    stream_url: str | None = Field(default=None, max_length=1000)
    snapshot_url: str | None = Field(default=None, max_length=1000)
    camera_type: CameraType | None = None

    @model_validator(mode="after")
    def manual_fields_are_complete(self):
        if self.camera_type == "unsupported":
            raise ValueError("Manual cameras cannot use unsupported type")
        return self
