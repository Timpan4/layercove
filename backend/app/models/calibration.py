"""Durable calibration context and manually chosen results."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.orm import Mapped, mapped_column

from backend.app.core.database import Base


class CalibrationSession(Base):
    __tablename__ = "calibration_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Deleting an owner must not turn their private session into an unowned one.
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    filament_profile_id: Mapped[int] = mapped_column(ForeignKey("slicer_profiles.id", ondelete="RESTRICT"))
    filament_revision_id: Mapped[int] = mapped_column(ForeignKey("slicer_profile_revisions.id", ondelete="RESTRICT"))
    nozzle_diameter: Mapped[float] = mapped_column(Numeric(4, 2))
    tool_index: Mapped[int] = mapped_column(default=0)
    parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    setting_limits: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    results: Mapped[dict[str, float]] = mapped_column(JSON, default=dict)
    runs: Mapped[dict[str, int]] = mapped_column(JSON, default=dict)
    prints: Mapped[dict[str, int]] = mapped_column(JSON, default=dict)
    saved_profile_id: Mapped[int | None] = mapped_column(ForeignKey("slicer_profiles.id", ondelete="RESTRICT"))
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __mapper_args__ = {"version_id_col": version, "eager_defaults": True}


class CalibrationEvidence(Base):
    __tablename__ = "calibration_evidence"
    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("calibration_sessions.id", ondelete="CASCADE"), index=True)
    step: Mapped[str] = mapped_column(String(32))
    source: Mapped[str] = mapped_column(String(16))
    filename: Mapped[str] = mapped_column(String(40))
    run_id: Mapped[int | None] = mapped_column(ForeignKey("slice_jobs.id", ondelete="SET NULL"))
    print_id: Mapped[int | None] = mapped_column(ForeignKey("print_queue.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
