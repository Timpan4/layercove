"""Calibration sessions through HTTP, including catalog copy transactions."""

import pytest
from sqlalchemy import select

from backend.app.models.calibration import CalibrationSession
from backend.app.models.printer import Printer
from backend.app.models.slicer_profile_catalog import SlicerProfileActivation, SlicerProfileRevision
from backend.app.models.user import User
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
    ingest_catalog,
)
from backend.tests._fixtures.calibration import filament_schema  # noqa: F401


async def create_session(client, db):
    printer = Printer(name="Calibration machine", provider="moonraker")
    db.add(printer)
    catalog = await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="calibration-test",
            profiles=[
                CatalogProfile(
                    "pla",
                    "filament",
                    "Original PLA",
                    {
                        "type": "filament",
                        "name": "Original PLA",
                        "nozzle_temperature": ["220"],
                        "nozzle_temperature_initial_layer": ["220"],
                        "filament_flow_ratio": ["1"],
                        "pressure_advance": ["0.02"],
                        "filament_retraction_length": ["0.8"],
                        "filament_max_volumetric_speed": ["15"],
                    },
                )
            ],
        ),
    )
    await approve_review_batch(db, catalog.review_batch_id)
    activation = await activate_revision(db, catalog.revision_ids[0])
    await db.commit()
    response = await client.post(
        "/api/v1/calibration/sessions",
        json={
            "printer_id": printer.id,
            "filament_profile_id": activation.profile_id,
            "filament_revision_id": activation.revision_id,
            "nozzle_diameter": 0.4,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.parametrize(
    "step,value", [("temperature", 100000), ("temperature", 210.5), ("flow_rate", 3), ("pressure_advance", 3)]
)
async def test_results_reject_values_outside_pinned_setting_limits(async_client, db_session, step, value):
    session = await create_session(async_client, db_session)
    response = await async_client.put(
        f"/api/v1/calibration/sessions/{session['id']}/results/{step}",
        json={"version": session["version"], "value": value},
    )
    assert response.status_code == 422, response.text


async def test_temperature_range_cannot_exceed_material_maximum(async_client, db_session):
    session = await create_session(async_client, db_session)
    response = await async_client.put(
        f"/api/v1/calibration/sessions/{session['id']}/parameters/temperature",
        json={"version": session["version"], "lowest": 200, "highest": 500, "increment": 5, "baseline": 210},
    )
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("highest,increment", [(1.05, 0.1), (1e308, 1e-308)])
async def test_range_requires_a_representable_highest_sample(async_client, db_session, highest, increment):
    session = await create_session(async_client, db_session)
    response = await async_client.put(
        f"/api/v1/calibration/sessions/{session['id']}/parameters/retraction",
        json={
            "version": session["version"],
            "lowest": 0.1,
            "highest": highest,
            "increment": increment,
            "baseline": 0.4,
        },
    )
    assert response.status_code == 422, response.text


async def record(client, session, step, value):
    response = await client.put(
        f"/api/v1/calibration/sessions/{session['id']}/results/{step}",
        json={
            "version": session["version"],
            "value": value,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_manual_results_resume_and_save_an_active_copy(async_client, db_session):
    session = await create_session(async_client, db_session)
    original = await db_session.get(SlicerProfileRevision, session["filament_revision_id"])
    before = dict(original.content)
    for step, value in (
        ("temperature", 210),
        ("flow_rate", 0.98),
        ("pressure_advance", 0.021),
        ("retraction", 0.6),
        ("volumetric_flow", 18),
    ):
        session = await record(async_client, session, step, value)
    resumed = await async_client.get(f"/api/v1/calibration/sessions/{session['id']}")
    assert resumed.json()["results"] == session["results"]
    response = await async_client.post(
        f"/api/v1/calibration/sessions/{session['id']}/save",
        json={
            "version": session["version"],
            "name": "Calibrated PLA",
            "share_local_copy": True,
        },
    )
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["saved_profile_id"] != session["filament_profile_id"]
    active = await db_session.scalar(
        select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == saved["saved_profile_id"])
    )
    copy = await db_session.get(SlicerProfileRevision, active.revision_id)
    assert copy.content["nozzle_temperature"] == ["210"]
    assert copy.content["nozzle_temperature_initial_layer"] == ["210"]
    assert copy.content["filament_flow_ratio"] == ["0.98"]
    assert copy.content["pressure_advance"] == ["0.021"]
    assert copy.content["enable_pressure_advance"] == ["1"]
    assert copy.content["filament_retraction_length"] == ["0.6"]
    assert copy.content["filament_max_volumetric_speed"] == ["18"]
    await db_session.refresh(original)
    assert original.content == before
    # Retrying a save must not create another copy.
    repeated = await async_client.post(
        f"/api/v1/calibration/sessions/{session['id']}/save",
        json={
            "version": saved["version"],
            "name": "Calibrated PLA",
            "share_local_copy": True,
        },
    )
    assert repeated.json()["saved_profile_id"] == saved["saved_profile_id"]


async def test_order_invalidation_and_stale_edits(async_client, db_session):
    session = await create_session(async_client, db_session)
    skipped = await async_client.put(
        f"/api/v1/calibration/sessions/{session['id']}/results/retraction",
        json={"version": session["version"], "value": 0.6},
    )
    assert skipped.status_code == 409
    old = session
    session = await record(async_client, session, "temperature", 210)
    stale = await async_client.put(
        f"/api/v1/calibration/sessions/{session['id']}/results/temperature",
        json={"version": old["version"], "value": 215},
    )
    assert stale.status_code == 409
    session = await record(async_client, session, "flow_rate", 0.98)
    session = await record(async_client, session, "pressure_advance", 0.021)
    session = await record(async_client, session, "temperature", 215)
    assert session["results"] == {"temperature": 215.0}
    incomplete = await async_client.post(
        f"/api/v1/calibration/sessions/{session['id']}/save",
        json={
            "version": session["version"],
            "name": "Incomplete",
            "share_local_copy": True,
        },
    )
    assert incomplete.status_code == 409


async def test_invalid_result_and_unknown_step_are_rejected(async_client, db_session):
    session = await create_session(async_client, db_session)
    for step, value in (("temperature", -1), ("unknown", 210)):
        response = await async_client.put(
            f"/api/v1/calibration/sessions/{session['id']}/results/{step}",
            json={"version": session["version"], "value": value},
        )
        assert response.status_code == 422


async def test_generation_requires_order_and_saved_test_values(async_client, db_session):
    session = await create_session(async_client, db_session)
    body = {"version": session["version"], "binding_id": 1, "process_profile_id": 1}
    for step in ("temperature", "retraction"):
        response = await async_client.post(f"/api/v1/calibration/sessions/{session['id']}/generate/{step}", json=body)
        assert response.status_code == 409, response.text


async def test_print_requires_a_generated_artifact_and_plate_confirmation(async_client, db_session):
    session = await create_session(async_client, db_session)
    response = await async_client.post(
        f"/api/v1/calibration/sessions/{session['id']}/print/temperature",
        json={"version": session["version"], "plate_clear": True},
    )
    assert response.status_code == 409, response.text
    rejected = await async_client.post(
        f"/api/v1/calibration/sessions/{session['id']}/print/temperature",
        json={"version": session["version"], "plate_clear": False},
    )
    assert rejected.status_code == 422, rejected.text


async def test_photo_is_validated_persisted_and_attached_to_the_step(async_client, db_session, tmp_path, monkeypatch):
    import io

    from PIL import Image

    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    session = await create_session(async_client, db_session)
    path = f"/api/v1/calibration/sessions/{session['id']}/evidence/temperature"
    rejected = await async_client.post(path, files={"file": ("photo.png", b"not an image", "image/png")})
    assert rejected.status_code == 422, rejected.text
    photo = io.BytesIO()
    Image.new("RGB", (32, 32), "orange").save(photo, format="PNG")
    uploaded = await async_client.post(path, files={"file": ("../../photo.png", photo.getvalue(), "image/png")})
    assert uploaded.status_code == 201, uploaded.text
    evidence = uploaded.json()
    resumed = await async_client.get(f"/api/v1/calibration/sessions/{session['id']}/evidence")
    assert resumed.json()[0]["id"] == evidence["id"]
    assert resumed.json()[0]["step"] == "temperature"
    image = await async_client.get(f"/api/v1/calibration/sessions/{session['id']}/evidence/{evidence['id']}/image")
    assert image.status_code == 200
    with Image.open(io.BytesIO(image.content)) as decoded:
        assert decoded.size == (32, 32)


async def test_parameters_persist_and_invalid_ranges_do_not_replace_them(async_client, db_session):
    session = await create_session(async_client, db_session)
    path = f"/api/v1/calibration/sessions/{session['id']}/parameters/temperature"
    values = {"lowest": 200, "highest": 220, "increment": 5, "baseline": 210}
    response = await async_client.put(path, json={"version": session["version"], **values})
    assert response.status_code == 200, response.text
    session = response.json()
    rejected = await async_client.put(path, json={"version": session["version"], **values, "highest": 190})
    assert rejected.status_code == 422
    resumed = await async_client.get(f"/api/v1/calibration/sessions/{session['id']}")
    assert resumed.json()["parameters"]["temperature"] == values


async def test_another_user_cannot_read_or_edit_a_private_session(async_client, db_session):
    from backend.app.core.auth import get_caller_identity_if_auth_enabled
    from backend.app.core.identity import CallerIdentity
    from backend.app.main import app

    session = await create_session(async_client, db_session)
    owner = User(username="calibration-owner", role="admin", groups=[])
    other = User(username="other-calibrator", role="admin", groups=[])
    db_session.add_all([owner, other])
    await db_session.flush()
    row = await db_session.get(CalibrationSession, session["id"])
    row.owner_id = owner.id
    await db_session.commit()
    app.dependency_overrides[get_caller_identity_if_auth_enabled] = lambda: CallerIdentity.authenticated_user(other)
    try:
        path = f"/api/v1/calibration/sessions/{session['id']}"
        assert (await async_client.get(path)).status_code == 404
        assert (await async_client.get("/api/v1/calibration/sessions")).json() == []
        assert (
            await async_client.put(
                path + "/results/temperature",
                json={
                    "version": row.version,
                    "value": 210,
                },
            )
        ).status_code == 404
    finally:
        app.dependency_overrides.pop(get_caller_identity_if_auth_enabled)


async def test_api_key_cannot_read_an_anonymous_calibration_job(async_client, db_session):
    from datetime import datetime, timedelta, timezone

    from backend.app.core.auth import get_caller_identity_if_auth_enabled
    from backend.app.core.identity import CallerIdentity
    from backend.app.main import app
    from backend.app.models.api_key import APIKey
    from backend.app.models.slice_job import SliceJobRecord

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    job = SliceJobRecord(
        owner_id=None,
        source_kind="calibration_session",
        source_id=1,
        source_name="Private calibration",
        status="completed",
        created_at=now,
        expires_at=now + timedelta(hours=1),
        result={},
    )
    db_session.add(job)
    await db_session.commit()
    key = APIKey(name="Status reader", key_hash="unused", key_prefix="unused", can_read_status=True, enabled=True)
    app.dependency_overrides[get_caller_identity_if_auth_enabled] = lambda: CallerIdentity.authenticated_api_key(key)
    try:
        response = await async_client.get(f"/api/v1/slice-jobs/{job.id}")
        assert response.status_code == 403, response.text
    finally:
        app.dependency_overrides.pop(get_caller_identity_if_auth_enabled)
