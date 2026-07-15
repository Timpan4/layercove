from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base

if TYPE_CHECKING:
    from backend.app.models.printer import Printer


class NetworkSite(Base):
    __tablename__ = "network_sites"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    site_number: Mapped[int] = mapped_column(Integer, unique=True)
    ipv4_cidr: Mapped[str] = mapped_column(String(18))
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (
        CheckConstraint("site_number BETWEEN 1 AND 65535", name="ck_network_sites_site_number"),
        Index("uq_network_sites_name_lower", func.lower(name), unique=True),
    )

    printers: Mapped[list["Printer"]] = relationship(back_populates="network_site")
