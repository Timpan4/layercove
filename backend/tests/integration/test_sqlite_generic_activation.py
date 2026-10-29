from __future__ import annotations

import sqlite3

import pytest
from fastapi import HTTPException
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
import backend.app.models.slice_job  # noqa: F401  calibration evidence references slice jobs
from backend.app.api.routes.calibration import activate_generic_filament
from backend.app.core.database import Base, _set_sqlite_pragmas
from backend.app.models.slicer_profile_catalog import SlicerProfileRevision
from backend.app.services.slicer_catalog import CatalogInput, CatalogProfile, approve_review_batch, ingest_catalog

ITEM = CatalogProfile(
    remote_profile_id="GFSL99",
    profile_type="filament",
    display_name="Generic PLA @System",
    content={"nozzle_temperature": ["220"]},
)


# Failure mode: two first starts from a generic profile that a review approved but did not activate
# both inserted its activation, and the later one failed with a 500.
async def test_a_concurrent_first_start_from_a_generic_profile_is_refused(tmp_path):
    path = tmp_path / "race.sqlite"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    event.listen(engine.sync_engine, "connect", _set_sqlite_pragmas)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            result = await ingest_catalog(
                db, CatalogInput(source="standard", remote_account_id="bundled", profiles=[ITEM], cursor="snapshot")
            )
            await approve_review_batch(db, result.review_batch_id)
            await db.commit()
            revision_id = result.current_revision_ids[0]
            profile_id = (await db.get(SlicerProfileRevision, revision_id)).profile_id

        armed = True

        def other_start_first(conn, cursor, statement, parameters, context, executemany):
            nonlocal armed
            if not armed or "INSERT INTO slicer_profile_activations" not in statement:
                return
            armed = False
            competing = sqlite3.connect(path)
            try:
                competing.execute(
                    "INSERT INTO slicer_profile_activations (profile_id, revision_id, activated_at) "
                    "VALUES (?, ?, CURRENT_TIMESTAMP)",
                    (profile_id, revision_id),
                )
                competing.commit()
            finally:
                competing.close()

        event.listen(engine.sync_engine, "before_cursor_execute", other_start_first)
        async with sessions() as db:
            with pytest.raises(HTTPException) as refused:
                await activate_generic_filament(db, ITEM, None)
            await db.rollback()
        assert refused.value.status_code == 409
        assert not armed
    finally:
        await engine.dispose()
