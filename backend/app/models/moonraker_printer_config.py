from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Integer, String, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.app.core.database import Base
from backend.app.core.encryption import decrypt_application_secret, encrypt_application_secret


class MoonrakerPrinterConfig(Base):
    __tablename__ = "moonraker_printer_configs"
    __table_args__ = (
        CheckConstraint(
            "api_key_ciphertext IS NULL OR authorization_ciphertext IS NULL",
            name="ck_moonraker_single_auth_method",
        ),
        CheckConstraint(
            "spoolman_accounting_owner IN ('layercove', 'moonraker')",
            name="ck_moonraker_spoolman_accounting_owner",
        ),
    )

    printer_id: Mapped[int] = mapped_column(ForeignKey("printers.id", ondelete="CASCADE"), primary_key=True)
    base_url: Mapped[str] = mapped_column(String(500))
    websocket_url_override: Mapped[str | None] = mapped_column(String(500), nullable=True)
    api_key_ciphertext: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    authorization_ciphertext: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    tls_verify: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    spoolman_accounting_owner: Mapped[str] = mapped_column(
        String(20), default="moonraker", server_default="moonraker"
    )
    spoolman_spool_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    printer: Mapped["Printer"] = relationship(back_populates="moonraker_config")

    @property
    def api_key(self) -> str | None:
        if self.api_key_ciphertext is None:
            return None
        return decrypt_application_secret(self.api_key_ciphertext)

    @api_key.setter
    def api_key(self, value: str | None) -> None:
        self.api_key_ciphertext = encrypt_application_secret(value) if value else None

    @property
    def authorization(self) -> str | None:
        if self.authorization_ciphertext is None:
            return None
        return decrypt_application_secret(self.authorization_ciphertext)

    @authorization.setter
    def authorization(self, value: str | None) -> None:
        self.authorization_ciphertext = encrypt_application_secret(value) if value else None

    @property
    def api_key_configured(self) -> bool:
        return self.api_key_ciphertext is not None

    @property
    def authorization_configured(self) -> bool:
        return self.authorization_ciphertext is not None


from backend.app.models.printer import Printer  # noqa: E402
