"""run_migrations must not link legacy print-log rows to an ambiguous archive.

The archive_id backfill matched on (print_name, printer_id) only and took the
highest id, so a later upload with the same name could capture another
archive's unlinked runs.
"""

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.database import run_migrations


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    from backend.app.core import database as database_module, db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


@pytest.fixture
async def engine_with_full_schema():
    import importlib
    import pkgutil

    import backend.app.models as models_pkg
    from backend.app.core.database import Base

    for mod in pkgutil.iter_modules(models_pkg.__path__):
        importlib.import_module(f"backend.app.models.{mod.name}")

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


async def _archive(conn, archive_id: int, name: str):
    await conn.execute(
        text(
            "INSERT INTO print_archives (id, filename, print_name, file_path, file_size, status, "
            "quantity, is_favorite, created_at) VALUES (:i, 'f.3mf', :n, 'archives/x/f.3mf', 1, 'completed', 1, 0, "
            "CURRENT_TIMESTAMP)"
        ),
        {"i": archive_id, "n": name},
    )


async def _log(conn, log_id: int, name: str):
    await conn.execute(
        text(
            "INSERT INTO print_log_entries (id, print_name, status, created_at) "
            "VALUES (:i, :n, 'completed', CURRENT_TIMESTAMP)"
        ),
        {"i": log_id, "n": name},
    )


@pytest.mark.asyncio
async def test_backfill_leaves_ambiguous_name_matches_unlinked(engine_with_full_schema):
    async with engine_with_full_schema.begin() as conn:
        await _archive(conn, 1, "Victim")
        await _archive(conn, 2, "Victim")  # attacker upload with the same name
        await _archive(conn, 3, "Unique")
        await _log(conn, 10, "Victim")
        await _log(conn, 11, "Unique")

    async with engine_with_full_schema.begin() as conn:
        await run_migrations(conn)

    async with engine_with_full_schema.begin() as conn:
        rows = dict((await conn.execute(text("SELECT id, archive_id FROM print_log_entries"))).all())
    assert rows[10] is None
    assert rows[11] == 3
