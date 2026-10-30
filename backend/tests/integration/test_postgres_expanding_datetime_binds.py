"""Aware datetimes bind correctly on PostgreSQL in statements with IN lists."""

import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlalchemy.schema import CreateSchema, DropSchema

from backend.app.core import database
from backend.app.models.auth_ephemeral import AuthRateLimitEvent
from backend.app.models.print_queue import PrintQueueItem


# Failure mode: recording a failed Moonraker upload counted today's finished queue items with
# an aware datetime next to an IN list. The IN list's expansion shifted the parameter positions,
# so the aware value reached a TIMESTAMP WITHOUT TIME ZONE column and asyncpg raised DBAPIError.
@pytest.mark.asyncio
@pytest.mark.integration
async def test_aware_datetimes_bind_by_column_type_next_to_in_lists(monkeypatch):
    database_url = os.environ.get("TEST_POSTGRES_DATABASE_URL")
    if not database_url:
        pytest.skip("TEST_POSTGRES_DATABASE_URL is not configured")
    if not (make_url(database_url).database or "").endswith("_test"):
        pytest.fail("TEST_POSTGRES_DATABASE_URL must name an isolated *_test database")

    # Register the production models without starting the app or its hardware services.
    from backend.app import main as registered_models  # noqa: F401

    monkeypatch.setattr(database.settings, "database_url", database_url)
    monkeypatch.setattr(database, "is_sqlite", lambda: False)
    engine = database._create_engine()
    schema = f"expanding_dates_{uuid4().hex}"
    engine.update_execution_options(schema_translate_map={None: schema})
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as connection:
            await connection.execute(CreateSchema(schema))
            await connection.run_sync(database.Base.metadata.create_all)
        occurred = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
        async with sessions() as session:
            session.add_all(
                [
                    PrintQueueItem(status="failed", completed_at=datetime(2026, 10, 30, 12)),
                    AuthRateLimitEvent(username="fixture", event_type="email_send", occurred_at=occurred),
                ]
            )
            await session.commit()

            # 13:00 at UTC+2 is 11:00 UTC, before the naive UTC 12:00 completion.
            since = datetime(2026, 10, 30, 13, tzinfo=timezone(timedelta(hours=2)))
            completed = await session.scalar(
                select(func.count(PrintQueueItem.id)).where(
                    PrintQueueItem.status.in_(["completed", "failed", "skipped"]),
                    PrintQueueItem.completed_at >= since,
                )
            )
            # A TIMESTAMP WITH TIME ZONE column next to an IN list binds too: 14:30 at UTC+2 is after 12:00 UTC.
            later = datetime(2026, 10, 30, 14, 30, tzinfo=timezone(timedelta(hours=2)))
            events = await session.scalar(
                select(func.count(AuthRateLimitEvent.id)).where(
                    AuthRateLimitEvent.event_type.in_(["email_send", "2fa_attempt"]),
                    AuthRateLimitEvent.occurred_at >= later,
                )
            )

        assert completed == 1
        assert events == 0
    finally:
        async with engine.begin() as connection:
            await connection.execute(DropSchema(schema, cascade=True, if_exists=True))
        await engine.dispose()
