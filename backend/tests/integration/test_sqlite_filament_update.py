from __future__ import annotations

import sqlite3

import pytest
from fastapi import HTTPException
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
import backend.app.models.slice_job  # noqa: F401  calibration evidence references slice jobs
from backend.app.core.database import Base, _set_sqlite_pragmas
from backend.app.models.slicer_profile_catalog import SlicerProfileActivation
from backend.app.models.user import User
from backend.app.services.filament_edit import FilamentCopyRequest, copy_filament_profile, update_local_filament
from backend.app.services.slicer_catalog import activate_revision
from backend.tests.integration.test_calibration_sessions import PLA_CONTENT, publish_filament


# Failure mode: two saves from the same revision both passed the active revision check, and the
# later one replaced the earlier one's results without noticing that the profile had changed.
async def test_an_update_sees_a_concurrent_save_of_the_same_revision(tmp_path):
    path = tmp_path / "race.sqlite"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    event.listen(engine.sync_engine, "connect", _set_sqlite_pragmas)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            activation = await publish_filament(db, PLA_CONTENT)
            owner = User(username="calibrator")
            db.add(owner)
            await db.commit()
            owner_id = owner.id
            copy = await copy_filament_profile(
                db,
                activation.profile_id,
                FilamentCopyRequest(base_revision_id=activation.revision_id, name="Mine"),
                owner_id,
            )
            await db.commit()
            base = copy["revision_id"]
            # Another session's save, already made, then rolled back so both start from the base.
            await update_local_filament(db, copy["profile_id"], base, {"nozzle_temperature": ["205"]}, owner_id)
            other = await db.scalar(
                select(SlicerProfileActivation.revision_id).where(
                    SlicerProfileActivation.profile_id == copy["profile_id"]
                )
            )
            await activate_revision(db, base, owner_id, action="rollback")
            await db.commit()

        armed = True

        def save_before_first_write(conn, cursor, statement, parameters, context, executemany):
            nonlocal armed
            if not armed or not statement.lstrip().upper().startswith(("UPDATE", "DELETE", "INSERT")):
                return
            armed = False
            # The other save commits between this save's check and its first write.
            competing = sqlite3.connect(path)
            try:
                competing.execute(
                    "UPDATE slicer_profile_activations SET revision_id = ? WHERE profile_id = ?",
                    (other, copy["profile_id"]),
                )
                competing.commit()
            finally:
                competing.close()

        event.listen(engine.sync_engine, "before_cursor_execute", save_before_first_write)
        async with sessions() as db:
            with pytest.raises(HTTPException) as refused:
                await update_local_filament(db, copy["profile_id"], base, {"nozzle_temperature": ["210"]}, owner_id)
            await db.rollback()
        assert refused.value.status_code == 409
        assert not armed
    finally:
        await engine.dispose()
