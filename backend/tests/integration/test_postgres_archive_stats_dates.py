"""Ranged Statistics works with PostgreSQL's naive UTC event timestamps."""

import os
from datetime import datetime
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker
from sqlalchemy.schema import CreateSchema, DropSchema

from backend.app.api.routes import archives
from backend.app.core import auth, database
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.settings import Settings
from backend.app.models.user import User


@pytest.mark.asyncio
@pytest.mark.integration
async def test_postgres_statistics_date_bounds_and_user_filters(monkeypatch):
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
    schema = f"stats_dates_{uuid4().hex}"
    engine.update_execution_options(schema_translate_map={None: schema})
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(auth, "async_session", sessions)

    async def fixture_db():
        async with sessions() as session:
            yield session

    app = FastAPI()
    app.dependency_overrides[database.get_db] = fixture_db
    app.include_router(archives.router, prefix="/api/v1")
    try:
        async with engine.begin() as connection:
            await connection.execute(CreateSchema(schema))
            await connection.run_sync(database.Base.metadata.create_all)
        async with sessions() as session:
            session.add_all(
                [
                    User(id=901, username="Fixture Alice"),
                    User(id=902, username="Fixture Bob"),
                    Settings(key="energy_tracking_mode", value="per_print"),
                ]
            )
            await session.flush()
            for timestamp, status, owner in [
                (datetime(2020, 1, 4, 23, 59, 59, 999999), "failed", 901),
                (datetime(2020, 1, 5), "completed", 901),
                (datetime(2020, 1, 6, 12), "failed", 902),
                (datetime(2020, 1, 8, 12), "aborted", 901),
                (datetime(2020, 1, 9, 12), "cancelled", 901),
                (datetime(2020, 1, 10, 12), "stopped", 902),
                (datetime(2020, 1, 12, 23, 59, 59, 999999), "skipped", None),
                (datetime(2020, 1, 13), "failed", 901),
            ]:
                session.add(
                    PrintLogEntry(
                        created_at=timestamp,
                        status=status,
                        created_by_id=owner,
                        duration_seconds=3600,
                        filament_type="PLA",
                        filament_used_grams=10,
                        cost=2,
                        energy_kwh=0.1,
                        energy_cost=0.02,
                    )
                )
            await session.commit()

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            for params, total, successful, failed, cancelled in [
                ({}, 8, 1, 4, 3),
                ({"date_from": "2020-01-05"}, 7, 1, 3, 3),
                ({"date_to": "2020-01-12"}, 7, 1, 3, 3),
                ({"date_from": "2020-01-05", "date_to": "2020-01-12"}, 6, 1, 2, 3),
                ({"date_from": "2020-01-05", "date_to": "2020-01-12", "created_by_id": 901}, 3, 1, 1, 1),
                ({"date_from": "2020-01-05", "date_to": "2020-01-12", "created_by_id": -1}, 1, 0, 0, 1),
            ]:
                response = await client.get("/api/v1/archives/stats", params=params)
                assert response.status_code == 200
                result = response.json()
                assert result["total_prints"] == total
                assert result["successful_prints"] == successful
                assert result["failed_prints"] == failed
                assert result["cancelled_prints"] == cancelled
                assert result["total_print_time_hours"] == total
                assert result["total_filament_grams"] == total * 10
                assert result["total_cost"] == total * 2
                assert result["prints_by_filament_type"] == {"PLA": total}
                assert result["total_energy_kwh"] == round(total * 0.1, 3)
                assert result["total_energy_cost"] == round(total * 0.02, 3)
    finally:
        async with engine.begin() as connection:
            await connection.execute(DropSchema(schema, cascade=True, if_exists=True))
        await engine.dispose()
