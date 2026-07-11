from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core import database


@pytest.fixture(autouse=True)
def force_sqlite(monkeypatch):
    monkeypatch.setattr(database, "is_sqlite", lambda: True)


async def test_sqlite_migration_preserves_legacy_rows_indexes_and_children():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.execute(
            text(
                """
                CREATE TABLE printers (
                    id INTEGER PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    serial_number VARCHAR(50) NOT NULL UNIQUE,
                    ip_address VARCHAR(253) NOT NULL,
                    access_code VARCHAR(20) NOT NULL
                )
                """
            )
        )
        await conn.execute(text("CREATE INDEX ix_printers_name ON printers(name)"))
        await conn.execute(text("CREATE TABLE printers_provider_new (stale INTEGER)"))
        await conn.execute(
            text(
                """
                CREATE TABLE print_archives (
                    id INTEGER PRIMARY KEY,
                    printer_id INTEGER REFERENCES printers(id)
                )
                """
            )
        )
        await conn.execute(
            text(
                "INSERT INTO printers (id, name, serial_number, ip_address, access_code) "
                "VALUES (7, 'Legacy', 'SERIAL', '192.0.2.1', '12345678')"
            )
        )
        await conn.execute(text("INSERT INTO print_archives (id, printer_id) VALUES (3, 7)"))

        await database._migrate_printer_provider_storage(conn)
        await database._migrate_printer_provider_storage(conn)

        row = (
            await conn.execute(
                text("SELECT id, serial_number, ip_address, access_code, provider FROM printers WHERE id = 7")
            )
        ).one()
        columns = {item[1]: item for item in await conn.execute(text("PRAGMA table_info(printers)"))}
        indexes = {item[1] for item in await conn.execute(text("PRAGMA index_list(printers)"))}

        assert tuple(row) == (7, "SERIAL", "192.0.2.1", "12345678", "bambu")
        assert columns["provider"][3] == 1
        assert columns["serial_number"][3] == 0
        assert columns["ip_address"][3] == 0
        assert columns["access_code"][3] == 0
        assert "ix_printers_name" in indexes
        assert (await conn.execute(text("SELECT printer_id FROM print_archives"))).scalar_one() == 7

        await conn.execute(text("INSERT INTO printers (id, name, provider) VALUES (8, 'Moonraker', 'moonraker')"))
        with pytest.raises(IntegrityError):
            await conn.execute(text("INSERT INTO printers (id, name, provider) VALUES (9, 'Bad', 'invalid')"))

    await engine.dispose()


async def test_postgres_migration_relaxes_bambu_columns_and_backfills_provider(monkeypatch):
    monkeypatch.setattr(database, "is_sqlite", lambda: False)
    conn = AsyncMock()

    await database._migrate_printer_provider_storage(conn)

    sql = "\n".join(str(call.args[0]) for call in conn.execute.await_args_list)
    assert "ADD COLUMN IF NOT EXISTS provider" in sql
    assert "UPDATE printers SET provider = 'bambu'" in sql
    assert "ALTER COLUMN serial_number DROP NOT NULL" in sql
    assert "ALTER COLUMN ip_address DROP NOT NULL" in sql
    assert "ALTER COLUMN access_code DROP NOT NULL" in sql


async def test_sqlite_migration_fails_before_cascading_rows_when_foreign_keys_are_enabled():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.connect() as conn:
        await conn.execute(text("PRAGMA foreign_keys = ON"))
        await conn.execute(
            text(
                "CREATE TABLE printers (id INTEGER PRIMARY KEY, serial_number TEXT NOT NULL, "
                "ip_address TEXT NOT NULL, access_code TEXT NOT NULL)"
            )
        )
        await conn.execute(text("CREATE TABLE child (printer_id INTEGER REFERENCES printers(id) ON DELETE CASCADE)"))
        await conn.execute(
            text(
                "INSERT INTO printers (id, serial_number, ip_address, access_code) "
                "VALUES (1, 'SERIAL', '192.0.2.1', '12345678')"
            )
        )
        await conn.execute(text("INSERT INTO child (printer_id) VALUES (1)"))

        with pytest.raises(RuntimeError, match="refusing to risk cascading"):
            await database._migrate_printer_provider_storage(conn)

        assert (await conn.execute(text("SELECT COUNT(*) FROM child"))).scalar_one() == 1

    await engine.dispose()
