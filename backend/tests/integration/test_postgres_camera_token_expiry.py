from __future__ import annotations

import os
import time

import pytest
from sqlalchemy import delete, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.core import auth, database
from backend.app.models.auth_ephemeral import AuthEphemeralToken


@pytest.mark.asyncio
async def test_camera_stream_token_expires_from_postgres_current_timestamp(monkeypatch):
    database_url = os.environ.get("TEST_POSTGRES_DATABASE_URL")
    if not database_url:
        pytest.skip("TEST_POSTGRES_DATABASE_URL is not configured")
    if not (make_url(database_url).database or "").endswith("_test"):
        pytest.fail("TEST_POSTGRES_DATABASE_URL must name an isolated *_test database")

    monkeypatch.setattr(database.settings, "database_url", database_url)
    monkeypatch.setattr(database, "is_sqlite", lambda: False)
    engine = database._create_engine()
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(auth, "async_session", session_factory)

    original_tz = os.environ.get("TZ")
    os.environ["TZ"] = "Europe/Stockholm"
    time.tzset()
    token: str | None = None
    try:
        async with engine.begin() as connection:
            await connection.run_sync(AuthEphemeralToken.__table__.create, checkfirst=True)

        token = await auth.create_camera_stream_token()

        async with engine.connect() as connection:
            remaining_seconds = await connection.scalar(
                text(
                    "SELECT EXTRACT(EPOCH FROM (expires_at - CURRENT_TIMESTAMP)) "
                    "FROM auth_ephemeral_tokens WHERE token = :token"
                ),
                {"token": token},
            )

        assert remaining_seconds is not None
        assert 3500 < float(remaining_seconds) <= 3600
    finally:
        if token is not None:
            async with session_factory() as session:
                await session.execute(delete(AuthEphemeralToken).where(AuthEphemeralToken.token == token))
                await session.commit()
        await engine.dispose()
        if original_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = original_tz
        time.tzset()
