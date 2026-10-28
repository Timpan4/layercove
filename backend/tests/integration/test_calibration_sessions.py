"""Calibration sessions through HTTP, including catalog copy transactions."""

from datetime import datetime, timezone

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

PLA_CONTENT = {
    "type": "filament",
    "name": "Original PLA",
    "nozzle_temperature": ["220"],
    "nozzle_temperature_initial_layer": ["220"],
    "filament_flow_ratio": ["1"],
    "pressure_advance": ["0.02"],
    "filament_retraction_length": ["0.8"],
    "filament_max_volumetric_speed": ["15"],
}


async def publish_filament(db, content):
    catalog = await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="calibration-test",
            profiles=[CatalogProfile("pla", "filament", "Original PLA", content)],
        ),
    )
    await approve_review_batch(db, catalog.review_batch_id)
    activation = await activate_revision(db, catalog.revision_ids[0])
    await db.commit()
    return activation


async def create_session(client, db, content=PLA_CONTENT):
    printer = Printer(name="Calibration machine", provider="moonraker")
    db.add(printer)
    activation = await publish_filament(db, content)
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


async def test_sessions_are_single_extruder(async_client, db_session):
    session = await create_session(async_client, db_session)
    response = await async_client.post(
        "/api/v1/calibration/sessions",
        json={
            "printer_id": session["printer_id"],
            "filament_profile_id": session["filament_profile_id"],
            "filament_revision_id": session["filament_revision_id"],
            "nozzle_diameter": 0.4,
            "tool_index": 1,
        },
    )
    assert response.status_code == 422, response.text


async def test_inherited_filament_without_its_own_maximum_keeps_parent_temperatures_available(async_client, db_session):
    # The pinned schema default (240 °C) is not the parent's value, so it must not cap the range.
    session = await create_session(async_client, db_session, {**PLA_CONTENT, "inherits": "Generic ASA"})
    response = await async_client.put(
        f"/api/v1/calibration/sessions/{session['id']}/parameters/temperature",
        json={"version": session["version"], "lowest": 240, "highest": 280, "increment": 10, "baseline": 260},
    )
    assert response.status_code == 200, response.text


async def test_a_newer_filament_revision_can_be_adopted_without_losing_results(async_client, db_session):
    session = await create_session(async_client, db_session)
    for step, value in (("temperature", 210), ("flow_rate", 0.98)):
        session = await record(async_client, session, step, value)
    newer = await publish_filament(db_session, {**PLA_CONTENT, "nozzle_temperature": ["215"]})
    assert newer.revision_id != session["filament_revision_id"]
    base = f"/api/v1/calibration/sessions/{session['id']}"
    for step, value in (("pressure_advance", 0.021), ("retraction", 0.6), ("volumetric_flow", 18)):
        session = await record(async_client, session, step, value)
    save = {"version": session["version"], "name": "Calibrated PLA", "share_local_copy": True}
    blocked = await async_client.post(base + "/save", json=save)
    assert blocked.status_code == 409, blocked.text
    adopted = await async_client.post(base + "/filament-revision", json={"version": session["version"]})
    assert adopted.status_code == 200, adopted.text
    session = adopted.json()
    assert session["filament_revision_id"] == newer.revision_id
    assert session["results"]["volumetric_flow"] == 18
    saved = await async_client.post(base + "/save", json={**save, "version": session["version"]})
    assert saved.status_code == 200, saved.text


async def test_changing_a_result_retires_later_tests_and_their_prints(async_client, db_session):
    from datetime import datetime, timezone

    from backend.app.models.library import LibraryFile
    from backend.app.models.slice_job import SliceJobRecord

    session = await create_session(async_client, db_session)
    session = await record(async_client, session, "temperature", 210)
    artifact = LibraryFile(filename="flow.gcode", file_path="library/flow.gcode", file_type="gcode", file_size=1)
    db_session.add(artifact)
    await db_session.flush()
    job = SliceJobRecord(
        source_kind="calibration_session",
        source_id=session["id"],
        source_name="flow_rate calibration",
        status="completed",
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        result_artifact_kind="library_file",
        result_artifact_id=artifact.id,
    )
    db_session.add(job)
    await db_session.flush()
    row = await db_session.get(CalibrationSession, session["id"])
    row.runs = {"flow_rate": job.id}
    # A finished print of the old test must not show as this step's print.
    row.prints = {"flow_rate": 999999}
    await db_session.commit()
    session = (await async_client.get(f"/api/v1/calibration/sessions/{session['id']}")).json()
    session = await record(async_client, session, "temperature", 215)
    assert session["runs"] == {}
    assert session["prints"] == {}
    await db_session.refresh(artifact)
    assert artifact.deleted_at is not None


