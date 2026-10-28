"""Focused tests for catalog source adapters and Orca mirror sync."""

import json
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.orm.attributes import set_committed_value

import backend.app.models  # noqa: F401
from backend.app.core.database import Base
from backend.app.models.local_preset import LocalPreset
from backend.app.models.slice_job import SliceJobRecord  # noqa: F401
from backend.app.models.slicer_profile_catalog import (
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileReviewBatch,
    SlicerProfileRevision,
)
from backend.app.services.orca_cloud import OrcaCloudError, OrcaProfilePull
from backend.app.services.slicer_catalog import (
    CatalogInput,
    activate_revision,
    activate_without_review,
    approve_review_batch,
    ingest_catalog,
    rollback_revision,
)
from backend.app.services.slicer_catalog_sync import (
    cloud_profile_adapter,
    local_preset_adapter,
    orca_profile_adapter,
    resolve_profile_inheritance,
    standard_profile_adapter,
    sync_cloud_account,
    sync_local_catalog,
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


def test_local_profile_preserves_compatibility_from_full_content():
    preset = LocalPreset(
        id=91,
        name="Imported process",
        preset_type="process",
        setting=json.dumps({"compatible_printers": ["Machine 0.4"]}),
        compatible_printers=None,
    )
    assert local_preset_adapter(preset).metadata["compatible_printers"] == ["Machine 0.4"]


def local_filament(value: int):
    return LocalPreset(id=7, name="Dogge PETG", preset_type="filament", setting=json.dumps({"value": value}))


async def active_content(db, profile_id: int):
    activation = await db.scalar(
        select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == profile_id)
    )
    return None if activation is None else (await db.get(SlicerProfileRevision, activation.revision_id)).content


# Failure mode: imported or edited local presets wait for a review that the importer
# could do anyway, so calibration and slicing cannot use them.
async def test_local_preset_changes_are_active_without_review(db):
    preset = local_filament(1)
    db.add(preset)
    await db.flush()
    first = await sync_local_catalog(db)
    profile_id = (await db.get(SlicerProfileRevision, first.revision_ids[0])).profile_id
    assert await active_content(db, profile_id) == {"value": 1}

    preset.setting = json.dumps({"value": 2})
    await sync_local_catalog(db)
    assert await active_content(db, profile_id) == {"value": 2}

    # Reverting an edit reuses the earlier revision and must make it active again.
    preset.setting = json.dumps({"value": 1})
    await sync_local_catalog(db)
    assert await active_content(db, profile_id) == {"value": 1}
    assert {batch.status for batch in (await db.scalars(select(SlicerProfileReviewBatch))).all()} == {"approved"}


async def test_local_sync_activates_revisions_left_waiting_for_review(db):
    preset = local_filament(1)
    db.add(preset)
    await db.flush()
    waiting = await ingest_catalog(
        db, CatalogInput(source="local", remote_account_id="installation", profiles=[local_preset_adapter(preset)])
    )

    await sync_local_catalog(db)

    revision = await db.get(SlicerProfileRevision, waiting.revision_ids[0])
    assert (await db.get(SlicerProfileReviewBatch, waiting.review_batch_id)).status == "approved"
    assert await active_content(db, revision.profile_id) == {"value": 1}


# Failure mode: an unrelated preset change or a restart undoes an administrator's rollback.
async def test_local_sync_keeps_a_rollback_until_the_preset_changes(db):
    preset = local_filament(1)
    db.add(preset)
    await db.flush()
    first = await sync_local_catalog(db)
    profile_id = (await db.get(SlicerProfileRevision, first.revision_ids[0])).profile_id
    preset.setting = json.dumps({"value": 2})
    await sync_local_catalog(db)
    await rollback_revision(db, profile_id, first.revision_ids[0])

    await sync_local_catalog(db)
    assert await active_content(db, profile_id) == {"value": 1}

    preset.setting = json.dumps({"value": 3})
    await sync_local_catalog(db)
    assert await active_content(db, profile_id) == {"value": 3}


async def orca_pull(db, pull):
    return await sync_orca_account(
        db, service_with(pull), remote_account_id="orca-history", display_name="Owner", user_id=None
    )


# Failure mode: after Orca reverts a profile, an incremental pull rebuilds unchanged profiles
# from their newest revision and activates content Orca no longer serves.
async def test_incremental_orca_pull_keeps_a_reverted_profile(db):
    first = await orca_pull(db, OrcaProfilePull("1", [orca_entry(value=1)], [], True))
    profile_id = (await db.get(SlicerProfileRevision, first.revision_ids[0])).profile_id
    await orca_pull(db, OrcaProfilePull("2", [orca_entry(value=2)], [], True))
    await orca_pull(db, OrcaProfilePull("3", [orca_entry(value=1)], [], True))
    assert (await active_content(db, profile_id))["value"] == 1

    await orca_pull(db, OrcaProfilePull("4", [], [], False))

    assert (await active_content(db, profile_id))["value"] == 1


# Failure mode: content Orca sent while the account was shared stays inactive after the
# account becomes private again, because an unrelated pull rebuilds it from the old revision.
async def test_content_pending_from_a_shared_period_activates_after_unsharing(db):
    first = await orca_pull(db, OrcaProfilePull("1", [orca_entry(value=1)], [], True))
    profile_id = (await db.get(SlicerProfileRevision, first.revision_ids[0])).profile_id
    account = await db.get(SlicerProfileAccount, first.account_id)
    account.sharing_state, account.consent_at = "shared", datetime(2026, 1, 1)
    await db.commit()
    await orca_pull(db, OrcaProfilePull("2", [orca_entry(value=2)], [], True))
    account.sharing_state, account.consent_at = "private", None
    await db.commit()

    await orca_pull(db, OrcaProfilePull("3", [], [], False))

    assert (await active_content(db, profile_id))["value"] == 2


