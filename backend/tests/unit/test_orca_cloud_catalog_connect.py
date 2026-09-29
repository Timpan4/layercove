"""Orca Cloud connection initializes the persistent profile mirror."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

import backend.app.models  # noqa: F401
from backend.app.api.routes.orca_cloud import auth_password
from backend.app.core.database import Base
from backend.app.models.slice_job import SliceJobRecord  # noqa: F401
from backend.app.models.slicer_profile_catalog import SlicerProfile
from backend.app.models.user import User
from backend.app.schemas.orca_cloud import OrcaAuthPasswordRequest
from backend.app.services.orca_cloud import OrcaCloudService, OrcaProfilePull


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def test_password_connection_runs_initial_persistent_catalog_sync(db, monkeypatch):
    user = User(username="orca-owner")
    db.add(user)
    await db.commit()

    async def password_login(service, _email, _password):
        service.access_token = "access"
        service.refresh_token = "refresh"
        service.token_expiry = datetime.now(timezone.utc) + timedelta(hours=1)

    async def get_user_info(_service):
        return {"id": "orca-user-1", "email": "owner@example.com"}

    async def pull_profiles(_service, cursor):
        assert cursor is None
        return OrcaProfilePull(
            next_cursor="cursor-1",
            upserts=[
                {
                    "id": "remote-process-1",
                    "name": "Cloud P1S process",
                    "content": {
                        "type": "print",
                        "compatible_printers": ["Bambu Lab P1S 0.4 nozzle"],
                    },
                }
            ],
            deletes=[],
            full_snapshot=True,
        )

    monkeypatch.setattr(OrcaCloudService, "password_login", password_login)
    monkeypatch.setattr(OrcaCloudService, "get_user_info", get_user_info)
    monkeypatch.setattr(OrcaCloudService, "pull_profiles", pull_profiles)

    response = await auth_password(
        OrcaAuthPasswordRequest(email="owner@example.com", password="secret"),
        db,
        user,
    )

    profile = await db.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == "remote-process-1"))
    assert response.connected is True
    assert profile is not None
