"""Upgrade coverage for named 4via6 Network Sites."""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import _migrate_network_sites


@pytest.mark.asyncio
async def test_legacy_printers_gain_network_site_fields_idempotently(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'legacy.db'}")
    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE TABLE network_sites (id INTEGER PRIMARY KEY)"))
            await conn.execute(text("CREATE TABLE printers (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL)"))
            await _migrate_network_sites(conn)
            await _migrate_network_sites(conn)

            columns = {row[1] for row in await conn.execute(text("PRAGMA table_info(printers)"))}
            indexes = {row[1] for row in await conn.execute(text("PRAGMA index_list(printers)"))}

        assert {"network_site_id", "network_site_lan_ip"} <= columns
        assert "ix_printers_network_site_id" in indexes
    finally:
        await engine.dispose()