# Failure mode: an administrator's rollback of a parent leaks into its children, which an
# unrelated pull re-resolves against the rolled-back parent.
async def test_parent_rollback_does_not_change_children_on_an_unrelated_pull(db):
    first = await orca_pull(db, OrcaProfilePull("1", orca_inherited_entries("P1S"), [], True))
    await orca_pull(db, OrcaProfilePull("2", orca_inherited_entries("X1C"), [], True))
    profiles = {
        profile.remote_profile_id: profile.id
        for profile in (
            await db.scalars(select(SlicerProfile).where(SlicerProfile.account_id == first.account_id))
        ).all()
    }
    parent_v1 = await db.scalar(
        select(SlicerProfileRevision.id)
        .where(SlicerProfileRevision.profile_id == profiles["parent"])
        .order_by(SlicerProfileRevision.id)
    )
    await rollback_revision(db, profiles["parent"], parent_v1)
    await db.commit()

    await orca_pull(db, OrcaProfilePull("3", [], [], False))

    assert (await active_content(db, profiles["parent"]))["parent_value"] == "P1S"
    assert (await active_content(db, profiles["child"]))["parent_value"] == "X1C"


# Failure mode: Orca reverts a parent in an incremental pull, and its child keeps the newer
# inherited content because the reverted child content already has a revision.
async def test_incremental_parent_revert_also_reverts_children(db):
    first = await orca_pull(db, OrcaProfilePull("1", orca_inherited_entries("P1S"), [], True))
    await orca_pull(db, OrcaProfilePull("2", orca_inherited_entries("X1C"), [], True))
    child = await db.scalar(
        select(SlicerProfile).where(
            SlicerProfile.account_id == first.account_id, SlicerProfile.remote_profile_id == "child"
        )
    )

    await orca_pull(db, OrcaProfilePull("3", [orca_inherited_entries("P1S")[0]], [], False))

    assert (await active_content(db, child.id))["parent_value"] == "P1S"


# Failure mode: a revision left pending while the account was shared bypasses an
# administrator's later rollback once the account is private again.
async def test_rollback_holds_against_a_revision_pending_from_before(db):
    first = await orca_pull(db, OrcaProfilePull("1", [orca_entry(value=1)], [], True))
    profile_id = (await db.get(SlicerProfileRevision, first.revision_ids[0])).profile_id
    account = await db.get(SlicerProfileAccount, first.account_id)
    account.sharing_state, account.consent_at = "shared", datetime(2026, 1, 1)
    await db.commit()
    await orca_pull(db, OrcaProfilePull("2", [orca_entry(value=2)], [], True))
    await rollback_revision(db, profile_id, first.revision_ids[0])
    account.sharing_state, account.consent_at = "private", None
    await db.commit()

    await orca_pull(db, OrcaProfilePull("3", [orca_entry(value=2)], [], True))

    assert (await active_content(db, profile_id))["value"] == 1


# Failure mode: an owner shares the account while a sync runs, and the sync, still holding
# the private copy it loaded, activates unreviewed revisions for every user.
async def test_sync_rereads_sharing_before_activating_without_review(db):
    first = await sync_orca_account(
        db,
        service_with(OrcaProfilePull("10", [orca_entry()], [], True)),
        remote_account_id="orca-race",
        display_name="Owner",
        user_id=None,
    )
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="orca_cloud", remote_account_id="orca-race", profiles=[orca_profile_adapter(orca_entry(value=2))]
        ),
    )
    await db.execute(
        update(SlicerProfileAccount)
        .where(SlicerProfileAccount.id == first.account_id)
        .values(sharing_state="shared", consent_at=datetime(2026, 1, 1))
    )
    # The sync still holds the copy it loaded before the other transaction committed.
    stale = await db.get(SlicerProfileAccount, first.account_id)
    set_committed_value(stale, "sharing_state", "private")

    await activate_without_review(db, result)

    assert (await db.get(SlicerProfileRevision, result.revision_ids[0])).review_state == "pending"


async def test_local_sync_keeps_a_rejected_revision_inactive(db):
    preset = local_filament(1)
    db.add(preset)
    await db.flush()
    rejected = await ingest_catalog(
        db, CatalogInput(source="local", remote_account_id="installation", profiles=[local_preset_adapter(preset)])
    )
    (await db.get(SlicerProfileReviewBatch, rejected.review_batch_id)).status = "rejected"
    revision = await db.get(SlicerProfileRevision, rejected.revision_ids[0])
    revision.review_state = "rejected"

    await sync_local_catalog(db)

    assert await active_content(db, revision.profile_id) is None


async def test_private_cloud_syncs_activate_and_shared_ones_wait_for_review(db):
    private = await sync_orca_account(
        db,
        service_with(OrcaProfilePull("10", [orca_entry()], [], True)),
        remote_account_id="orca-review",
        display_name="Owner",
        user_id=None,
    )
    profile_id = (await db.get(SlicerProfileRevision, private.revision_ids[0])).profile_id
    assert (await active_content(db, profile_id))["value"] == 1

    account = await db.get(SlicerProfileAccount, private.account_id)
    account.sharing_state = "shared"
    account.consent_at = datetime(2026, 1, 1)
    await db.commit()
    shared = await sync_orca_account(
        db,
        service_with(OrcaProfilePull("11", [orca_entry(value=2)], [], True)),
        remote_account_id="orca-review",
        display_name="Owner",
        user_id=None,
    )

    assert (await db.get(SlicerProfileRevision, shared.revision_ids[0])).review_state == "pending"
    assert (await active_content(db, profile_id))["value"] == 1