async def test_deleting_a_session_removes_its_photos(async_client, db_session, tmp_path, monkeypatch):
    import io

    from PIL import Image

    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    session = await create_session(async_client, db_session)
    photo = io.BytesIO()
    Image.new("RGB", (8, 8), "orange").save(photo, format="PNG")
    base = f"/api/v1/calibration/sessions/{session['id']}"
    uploaded = await async_client.post(
        base + "/evidence/temperature", files={"file": ("photo.png", photo.getvalue(), "image/png")}
    )
    assert uploaded.status_code == 201, uploaded.text
    assert (tmp_path / "calibration" / str(session["id"])).is_dir()
    deleted = await async_client.delete(base)
    assert deleted.status_code == 204, deleted.text
    assert (await async_client.get(base)).status_code == 404
    assert not (tmp_path / "calibration" / str(session["id"])).exists()


async def test_generating_a_test_taller_than_the_printer_profile_is_refused(async_client, db_session):
    from backend.app.models.slicer_profile_catalog import PrinterSlicerBinding

    session = await create_session(async_client, db_session)
    session = await record(async_client, session, "temperature", 215)
    session = await record(async_client, session, "flow_rate", 0.98)
    catalog = await ingest_catalog(
        db_session,
        CatalogInput(
            source="standard",
            remote_account_id="calibration-printer",
            profiles=[
                CatalogProfile("p1s", "printer", "Short printer", {"type": "machine", "printable_height": "100"}),
                CatalogProfile("standard", "process", "Standard", {"type": "process"}),
            ],
        ),
    )
    await approve_review_batch(db_session, catalog.review_batch_id)
    printer, process = [await activate_revision(db_session, revision_id) for revision_id in catalog.revision_ids]
    binding = PrinterSlicerBinding(
        printer_id=session["printer_id"], profile_id=printer.profile_id, expected_nozzle_diameter=0.4
    )
    db_session.add(binding)
    await db_session.commit()
    base = f"/api/v1/calibration/sessions/{session['id']}"
    # 151 pressure advance bands of 1 mm.
    saved = await async_client.put(
        base + "/parameters/pressure_advance",
        json={"version": session["version"], "lowest": 0, "highest": 0.15, "increment": 0.001, "baseline": 0.02},
    )
    assert saved.status_code == 200, saved.text
    generated = await async_client.post(
        base + "/generate/pressure_advance",
        json={"version": saved.json()["version"], "binding_id": binding.id, "process_profile_id": process.profile_id},
    )
    assert generated.status_code == 409, generated.text
    assert "the printer profile allows 100 mm" in generated.json()["detail"]


@pytest.mark.parametrize(
    "step,lowest,highest,increment,fits",
    [
        ("pressure_advance", 0, 0.2, 0.001, False),
        ("pressure_advance", 0, 0.1, 0.002, True),
        ("temperature", 200, 260, 5, True),
        ("temperature", 180, 280, 5, False),
        ("flow_rate", 0.5, 1.5, 0.001, True),
    ],
)
def test_tests_taller_than_the_printer_profile_are_rejected(step, lowest, highest, increment, fits):
    from decimal import Decimal
    from types import SimpleNamespace

    from fastapi import HTTPException

    from backend.app.api.routes.calibration import Step, require_printable_height

    session = SimpleNamespace(
        nozzle_diameter=Decimal("0.4"),
        parameters={step: {"lowest": lowest, "highest": highest, "increment": increment, "baseline": lowest}},
    )
    printer = {"printable_height": "180"}
    if fits:
        require_printable_height(session, Step(step), printer)
    else:
        with pytest.raises(HTTPException) as error:
            require_printable_height(session, Step(step), printer)
        assert error.value.status_code == 409
    # Without a usable height in the profile, the slicer stays the authority.
    require_printable_height(session, Step(step), {})


