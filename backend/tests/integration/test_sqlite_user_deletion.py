from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi import HTTPException
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.api.routes.users import delete_user
from backend.app.core.database import Base, _set_sqlite_pragmas
from backend.app.models.slicer_profile_catalog import SlicerProfileRevision
from backend.app.models.user import User
from backend.app.services.filament_edit import FilamentCopyRequest, copy_filament_profile
from backend.tests._fixtures.calibration import filament_schema  # noqa: F401
from backend.tests.integration.test_calibration_sessions import PLA_CONTENT, publish_filament


# Failure mode: SQLite opens a transaction only at the first write, so a slice job admitted after
# the deletion's check and before its first write pinned a private copy the deletion removed.
async def test_deleting_a_user_sees_a_slice_job_admitted_before_its_first_write(tmp_path):
    path = tmp_path / "race.sqlite"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    event.listen(engine.sync_engine, "connect", _set_sqlite_pragmas)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    try:
        async with sessions() as db:
            activation = await publish_filament(db, PLA_CONTENT)
            owner = User(username="private-copier")
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

        armed = True

        def admit_before_first_write(conn, cursor, statement, parameters, context, executemany):
            nonlocal armed
            if not armed or not statement.lstrip().upper().startswith(("UPDATE", "DELETE", "INSERT")):
                return
            armed = False
            # Another request admits a job pinning the copy, as SliceDispatcher.enqueue does.
            other = sqlite3.connect(path)
            try:
                job_id = other.execute(
                    "INSERT INTO slice_jobs (owner_id, source_kind, source_id, source_name, status, created_at) "
                    "VALUES (?, 'library_file', 1, 'model.3mf', 'pending', CURRENT_TIMESTAMP)",
                    (owner_id,),
                ).lastrowid
                other.execute(
                    "INSERT INTO slicer_job_provenance (slice_job_id, provenance_state, filament_revision_ids, created_at) "
                    "VALUES (?, 'resolved', ?, CURRENT_TIMESTAMP)",
                    (job_id, json.dumps([copy["revision_id"]])),
                )
                other.commit()
            finally:
                other.close()

        event.listen(engine.sync_engine, "before_cursor_execute", admit_before_first_write)
        async with sessions() as deletion:
            with pytest.raises(HTTPException) as refused:
                await delete_user(owner_id, False, None, None, deletion)
            await deletion.rollback()
        assert refused.value.status_code == 409
        assert not armed

        async with sessions() as observer:
            assert await observer.get(User, owner_id) is not None
            assert await observer.get(SlicerProfileRevision, copy["revision_id"]) is not None
    finally:
        await engine.dispose()
