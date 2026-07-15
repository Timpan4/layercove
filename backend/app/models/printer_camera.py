from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base


class PrinterCamera(Base):
    __tablename__ = "printer_cameras"
    __table_args__ = (
        UniqueConstraint("printer_id", "source", "source_uid", name="uq_printer_camera_source_uid"),
        CheckConstraint("source IN ('moonraker', 'manual')", name="ck_printer_camera_source"),
        CheckConstraint(
            "camera_type IN ('mjpeg', 'rtsp', 'snapshot', 'unsupported')", name="ck_printer_camera_type"
        ),
        CheckConstraint("rotation IN (0, 90, 180, 270)", name="ck_printer_camera_rotation"),
        Index(
            "uq_printer_camera_primary",
            "printer_id",
            unique=True,
            sqlite_where=text("is_primary = 1"),
            postgresql_where=text("is_primary"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(20))
    source_uid: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(100))
    location: Mapped[str | None] = mapped_column(String(100), nullable=True)
    service: Mapped[str | None] = mapped_column(String(50), nullable=True)
    stream_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    snapshot_url: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    camera_type: Mapped[str] = mapped_column(String(20), default="unsupported")
    source_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    rotation: Mapped[int] = mapped_column(Integer, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    missing_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    printer: Mapped["Printer"] = relationship(back_populates="cameras")


from backend.app.models.printer import Printer  # noqa: E402