async def test_deleting_a_printer_removes_its_calibration_photos(async_client, db_session, tmp_path, monkeypatch):
    import io

    from PIL import Image

    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    session = await create_session(async_client, db_session)
    photo = io.BytesIO()
    Image.new("RGB", (8, 8), "orange").save(photo, format="PNG")
    uploaded = await async_client.post(
        f"/api/v1/calibration/sessions/{session['id']}/evidence/temperature",
        files={"file": ("photo.png", photo.getvalue(), "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.text
    deleted = await async_client.delete(f"/api/v1/printers/{session['printer_id']}")
    assert deleted.status_code == 200, deleted.text
    assert not (tmp_path / "calibration" / str(session["id"])).exists()
    assert await db_session.get(CalibrationSession, session["id"]) is None


async def add_generated_test(db_session, session_id: int, status: str = "completed"):
    from backend.app.models.library import LibraryFile
    from backend.app.models.slice_job import SliceJobRecord

    artifact = LibraryFile(filename="temp.gcode", file_path="library/temp.gcode", file_type="gcode", file_size=1)
    db_session.add(artifact)
    await db_session.flush()
    job = SliceJobRecord(
        source_kind="calibration_session",
        source_id=session_id,
        source_name="temperature calibration",
        status=status,
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        result_artifact_kind="library_file",
        result_artifact_id=artifact.id,
    )
    db_session.add(job)
    await db_session.flush()
    row = await db_session.get(CalibrationSession, session_id)
    row.runs = {"temperature": job.id}
    await db_session.commit()
    return artifact


# Failure mode: the database forgets the session while its private photos stay on disk
# with no record left to retry the deletion from.
@pytest.mark.parametrize("target", ["session", "printer"])
async def test_photos_that_cannot_be_removed_keep_the_session(async_client, db_session, tmp_path, monkeypatch, target):
    import io
    import shutil

    from PIL import Image

    from backend.app.core.config import settings

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    session = await create_session(async_client, db_session)
    photo = io.BytesIO()
    Image.new("RGB", (8, 8), "orange").save(photo, format="PNG")
    base = f"/api/v1/calibration/sessions/{session['id']}"
    uploaded = await async_client.post(
        base + "/evidence/temperature", files={"file": ("photo.png", photo.getvalue(), "image/png")}
    )
    assert uploaded.status_code == 201, uploaded.text

    def refuse(path, *args, **kwargs):
        raise PermissionError(13, "Permission denied", str(path))

    monkeypatch.setattr(shutil, "rmtree", refuse)
    url = base if target == "session" else f"/api/v1/printers/{session['printer_id']}"
    deleted = await async_client.delete(url)
    assert deleted.status_code == 500, deleted.text
    db_session.expire_all()
    assert await db_session.get(CalibrationSession, session["id"]) is not None


# Failure mode: deleting a printer leaves its generated calibration tests in the library,
# or forgets a session whose test is still being generated.
async def test_deleting_a_printer_retires_its_generated_tests(async_client, db_session):
    from backend.app.models.print_queue import PrintQueueItem

    session = await create_session(async_client, db_session)
    artifact = await add_generated_test(db_session, session["id"])
    # The printer's own queue goes with it, so its pending print must not keep the file.
    db_session.add(PrintQueueItem(printer_id=session["printer_id"], library_file_id=artifact.id, status="pending"))
    await db_session.commit()
    deleted = await async_client.delete(f"/api/v1/printers/{session['printer_id']}")
    assert deleted.status_code == 200, deleted.text
    await db_session.refresh(artifact)
    assert artifact.deleted_at is not None


# Failure mode: deleting a user cascades their private sessions away but leaves the photos on
# disk and the generated tests in the library, with no session left to clean them up from.
async def test_deleting_a_user_removes_their_calibration_photos_and_tests(
    async_client, db_session, tmp_path, monkeypatch
):
    import io

    from PIL import Image

    from backend.app.core.config import settings
    from backend.app.models.calibration import CalibrationEvidence

    monkeypatch.setattr(settings, "base_dir", tmp_path)
    session = await create_session(async_client, db_session)
    photo = io.BytesIO()
    Image.new("RGB", (8, 8), "orange").save(photo, format="PNG")
    uploaded = await async_client.post(
        f"/api/v1/calibration/sessions/{session['id']}/evidence/temperature",
        files={"file": ("photo.png", photo.getvalue(), "image/png")},
    )
    assert uploaded.status_code == 201, uploaded.text
    artifact = await add_generated_test(db_session, session["id"])
    artifact_type, artifact_id = type(artifact), artifact.id
    owner = User(username="calibrating-user")
    db_session.add(owner)
    await db_session.flush()
    (await db_session.get(CalibrationSession, session["id"])).owner_id = owner.id
    await db_session.commit()

    deleted = await async_client.delete(f"/api/v1/users/{owner.id}")

    assert deleted.status_code == 204, deleted.text
    assert not (tmp_path / "calibration" / str(session["id"])).exists()
    db_session.expire_all()
    assert await db_session.get(CalibrationSession, session["id"]) is None
    assert await db_session.scalar(select(CalibrationEvidence.id)) is None
    assert (await db_session.get(artifact_type, artifact_id)).deleted_at is not None


# Failure mode: a deleted user's private copies stay active with no owner, and appear for
# everyone once authentication is turned off.
# Failure mode: retired copies of a deleted user stayed listed with include_inactive once
# authentication was turned off, because their account had no owner left.
async def test_deleting_a_user_deletes_their_private_copies(async_client, db_session):
    from backend.app.api.routes.slicer_catalog import list_catalog_profiles
    from backend.app.models.slicer_profile_catalog import SlicerProfile, SlicerProfileRevision
    from backend.app.services.filament_edit import FilamentCopyRequest, copy_filament_profile

    activation = await publish_filament(db_session, PLA_CONTENT)
    original_id = activation.profile_id
    owner = User(username="private-copier")
    db_session.add(owner)
    await db_session.commit()
    owner_id = owner.id
    copy = await copy_filament_profile(
        db_session,
        activation.profile_id,
        FilamentCopyRequest(base_revision_id=activation.revision_id, name="Mine"),
        owner_id,
    )
    await db_session.commit()

    deleted = await async_client.delete(f"/api/v1/users/{owner_id}")

    assert deleted.status_code == 204, deleted.text
    db_session.expire_all()
    assert await db_session.get(SlicerProfile, copy["profile_id"]) is None
    assert await db_session.get(SlicerProfileRevision, copy["revision_id"]) is None
    listed = await list_catalog_profiles(db_session, None, include_inactive=True)
    assert copy["profile_id"] not in {profile["profile_id"] for profile in listed}
    # The original stays active.
    assert (
        await db_session.scalar(
            select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == original_id)
        )
    ) is not None


async def test_a_user_with_a_test_still_generating_is_kept(async_client, db_session):
    session = await create_session(async_client, db_session)
    await add_generated_test(db_session, session["id"], status="running")
    owner = User(username="generating-user")
    db_session.add(owner)
    await db_session.flush()
    owner_id = owner.id
    (await db_session.get(CalibrationSession, session["id"])).owner_id = owner_id
    await db_session.commit()

    deleted = await async_client.delete(f"/api/v1/users/{owner_id}")

    assert deleted.status_code == 409, deleted.text
    db_session.expire_all()
    assert await db_session.get(User, owner_id) is not None
    assert await db_session.get(CalibrationSession, session["id"]) is not None


async def test_a_printer_with_a_test_still_generating_is_kept(async_client, db_session):
    session = await create_session(async_client, db_session)
    await add_generated_test(db_session, session["id"], status="running")
    deleted = await async_client.delete(f"/api/v1/printers/{session['printer_id']}")
    assert deleted.status_code == 409, deleted.text
    db_session.expire_all()
    assert await db_session.get(CalibrationSession, session["id"]) is not None
