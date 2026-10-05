import pytest

from backend.app.models.virtual_printer import VirtualPrinter
from backend.app.services.log_reader import collect_sensitive_strings


@pytest.mark.asyncio
@pytest.mark.integration
async def test_virtual_printer_names_are_redacted(db_session):
    db_session.add(VirtualPrinter(name="Alice's Bedroom Farm", mode="queue", enabled=True))
    await db_session.commit()

    sensitive = await collect_sensitive_strings(db_session)

    assert "Alice's Bedroom Farm" in sensitive
