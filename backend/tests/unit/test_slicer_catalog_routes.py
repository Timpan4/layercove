"""Catalog API visibility and consent tests."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

import backend.app.api.routes.slicer_catalog as catalog_routes
import backend.app.models  # noqa: F401
from backend.app.api.routes.slicer_catalog import (
    ReviewRequest,
    SharingRequest,
    freeze_catalog_account,
    list_catalog_profile_revisions,
    list_catalog_profiles,
    list_review_batches,
    resume_catalog_account,
    review_batch,
    set_account_sharing,
    sync_cloud_catalog,
    sync_standard_catalog,
)
from backend.app.core.database import Base
from backend.app.core.permissions import Permission
from backend.app.models.group import Group
from backend.app.models.slice_job import SliceJobRecord  # noqa: F401
from backend.app.models.slicer_profile_catalog import SlicerProfileRevision
from backend.app.models.user import User
from backend.app.schemas.slicer_presets import UnifiedPreset
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
    canonical_hash,
    ingest_catalog,
)


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def test_private_account_visibility_requires_owner_consent(db):
    owner = User(username="owner", role="admin")
    outsider = User(username="outsider")
    db.add_all([owner, outsider])
    await db.commit()
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="orca_cloud",
            remote_account_id="orca-owner",
            user_id=owner.id,
            profiles=[CatalogProfile("p", "process", "Private", {"type": "print"})],
        ),
    )
    await approve_review_batch(db, result.review_batch_id, owner.id)
    await activate_revision(db, result.revision_ids[0], owner.id)
    await db.commit()

    assert len(await list_catalog_profiles(db, owner)) == 1
    assert await list_catalog_profiles(db, outsider) == []
    with pytest.raises(HTTPException) as forbidden:
        await set_account_sharing(result.account_id, SharingRequest(shared=True), db, outsider)
    assert forbidden.value.status_code == 403

    await set_account_sharing(result.account_id, SharingRequest(shared=True), db, owner)

    assert len(await list_catalog_profiles(db, outsider)) == 1


async def test_sharing_requires_source_specific_cloud_permission(db):
    cloud_group = Group(name="Cloud only", permissions=[Permission.CLOUD_AUTH.value])
    owner = User(username="source-owner", groups=[cloud_group])
    db.add(owner)
    await db.commit()
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="orca_cloud",
            remote_account_id="orca-source-owner",
            user_id=owner.id,
            profiles=[CatalogProfile("p", "process", "Private", {"type": "print"})],
        ),
    )
    await db.commit()
    await db.refresh(owner, ["groups"])

    with pytest.raises(HTTPException) as forbidden:
        await set_account_sharing(result.account_id, SharingRequest(shared=True), db, owner)

    assert forbidden.value.status_code == 403
    assert forbidden.value.detail == "Missing required permission: orca_cloud:auth"


async def test_cloud_sync_uses_private_owner_namespace(db, monkeypatch):
    user = User(username="cloud-owner", cloud_email="owner@example.com")
    db.add(user)
    await db.commit()
    monkeypatch.setattr(
        catalog_routes,
        "_fetch_cloud_presets",
        AsyncMock(
            return_value=(
                {
                    "printer": [],
                    "process": [UnifiedPreset(id="cloud-process", name="Cloud process", source="cloud")],
                    "filament": [],
                },
                "ok",
            )
        ),
    )

    token = AsyncMock(return_value=("token", "owner@example.com", "global"))
    monkeypatch.setattr(catalog_routes, "get_stored_token", token)

    result = await sync_cloud_catalog(db, user)

    account = await db.get(catalog_routes.SlicerProfileAccount, result["account_id"])
    assert account.remote_account_id == "global:owner@example.com"
    assert account.user_id == user.id
    assert account.sharing_state == "private"

    token.return_value = ("token", "other@example.com", "global")
    second = await sync_cloud_catalog(db, user)
    other = await db.get(catalog_routes.SlicerProfileAccount, second["account_id"])
    assert other.id != account.id
    assert other.remote_account_id == "global:other@example.com"


async def test_freeze_blocks_remote_cloud_pull_until_resumed(db, monkeypatch):
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="cloud",
            remote_account_id="global:owner@example.com",
            profiles=[CatalogProfile("process", "process", "Process", {})],
        ),
    )
    await db.commit()
    frozen = await freeze_catalog_account(result.account_id, db, None)
    assert frozen == {"id": result.account_id, "stale": True, "sync_frozen": True}

    fetch = AsyncMock()
    monkeypatch.setattr(catalog_routes, "_fetch_cloud_presets", fetch)
    monkeypatch.setattr(
        catalog_routes,
        "get_stored_token",
        AsyncMock(return_value=("token", "owner@example.com", "global")),
    )
    with pytest.raises(HTTPException) as blocked:
        await sync_cloud_catalog(db, None)
    assert blocked.value.status_code == 409
    fetch.assert_not_awaited()

    resumed = await resume_catalog_account(result.account_id, db, None)
    assert resumed == {"id": result.account_id, "stale": True, "sync_frozen": False}


async def test_standard_sync_reads_full_sidecar_snapshot_into_mirror(db, monkeypatch):
    content = {"type": "print", "compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]}
    service = MagicMock()
    service.list_bundled_profiles = AsyncMock(
        return_value={
            "process": [
                {
                    "stable_id": "process:BBL:p1s-process",
                    "name": "P1S process",
                    "content": content,
                    "content_hash": canonical_hash(content),
                }
            ]
        }
    )
    service.__aenter__ = AsyncMock(return_value=service)
    service.__aexit__ = AsyncMock(return_value=None)
    monkeypatch.setattr(catalog_routes, "_resolve_slicer_api_url", AsyncMock(return_value="http://sidecar"))
    monkeypatch.setattr(catalog_routes, "SlicerApiService", MagicMock(return_value=service))

    result = await sync_standard_catalog(db, None)

    revision = await db.get(SlicerProfileRevision, result["revision_ids"][0])
    assert revision.content == content
    assert revision.resolved_metadata["metadata"]["compatible_printers"] == ["Bambu Lab P1S 0.4 nozzle"]


async def test_management_listing_and_revision_history_show_lifecycle_state(db):
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="standard",
            profiles=[CatalogProfile("pending", "process", "Pending", {"version": 1})],
        ),
    )
    await db.commit()

    assert await list_catalog_profiles(db, None) == []
    pending = await list_catalog_profiles(db, None, True)
    assert pending[0]["review_state"] == "pending"
    assert pending[0]["active"] is False
    assert pending[0]["active_revision_id"] is None
    profile_id = pending[0]["profile_id"]

    await approve_review_batch(db, result.review_batch_id)
    approved = await list_catalog_profiles(db, None, True)
    assert approved[0]["review_state"] == "approved"
    assert approved[0]["active"] is False
    await activate_revision(db, result.revision_ids[0])
    second = await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="standard",
            profiles=[CatalogProfile("pending", "process", "Pending", {"version": 2})],
        ),
    )
    await db.commit()

    history = await list_catalog_profile_revisions(profile_id, db, None)
    assert [item["id"] for item in history] == list(result.revision_ids + second.revision_ids)
    assert history[0]["active"] is True
    assert [event["action"] for event in history[0]["activations"]] == ["activate"]
    assert history[1]["active"] is False

    latest = (await list_catalog_profiles(db, None, True))[0]
    assert latest["latest_revision_id"] == second.revision_ids[0]
    assert latest["active_revision_id"] == result.revision_ids[0]
    assert latest["active"] is True
    assert latest["review_state"] == "pending"


async def test_review_route_approves_only_selected_revisions(db):
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="selective-review",
            profiles=[
                CatalogProfile("keep", "process", "Keep", {"version": 1}),
                CatalogProfile("reject", "process", "Reject", {"version": 1}),
            ],
        ),
    )
    await db.commit()

    batches = await list_review_batches(result.account_id, db, None)
    assert batches[0]["revisions"] == [
        {"id": result.revision_ids[0], "profile_id": 1, "display_name": "Keep"},
        {"id": result.revision_ids[1], "profile_id": 2, "display_name": "Reject"},
    ]

    await review_batch(
        result.review_batch_id,
        ReviewRequest(approved=True, revision_ids=[result.revision_ids[0]]),
        db,
        None,
    )

    assert (await db.get(SlicerProfileRevision, result.revision_ids[0])).review_state == "approved"
    assert (await db.get(SlicerProfileRevision, result.revision_ids[1])).review_state == "rejected"


async def test_completed_review_batch_cannot_rewrite_revision_state(db):
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="immutable-review",
            profiles=[CatalogProfile("process", "process", "Process", {"version": 1})],
        ),
    )
    await db.commit()
    await review_batch(result.review_batch_id, ReviewRequest(approved=True), db, None)

    with pytest.raises(HTTPException) as repeated:
        await review_batch(result.review_batch_id, ReviewRequest(approved=False), db, None)

    assert repeated.value.status_code == 409
    revision = await db.get(SlicerProfileRevision, result.revision_ids[0])
    assert revision.review_state == "approved"
