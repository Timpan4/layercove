import sqlite3

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


@pytest.mark.asyncio
@pytest.mark.unit
async def test_fresh_init_creates_models_artifacts_and_is_idempotent(tmp_path):
    from backend.app.core import database

    original_engine = database.engine
    original_session = database.async_session
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'layercove.db'}")
    database.engine = engine
    database.async_session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        await database.init_db()
        await database.init_db()
        async with engine.connect() as conn:
            tables = set((await conn.execute(text("SELECT name FROM sqlite_master WHERE type = 'table'"))).scalars())
            triggers = set(
                (await conn.execute(text("SELECT name FROM sqlite_master WHERE type = 'trigger'"))).scalars()
            )
            indexes = set((await conn.execute(text("SELECT name FROM sqlite_master WHERE type = 'index'"))).scalars())
        modeled_indexes = {
            index.name for table in database.Base.metadata.tables.values() for index in table.indexes if index.name
        }
        assert set(database.Base.metadata.tables) <= tables
        assert modeled_indexes <= indexes
        assert "archive_fts" in tables
        assert {"archive_fts_insert", "archive_fts_delete", "archive_fts_update"} <= triggers
    finally:
        await engine.dispose()
        database.engine = original_engine
        database.async_session = original_session


def test_sqlite_connections_enforce_foreign_keys():
    from backend.app.core.database import _set_sqlite_pragmas

    connection = sqlite3.connect(":memory:")
    try:
        _set_sqlite_pragmas(connection, None)
        assert connection.execute("PRAGMA foreign_keys").fetchone() == (1,)
    finally:
        connection.close()
