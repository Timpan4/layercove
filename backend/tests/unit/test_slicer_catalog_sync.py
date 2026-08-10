"""Focused tests for catalog source adapters and Orca mirror sync."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

import backend.app.models  # noqa: F401
from backend.app.core.database import Base
from backend.app.models.slice_job import SliceJobRecord  # noqa: F401
from backend.app.models.slicer_profile_catalog import (
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileRevision,
)
from backend.app.services.orca_cloud import OrcaCloudError, OrcaProfilePull
from backend.app.services.slicer_catalog import activate_revision, approve_review_batch
from backend.app.services.slicer_catalog_sync import (
    cloud_profile_adapter,
    orca_profile_adapter,
    resolve_profile_inheritance,
    standard_profile_adapter,
    sync_cloud_account,
    sync_orca_account,
    sync_standard_account,
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


def orca_entry(profile_id: str = "p", value: int = 1):
    return {
        "id": profile_id,
        "name": "Process",
        "updated_time": value,
        "content": {"type": "print", "value": value, "compatible_printers": ["P1S"]},
    }


def service_with(*pulls):
    service = MagicMock()
    service.pull_profiles = AsyncMock(side_effect=pulls)
    return service


def standard_entry(stable_id: str, value: int = 1, compatible=None):
    content = {"type": "print", "value": value, "compatible_printers": compatible or ["Authoritative"]}
    from backend.app.services.slicer_catalog import canonical_hash

    return {
        "stable_id": stable_id,
        "name": f"Standard {stable_id}",
        "content": content,
        "content_hash": canonical_hash(content),
    }


async def test_cloud_full_snapshot_is_namespaced_private_and_unclassified(db):
    first = await sync_cloud_account(
        db,
        {"process": [{"id": "same", "name": "Cloud process"}]},
        remote_account_id="layercove-user:1",
        display_name="one@example.com",
        user_id=None,
    )
    second = await sync_cloud_account(
        db,
        {"process": [{"id": "same", "name": "Cloud process"}]},
        remote_account_id="layercove-user:2",
        display_name="two@example.com",
        user_id=None,
    )
    accounts = (await db.scalars(select(SlicerProfileAccount).where(SlicerProfileAccount.source == "cloud"))).all()
    revisions = (await db.scalars(select(SlicerProfileRevision))).all()
    assert first.account_id != second.account_id
    assert {account.sharing_state for account in accounts} == {"private"}
    assert all(revision.resolved_metadata["metadata"]["compatible_printers"] is None for revision in revisions)

    await sync_cloud_account(
        db,
        {"process": []},
        remote_account_id="layercove-user:1",
        display_name="one@example.com",
        user_id=None,
    )
    profile = await db.scalar(select(SlicerProfile).where(SlicerProfile.account_id == first.account_id))
    assert profile.tombstoned_at is not None


async def test_standard_full_snapshot_preserves_content_and_authority(db):
    result = await sync_standard_account(db, {"process": [standard_entry("std-p")]})
    revision = await db.get(SlicerProfileRevision, result.revision_ids[0])
    profile = await db.get(SlicerProfile, revision.profile_id)
    account = await db.get(SlicerProfileAccount, result.account_id)
    assert revision.content["value"] == 1
    assert revision.resolved_metadata["metadata"]["compatible_printers"] == ["Authoritative"]
    assert account.remote_account_id == "bundled"
    assert profile.remote_profile_id == "std-p"


async def test_standard_snapshot_is_idempotent_and_tombstones_missing_profiles(db):
    first = await sync_standard_account(db, {"process": [standard_entry("keep"), standard_entry("gone")]})
    second = await sync_standard_account(db, {"process": [standard_entry("keep")]})
    replay = await sync_standard_account(db, {"process": [standard_entry("keep")]})
    profiles = (await db.scalars(select(SlicerProfile).where(SlicerProfile.account_id == first.account_id))).all()
    gone = next(profile for profile in profiles if profile.remote_profile_id == "gone")
    assert second.account_id == first.account_id == replay.account_id
    assert second.cursor == replay.cursor
    assert gone.tombstoned_at is not None
    assert replay.review_batch_id is None


async def test_standard_snapshot_keeps_active_revision_pending_rules(db):
    first = await sync_standard_account(db, {"process": [standard_entry("std-p", 1)]})
    await approve_review_batch(db, first.review_batch_id)
    await activate_revision(db, first.revision_ids[0])
    await db.commit()
    second = await sync_standard_account(db, {"process": [standard_entry("std-p", 2)]})
    revisions = (
        await db.scalars(
            select(SlicerProfileRevision).where(SlicerProfileRevision.profile_id == (await db.get(SlicerProfile, 1)).id)
        )
    ).all()
    assert second.revision_ids
    assert revisions[-1].review_state == "pending"


def test_orca_inheritance_resolves_compatibility_and_full_content():
    parent = orca_profile_adapter(
        {
            "id": "parent-id",
            "name": "Dremel parent",
            "content": {
                "type": "print",
                "compatible_printers": ["Dremel 3D40"],
                "layer_height": "0.20",
            },
        }
    )
    child = orca_profile_adapter(
        {
            "id": "child-id",
            "name": "Child",
            "content": {"type": "print", "inherits": "Dremel parent", "layer_height": "0.16"},
        }
    )

    resolved = resolve_profile_inheritance([parent, child])
    resolved_child = next(profile for profile in resolved if profile.remote_profile_id == "child-id")

    assert resolved_child.metadata["compatible_printers"] == ["Dremel 3D40"]
    assert resolved_child.metadata["source_inherits"] == "parent-id"
    assert resolved_child.content["layer_height"] == "0.16"
    assert "inherits" not in resolved_child.content


def test_source_adapters_preserve_authority_without_name_inference():
    orca = orca_profile_adapter(orca_entry())
    cloud = cloud_profile_adapter("process", {"id": "c", "name": "Named like P1S"})
    assert orca.metadata["compatible_printers"] == ["P1S"]
    assert cloud.metadata["compatible_printers"] is None

    with pytest.raises(ValueError, match="stable_id or content_hash"):
        standard_profile_adapter("process", {"name": "display-only stub", "base_id": "base"})


def test_cloud_adapter_rejects_oversized_identity_and_name():
    with pytest.raises(ValueError, match="id exceeds catalog limit"):
        cloud_profile_adapter("process", {"id": "x" * 513, "name": "Process"})
    with pytest.raises(ValueError, match="name exceeds catalog limit"):
        cloud_profile_adapter("process", {"id": "process", "name": "x" * 513})


def test_source_adapter_rejects_credentials_in_untrusted_profile():
    with pytest.raises(ValueError, match="forbidden credential"):
        orca_profile_adapter(
            {"id": "p", "name": "P", "content": {"type": "print", "refresh_token": "must-not-persist"}}
        )
    with pytest.raises(ValueError, match="forbidden credential"):
        standard_profile_adapter(
            "process",
            {"stable_id": "p", "content": {"type": "print", "api_key": "must-not-persist"}},
        )


def orca_inherited_entries(parent_compatibility: str = "P1S", child_value: int = 1):
    return [
        {
            "id": "parent",
            "name": "Parent",
            "updated_time": parent_compatibility,
            "content": {
                "type": "print",
                "compatible_printers": [parent_compatibility],
                "parent_value": parent_compatibility,
            },
        },
        {
            "id": "child",
            "name": "Child",
            "updated_time": child_value,
            "content": {
                "type": "print",
                "inherits": "Parent",
                "child_value": child_value,
            },
        },
    ]


async def test_orca_incremental_parent_update_revises_inherited_child(db):
    initial = orca_inherited_entries()
    parent_update = orca_inherited_entries("Voron")[0]
    service = service_with(
        OrcaProfilePull("10", initial, [], True),
        OrcaProfilePull("11", [parent_update], [], False),
    )
    first = await sync_orca_account(
        db,
        service,
        remote_account_id="orca-inheritance",
        display_name="Inheritance",
        user_id=None,
    )

    second = await sync_orca_account(
        db,
        service,
        remote_account_id="orca-inheritance",
        display_name="Inheritance",
        user_id=None,
    )

    child = await db.scalar(
        select(SlicerProfile).where(
            SlicerProfile.account_id == first.account_id,
            SlicerProfile.remote_profile_id == "child",
        )
    )
    child_revision = await db.scalar(
        select(SlicerProfileRevision)
        .where(SlicerProfileRevision.profile_id == child.id)
        .order_by(SlicerProfileRevision.id.desc())
    )
    assert child_revision.id in second.revision_ids
    assert child_revision.content["parent_value"] == "Voron"
    assert child_revision.resolved_metadata["metadata"]["compatible_printers"] == ["Voron"]


async def test_orca_sync_resumes_cursor_and_tombstones_delete(db):
    service = service_with(
        OrcaProfilePull("10", [orca_entry()], [], True),
        OrcaProfilePull("11", [], ["p"], False),
    )
    first = await sync_orca_account(
        db,
        service,
        remote_account_id="orca-a",
        display_name="A",
        user_id=None,
    )
    await sync_orca_account(
        db,
        service,
        remote_account_id="orca-a",
        display_name="A",
        user_id=None,
    )

    account = await db.get(SlicerProfileAccount, first.account_id)
    profile = await db.scalar(select(SlicerProfile).where(SlicerProfile.account_id == account.id))
    assert account.sync_cursor == "11"
    assert profile.tombstoned_at is not None
    assert service.pull_profiles.await_args_list[1].args == ("10",)


async def test_orca_full_snapshot_tombstones_profiles_missing_without_delete_events(db):
    service = service_with(
        OrcaProfilePull("10", [orca_entry("keep"), orca_entry("gone")], [], True),
        OrcaProfilePull("11", [orca_entry("keep")], [], True),
    )
    first = await sync_orca_account(
        db,
        service,
        remote_account_id="orca-full",
        display_name="Full",
        user_id=None,
    )

    await sync_orca_account(
        db,
        service,
        remote_account_id="orca-full",
        display_name="Full",
        user_id=None,
    )

    gone = await db.scalar(
        select(SlicerProfile).where(
            SlicerProfile.account_id == first.account_id,
            SlicerProfile.remote_profile_id == "gone",
        )
    )
    assert gone.tombstoned_at is not None


async def test_frozen_orca_account_rejects_later_sync(db):
    service = service_with(OrcaProfilePull("10", [orca_entry()], [], True))
    result = await sync_orca_account(
        db,
        service,
        remote_account_id="orca-frozen",
        display_name="Frozen",
        user_id=None,
    )
    account = await db.get(SlicerProfileAccount, result.account_id)
    account.sync_frozen = True
    await db.commit()
    service.pull_profiles.reset_mock()

    with pytest.raises(ValueError, match="frozen"):
        await sync_orca_account(
            db,
            service,
            remote_account_id="orca-frozen",
            display_name="Frozen",
            user_id=None,
        )

    service.pull_profiles.assert_not_awaited()


async def test_orca_outage_freezes_active_mirror(db):
    service = service_with(OrcaProfilePull("10", [orca_entry()], [], True))
    result = await sync_orca_account(
        db,
        service,
        remote_account_id="orca-a",
        display_name="A",
        user_id=None,
    )
    await approve_review_batch(db, result.review_batch_id)
    await activate_revision(db, result.revision_ids[0])
    await db.commit()

    service.pull_profiles = AsyncMock(side_effect=OrcaCloudError("offline"))
    with pytest.raises(OrcaCloudError, match="offline"):
        await sync_orca_account(
            db,
            service,
            remote_account_id="orca-a",
            display_name="A",
            user_id=None,
        )

    profile = await db.scalar(select(SlicerProfile).where(SlicerProfile.account_id == result.account_id))
    revision = await db.get(SlicerProfileRevision, result.revision_ids[0])
    activation = await db.scalar(
        select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == profile.id)
    )
    account = await db.get(SlicerProfileAccount, result.account_id)
    assert profile.stale_at is not None
    assert activation.revision_id == revision.id
    assert account.last_sync_error == "sync_failed"
