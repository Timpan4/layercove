"""Versioned edits through HTTP and the real catalog transaction/visibility logic."""

import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select

from backend.app.models.local_preset import LocalPreset
from backend.app.models.printer import Printer
from backend.app.models.slicer_profile_catalog import (
    SlicerCompatibilityMapping,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileRevision,
)
from backend.app.models.user import User
from backend.app.services.filament_edit import FilamentCopyRequest, copy_filament_profile
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
    ingest_catalog,
)
from backend.app.services.slicer_catalog_sync import sync_local_catalog


async def seed(db, source="standard", user_id=None):
    content = {
        "type": "filament",
        "name": "Original",
        "nozzle_temperature": ["220"],
        "filament_flow_ratio": ["0.98"],
        "compatible_printers": ["Machine"],
    }
    result = await ingest_catalog(
        db,
        CatalogInput(
            source=source,
            remote_account_id="edit-test",
            user_id=user_id,
            profiles=[CatalogProfile("filament", "filament", "Original", content)],
        ),
    )
    await approve_review_batch(db, result.review_batch_id)
    activation = await activate_revision(db, result.revision_ids[0])
    await db.commit()
    return SimpleNamespace(
        profile=activation.profile_id, revision=activation.revision_id, account=result.account_id, content=content
    )


def payload(revision):
    return {
        "base_revision_id": revision,
        "name": "Edited",
        "share_local_copy": True,
        "overrides": {"nozzle_temperature": ["235"], "filament_flow_ratio": ["1.02"]},
    }


@pytest.mark.parametrize("source", ["standard", "local", "cloud", "orca_cloud"])
async def test_copy_is_immediately_active_immutable_and_survives_local_sync(async_client, db_session, source):
    original = await seed(db_session, source)
    printer = Printer(name="Machine", provider="moonraker")
    db_session.add(printer)
    await db_session.flush()
    db_session.add(SlicerCompatibilityMapping(profile_id=original.profile, printer_id=printer.id))
    await db_session.commit()
    # A pending unrelated local edit must not be approved/rejected by saving the copy.
    pending = await ingest_catalog(
        db_session,
        CatalogInput(
            source="local",
            remote_account_id="installation",
            profiles=[CatalogProfile("unrelated", "process", "Unrelated", {"type": "process"})],
        ),
    )
    await db_session.commit()
    response = await async_client.post(
        f"/api/v1/slicer/catalog/profiles/{original.profile}/filament-copy", json=payload(original.revision)
    )
    assert response.status_code == 201, response.text
    result = response.json()
    assert result["profile_id"] != original.profile
    old = await db_session.get(SlicerProfileRevision, original.revision)
    assert old.content == original.content
    revision = await db_session.get(SlicerProfileRevision, result["revision_id"])
    assert revision.content["nozzle_temperature"] == ["235"]
    assert revision.content["compatible_printers"] == ["Machine"]
    assert revision.review_state == "approved"
    active = await db_session.scalar(
        select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == result["profile_id"])
    )
    assert active.revision_id == revision.id
    assert (await db_session.get(SlicerProfileRevision, pending.revision_ids[0])).review_state == "pending"
    assert list(
        await db_session.scalars(
            select(SlicerCompatibilityMapping.printer_id).where(
                SlicerCompatibilityMapping.profile_id == result["profile_id"]
            )
        )
    ) == [printer.id]
    local = await db_session.get(LocalPreset, result["local_preset_id"])
    assert json.loads(local.setting) == revision.content
    await sync_local_catalog(db_session, protect_references=False)
    assert (
        await db_session.scalar(
            select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == result["profile_id"])
        )
    ).revision_id == revision.id


async def test_private_copy_requires_visibility_and_explicit_sharing_consent(db_session):
    owner, other = User(username="owner"), User(username="other")
    db_session.add_all([owner, other])
    await db_session.commit()
    source = await seed(db_session, "orca_cloud", owner.id)
    body = FilamentCopyRequest(**payload(source.revision))
    with pytest.raises(HTTPException) as denied:
        await copy_filament_profile(db_session, source.profile, body, other.id)
    assert denied.value.status_code == 404
    body.share_local_copy = False
    with pytest.raises(HTTPException) as consent:
        await copy_filament_profile(db_session, source.profile, body, owner.id)
    assert consent.value.status_code == 400
    assert await db_session.scalar(select(func.count(LocalPreset.id))) == 0


@pytest.mark.parametrize("kind", ["changed", "frozen", "consent", "identity", "credential"])
async def test_rejected_edits_write_nothing(async_client, db_session, kind):
    source = await seed(db_session)
    body = payload(source.revision)
    if kind == "changed":
        body["base_revision_id"] += 999
    if kind == "frozen":
        (await db_session.get(SlicerProfileAccount, source.account)).sync_frozen = True
        await db_session.commit()
    if kind == "consent":
        body["share_local_copy"] = False
    if kind == "identity":
        body["overrides"] = {"compatible_printers": ["Another"]}
    if kind == "credential":
        body["overrides"] = {"access_token": "never-store-this"}
    response = await async_client.post(f"/api/v1/slicer/catalog/profiles/{source.profile}/filament-copy", json=body)
    assert response.status_code in {400, 409, 422}, response.text
    assert "never-store-this" not in response.text
    assert await db_session.scalar(select(func.count(LocalPreset.id))) == 0


async def test_read_only_user_cannot_save_shared_filament(async_client, db_session):
    from backend.app.core.auth import create_access_token
    from backend.app.models.group import Group
    from backend.app.models.settings import Settings

    source = await seed(db_session)
    group = Group(name="Filament readers", permissions=["printers:read"])
    user = User(username="filament-reader", is_active=True, groups=[group])
    db_session.add_all([user, Settings(key="auth_enabled", value="true")])
    await db_session.commit()
    token = create_access_token(data={"sub": user.username})
    response = await async_client.post(
        f"/api/v1/slicer/catalog/profiles/{source.profile}/filament-copy",
        json=payload(source.revision),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403, response.text
    assert await db_session.scalar(select(func.count(LocalPreset.id))) == 0


@pytest.mark.parametrize("source", ["standard", "orca_cloud"])
async def test_copy_has_sidecar_identity_and_keeps_resolved_standard_values(async_client, db_session, source):
    content = {"nozzle_temperature": ["220"], "filament_flow_ratio": ["0.98"]}
    if source == "standard":
        content["inherits"] = "fdm_filament_common"  # Already resolved bundled snapshot.
    result = await ingest_catalog(
        db_session,
        CatalogInput(
            source=source,
            remote_account_id="resolved-edit",
            profiles=[
                CatalogProfile("resolved", "filament", "Resolved filament", content),
            ],
        ),
    )
    await approve_review_batch(db_session, result.review_batch_id)
    activation = await activate_revision(db_session, result.revision_ids[0])
    await db_session.commit()
    response = await async_client.post(
        f"/api/v1/slicer/catalog/profiles/{activation.profile_id}/filament-copy",
        json=payload(activation.revision_id),
    )
    assert response.status_code == 201, response.text
    copy = await db_session.get(LocalPreset, response.json()["local_preset_id"])
    setting = json.loads(copy.setting)
    assert setting["type"] == "filament"
    assert setting["name"] == "Edited"
    assert setting["setting_id"]
    assert setting["from"] == "system"
    assert "inherits" not in setting
    assert setting["nozzle_temperature"] == ["235"]
    assert (await db_session.get(SlicerProfileRevision, activation.revision_id)).content == content
