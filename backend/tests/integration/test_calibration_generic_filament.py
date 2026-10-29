"""Calibrating a new filament profile that starts from a bundled generic profile."""

from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from backend.app.models.printer import Printer
from backend.app.models.slicer_profile_catalog import SlicerProfile, SlicerProfileActivation, SlicerProfileRevision
from backend.app.services.slicer_api import SlicerApiService
from backend.app.services.slicer_catalog_sync import sync_standard_account
from backend.tests._fixtures.calibration import filament_schema  # noqa: F401
from backend.tests.integration.test_calibration_sessions import PLA_CONTENT, record

BUNDLED = {
    "printer": [],
    "process": [],
    "filament": [
        {
            "name": "Generic PLA @System",
            "stable_id": "GFSL99",
            "content": {**PLA_CONTENT, "name": "Generic PLA @System"},
        },
        {"name": "Bambu PLA Basic @BBL P1S", "stable_id": "GFSA00", "content": {**PLA_CONTENT, "name": "Bambu"}},
    ],
}


@pytest.fixture(autouse=True)
def bundled_profiles(monkeypatch):
    monkeypatch.setattr(SlicerApiService, "list_bundled_profiles", AsyncMock(return_value=BUNDLED))


async def start(client, db):
    printer = Printer(name="Calibration machine", provider="moonraker")
    db.add(printer)
    await db.commit()
    return await client.post(
        "/api/v1/calibration/sessions",
        json={"printer_id": printer.id, "generic_filament": "Generic PLA @System", "nozzle_diameter": 0.4},
    )


# Failure mode: calibration could only refine an existing profile, so a new filament had no starting point.
async def test_a_new_filament_profile_starts_from_a_generic_profile(async_client, db_session):
    listed = await async_client.get("/api/v1/calibration/generic-filaments")
    assert listed.json() == ["Generic PLA @System"]

    response = await start(async_client, db_session)
    assert response.status_code == 201, response.text
    session = response.json()
    base = await db_session.get(SlicerProfile, session["filament_profile_id"])
    assert base.display_name == "Generic PLA @System"
    for step, value in (
        ("temperature", 210),
        ("flow_rate", 0.98),
        ("pressure_advance", 0.021),
        ("retraction", 0.6),
        ("volumetric_flow", 18),
    ):
        session = await record(async_client, session, step, value)
    saved = await async_client.post(
        f"/api/v1/calibration/sessions/{session['id']}/save",
        json={"version": session["version"], "name": "Polymaker PLA"},
    )
    assert saved.status_code == 200, saved.text
    profile = await db_session.get(SlicerProfile, saved.json()["saved_profile_id"])
    assert profile.display_name == "Polymaker PLA"
    revision_id = await db_session.scalar(
        select(SlicerProfileActivation.revision_id).where(SlicerProfileActivation.profile_id == profile.id)
    )
    content = (await db_session.get(SlicerProfileRevision, revision_id)).content
    assert content["nozzle_temperature"] == ["210"]
    assert content["filament_flow_ratio"] == ["0.98"]


# Failure mode: approving the generic profile's review batch would approve or reject the rest
# of a standard sync waiting for review.
async def test_a_generic_profile_waiting_in_a_standard_sync_is_not_approved(async_client, db_session):
    await sync_standard_account(db_session, BUNDLED)
    response = await start(async_client, db_session)
    assert response.status_code == 409, response.text
    states = set(await db_session.scalars(select(SlicerProfileRevision.review_state)))
    assert states == {"pending"}


@pytest.mark.parametrize(
    "filament",
    [
        {},
        {"filament_profile_id": 1, "filament_revision_id": 1, "generic_filament": "Generic PLA @System"},
        {"filament_profile_id": 1, "generic_filament": "Generic PLA @System"},
    ],
)
async def test_a_session_starts_from_exactly_one_filament(async_client, filament):
    response = await async_client.post(
        "/api/v1/calibration/sessions", json={"printer_id": 1, "nozzle_diameter": 0.4, **filament}
    )
    assert response.status_code == 422, response.text
