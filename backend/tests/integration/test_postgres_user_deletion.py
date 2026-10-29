from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import backend.app.models  # noqa: F401
from backend.app.api.routes.users import delete_user
from backend.app.core.database import Base
from backend.app.models.slice_job import SliceJobRecord
from backend.app.models.slicer_profile_catalog import SlicerJobProvenance, SlicerProfileRevision
from backend.app.models.user import User
from backend.app.services.filament_edit import FilamentCopyRequest, copy_filament_profile
from backend.tests._fixtures.calibration import filament_schema  # noqa: F401
from backend.tests.integration.test_calibration_sessions import PLA_CONTENT, publish_filament


# Failure mode: a slice job admitted while its owner was being deleted pinned a private copy
# that the deletion then removed, so the job failed when it loaded its profiles.
@pytest.mark.asyncio
async def test_deleting_a_user_waits_for_a_slice_job_being_admitted():
    database_url = os.environ.get("TEST_POSTGRES_DATABASE_URL")
    if not database_url:
        pytest.skip("TEST_POSTGRES_DATABASE_URL is not configured")
    if not (make_url(database_url).database or "").endswith("_test"):
        pytest.fail("TEST_POSTGRES_DATABASE_URL must name an isolated *_test database")

    engine = create_async_engine(database_url)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.drop_all)
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

        async with sessions() as admission, sessions() as deletion, sessions() as observer:
            # Admission inserts the job and its provenance in one transaction, as slice_dispatch does.
            job = SliceJobRecord(
                owner_id=owner_id,
                source_kind="library_file",
                source_id=1,
                source_name="model.3mf",
                status="pending",
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            admission.add(job)
            await admission.flush()
            admission.add(
                SlicerJobProvenance(
                    slice_job_id=job.id, provenance_state="resolved", filament_revision_ids=[copy["revision_id"]]
                )
            )
            await admission.flush()

            deleting = asyncio.create_task(delete_user(owner_id, False, None, None, deletion))
            # Wait until the deletion is blocked on the admission's lock on the user row.
            while not deleting.done():
                waiting = await observer.scalar(
                    text(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE wait_event_type = 'Lock' AND datname = current_database()"
                    )
                )
                if waiting:
                    break
                await asyncio.sleep(0)
            await admission.commit()

            with pytest.raises(HTTPException) as refused:
                await deleting
            assert refused.value.status_code == 409
            await deletion.rollback()
            assert await observer.get(User, owner_id) is not None
            assert await observer.get(SlicerProfileRevision, copy["revision_id"]) is not None
    finally:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.drop_all)
        await engine.dispose()
