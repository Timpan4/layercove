"""Saving calibration results into the calibrated profile instead of a new copy."""

import json

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from backend.app.models.local_preset import LocalPreset
from backend.app.models.printer import Printer
from backend.app.models.slicer_profile_catalog import SlicerProfile, SlicerProfileActivation, SlicerProfileRevision
from backend.app.models.user import User
from backend.app.services.filament_edit import FilamentCopyRequest, copy_filament_profile, update_local_filament
from backend.app.services.slicer_catalog_sync import sync_local_catalog
from backend.tests._fixtures.calibration import filament_schema  # noqa: F401
from backend.tests.integration.test_calibration_sessions import PLA_CONTENT, create_session, publish_filament, record

RESULTS = (
    ("temperature", 210),
    ("flow_rate", 0.98),
    ("pressure_advance", 0.021),
    ("retraction", 0.6),
    ("volumetric_flow", 18),
)


async def active_content(db, profile_id):
    revision_id = await db.scalar(
        select(SlicerProfileActivation.revision_id).where(SlicerProfileActivation.profile_id == profile_id)
    )
    return (await db.get(SlicerProfileRevision, revision_id)).content


async def finish(client, session):
    for step, value in RESULTS:
        session = await record(client, session, step, value)
    return await client.post(
        f"/api/v1/calibration/sessions/{session['id']}/save",
        json={"version": session["version"], "name": "unused", "update_profile": True},
    )


# Failure mode: calibrating an existing local preset always created another profile.
async def test_calibration_can_update_the_local_preset_it_calibrated(async_client, db_session):
    preset = LocalPreset(name="Shop PLA", preset_type="filament", source="manual", setting=json.dumps(PLA_CONTENT))
    printer = Printer(name="Calibration machine", provider="moonraker")
    db_session.add_all([preset, printer])
    await db_session.flush()
    await sync_local_catalog(db_session)
    await db_session.commit()
    profile = await db_session.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == str(preset.id)))
    revision_id = await db_session.scalar(
        select(SlicerProfileActivation.revision_id).where(SlicerProfileActivation.profile_id == profile.id)
    )
    created = await async_client.post(
        "/api/v1/calibration/sessions",
        json={
            "printer_id": printer.id,
            "filament_profile_id": profile.id,
            "filament_revision_id": revision_id,
            "nozzle_diameter": 0.4,
        },
    )
    assert created.status_code == 201, created.text
    profiles_before = await db_session.scalar(select(func.count(SlicerProfile.id)))

    saved = await finish(async_client, created.json())
    assert saved.status_code == 200, saved.text
    assert saved.json()["saved_profile_id"] == profile.id
    assert await db_session.scalar(select(func.count(SlicerProfile.id))) == profiles_before
    await db_session.refresh(preset)
    assert json.loads(preset.setting)["nozzle_temperature"] == ["210"]
    content = await active_content(db_session, profile.id)
    assert content["nozzle_temperature"] == ["210"]
    assert content["filament_max_volumetric_speed"] == ["18"]


async def test_a_synced_profile_is_not_updated_in_place(async_client, db_session):
    session = await create_session(async_client, db_session)
    response = await finish(async_client, session)
    assert response.status_code == 409, response.text
    assert (await active_content(db_session, session["filament_profile_id"]))["nozzle_temperature"] == ["220"]


async def test_a_private_copy_is_updated_only_by_its_owner(db_session):
    activation = await publish_filament(db_session, PLA_CONTENT)
    owner, other = User(username="owner"), User(username="other")
    db_session.add_all([owner, other])
    await db_session.flush()
    copy = await copy_filament_profile(
        db_session,
        activation.profile_id,
        FilamentCopyRequest(base_revision_id=activation.revision_id, name="Mine"),
        owner.id,
    )
    overrides = {"nozzle_temperature": ["205"]}
    with pytest.raises(HTTPException) as refused:
        await update_local_filament(db_session, copy["profile_id"], copy["revision_id"], overrides, other.id)
    assert refused.value.status_code == 409
    await update_local_filament(db_session, copy["profile_id"], copy["revision_id"], overrides, owner.id)
    assert (await active_content(db_session, copy["profile_id"]))["nozzle_temperature"] == ["205"]
