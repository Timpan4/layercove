"""Focused SQLite tests for generic slicer catalog ingestion."""

from __future__ import annotations

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
    SlicerProfileActivationEvent,
    SlicerProfileReviewBatch,
    SlicerProfileRevision,
)
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
    get_revision_content,
    ingest_catalog,
    mark_account_stale,
    resolve_dependency_ids,
    rollback_revision,
)


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


def page(account: str, *profiles: CatalogProfile, cursor: str | None = "1", source: str = "local"):
    return CatalogInput(source, account, profiles, cursor=cursor, display_name="same")


async def test_normalized_sources_and_account_namespace(db):
    await ingest_catalog(db, page("same", CatalogProfile("p", "process", "P", {"x": 1})))
    await ingest_catalog(db, page("same", CatalogProfile("p", "process", "P", {"x": 1}), source="cloud"))
    accounts = (await db.scalars(select(SlicerProfileAccount))).all()
    assert {(a.source, a.remote_account_id) for a in accounts} == {("local", "same"), ("cloud", "same")}
    sharing = {account.source: account.sharing_state for account in accounts}
    assert sharing == {"local": "shared", "cloud": "private"}


async def test_replay_is_idempotent_and_cursor_restarts(db):
    item = CatalogProfile("p", "process", "P", {"x": 1})
    first = await ingest_catalog(db, page("a", item, cursor="one"))
    second = await ingest_catalog(db, page("a", item, cursor="one"))
    assert second.review_batch_id is None
    assert len((await db.scalars(select(SlicerProfileRevision))).all()) == 1
    await ingest_catalog(db, page("a", item, cursor="two"))
    account = await db.get(SlicerProfileAccount, first.account_id)
    assert account.sync_cursor == "two"


async def test_authoritative_metadata_change_creates_revision(db):
    first = CatalogProfile("p", "process", "P", {"x": 1}, metadata={"compatible_printers": ["P1S"]})
    second = CatalogProfile("p", "process", "P", {"x": 1}, metadata={"compatible_printers": ["X1C"]})

    await ingest_catalog(db, page("a", first, cursor="one"))
    result = await ingest_catalog(db, page("a", second, cursor="two"))

    assert len(result.revision_ids) == 1
    assert len((await db.scalars(select(SlicerProfileRevision))).all()) == 2


async def test_dependency_resolves_when_dependency_arrives_later(db):
    dependent = CatalogProfile("process", "process", "Process", {"dependency_ids": ["printer"]})
    first = await ingest_catalog(db, page("a", dependent, cursor="one"))
    assert await resolve_dependency_ids(db, first.revision_ids[0]) == []

    await ingest_catalog(db, page("a", CatalogProfile("printer", "printer", "Printer", {}), cursor="two"))

    printer = await db.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == "printer"))
    assert await resolve_dependency_ids(db, first.revision_ids[0]) == [printer.id]


async def test_successful_sync_clears_stale_freeze(db):
    item = CatalogProfile("p", "printer", "P", {"v": 1})
    result = await ingest_catalog(db, page("a", item))
    await mark_account_stale(db, result.account_id)

    await ingest_catalog(db, page("a", item, cursor="2"))

    profile = await db.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == "p"))
    assert profile.stale_at is None


async def test_tombstone_and_stale_freeze_active(db):
    result = await ingest_catalog(db, page("a", CatalogProfile("p", "printer", "P", {"v": 1})))
    await approve_review_batch(db, result.review_batch_id)
    revision = await db.get(SlicerProfileRevision, result.revision_ids[0])
    await activate_revision(db, revision.id)
    await ingest_catalog(db, page("a", CatalogProfile("p", "printer", "P", tombstone=True), cursor="2"))
    profile = await db.get(SlicerProfile, revision.profile_id)
    await mark_account_stale(db, result.account_id)
    assert profile.tombstoned_at is not None and profile.stale_at is not None
    assert (
        await db.scalar(select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == profile.id))
    ).revision_id == revision.id


async def test_review_batch_can_approve_selected_revisions(db):
    result = await ingest_catalog(
        db,
        page(
            "selective",
            CatalogProfile("keep", "process", "Keep", {"v": 1}),
            CatalogProfile("reject", "process", "Reject", {"v": 1}),
        ),
    )

    await approve_review_batch(db, result.review_batch_id, revision_ids=[result.revision_ids[0]])

    revisions = {
        revision.id: revision.review_state
        for revision in (await db.scalars(select(SlicerProfileRevision))).all()
    }
    assert revisions == {
        result.revision_ids[0]: "approved",
        result.revision_ids[1]: "rejected",
    }


async def test_review_activation_later_revision_and_rollback(db):
    first = await ingest_catalog(db, page("a", CatalogProfile("p", "process", "P", {"v": 1})))
    await approve_review_batch(db, first.review_batch_id)
    await activate_revision(db, first.revision_ids[0])
    second = await ingest_catalog(db, page("a", CatalogProfile("p", "process", "P", {"v": 2}), cursor="2"))
    activation = await db.scalar(select(SlicerProfileActivation))
    assert activation.revision_id == first.revision_ids[0]
    await approve_review_batch(db, second.review_batch_id)
    await activate_revision(db, second.revision_ids[0])
    await rollback_revision(db, activation.profile_id, first.revision_ids[0])
    assert (await db.scalar(select(SlicerProfileActivation))).revision_id == first.revision_ids[0]
    events = (await db.scalars(select(SlicerProfileActivationEvent).order_by(SlicerProfileActivationEvent.id))).all()
    assert [(event.revision_id, event.action) for event in events] == [
        (first.revision_ids[0], "activate"),
        (second.revision_ids[0], "activate"),
        (first.revision_ids[0], "rollback"),
    ]


async def test_historical_content_and_dependency_closure(db):
    item = CatalogProfile("printer", "printer", "Printer", {"name": "historical"})
    first = await ingest_catalog(db, page("a", item))
    process = CatalogProfile("process", "process", "Process", {"dependency_ids": ["printer"]}, metadata={"vendor": "x"})
    second = await ingest_catalog(db, page("a", process, cursor="2"))
    assert await get_revision_content(db, first.revision_ids[0]) == {"name": "historical"}
    assert await resolve_dependency_ids(db, second.revision_ids[0]) == [
        (await db.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == "printer"))).id
    ]
