"""Durable authority for background slicer jobs."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class SliceJobRecord(Base):
    __tablename__ = "slice_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    source_kind: Mapped[str] = mapped_column(String(20))
    source_id: Mapped[int] = mapped_column(Integer)
    source_name: Mapped[str] = mapped_column(Text)
    request_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    request_fingerprint: Mapped[str | None] = mapped_column(String(64))
    schema_hash: Mapped[str | None] = mapped_column(String(64))

    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    progress: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    sidecar_request_id: Mapped[str | None] = mapped_column(String(128))

    result: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    result_artifact_kind: Mapped[str | None] = mapped_column(String(20))
    result_artifact_id: Mapped[int | None] = mapped_column(Integer)
    error_status: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_detail: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
