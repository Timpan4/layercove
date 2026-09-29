"""SQLite contract tests for the planned slicer profile catalog schema."""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from backend.app.core.database import Base
from backend.app.models.local_preset import LocalPreset
from backend.app.models.printer import Printer
from backend.app.models.slice_job import SliceJobRecord
from backend.app.models.slicer_profile_catalog import (
    PrinterSlicerBinding,
    SlicerCompatibilityMapping,
    SlicerFilamentRule,
    SlicerJobProvenance,
    SlicerProfile,
    SlicerProfileAccount,
    SlicerProfileActivation,
    SlicerProfileReviewBatch,
    SlicerProfileRevision,
    SlicerSelectionEvaluation,
    UserSlicerPreference,
)
from backend.app.models.user import User
from backend.app.services.slicer_catalog_migration import backfill_slicer_catalog_state


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session
    await engine.dispose()


async def _seed_existing_rows(db: AsyncSession) -> tuple[User, Printer, SliceJobRecord]:
    user = User(
        username="alice",
        email="alice@example.test",
        orca_cloud_user_id="orca-alice",
        orca_cloud_token="access-token",
    )
    printer = Printer(name="X1C", provider="bambu")
    job = SliceJobRecord(
        owner_id=None,
        source_kind="upload",
        source_id=1,
        source_name="benchy.3mf",
        status="pending",
        created_at=datetime.now(),
    )
    db.add_all([user, printer, job])
    await db.commit()
    return user, printer, job


async def _account(db: AsyncSession, user_id: int, remote: str = "orca-alice") -> SlicerProfileAccount:
    account = SlicerProfileAccount(
        user_id=user_id,
        source="orca_cloud",
        remote_account_id=remote,
        display_name="Orca account",
    )
    db.add(account)
    await db.commit()
    return account


async def _profile(db: AsyncSession, account_id: int, name: str = "0.20 Standard") -> SlicerProfile:
    profile = SlicerProfile(
        account_id=account_id,
        remote_profile_id=f"process:{name}",
        profile_type="process",
        display_name=name,
    )
    db.add(profile)
    await db.commit()
    return profile


@pytest.mark.asyncio
async def test_additive_schema_keeps_representative_existing_rows_readable():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    existing_tables = [User.__table__, Printer.__table__, LocalPreset.__table__, SliceJobRecord.__table__]
    async with engine.begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=existing_tables))

    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        user = User(username="legacy", orca_cloud_token="access-token", orca_cloud_user_id="orca-legacy")
        printer = Printer(name="Legacy P1S", provider="bambu")
        preset = LocalPreset(name="Legacy PLA", preset_type="filament", setting="{}")
        job = SliceJobRecord(
            source_kind="upload",
            source_id=1,
            source_name="legacy.3mf",
            status="completed",
            created_at=datetime.now(),
        )
        session.add_all([user, printer, preset, job])
        await session.commit()

        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        await backfill_slicer_catalog_state(session)
        await session.commit()

        assert (await session.get(Printer, printer.id)).name == "Legacy P1S"
        assert (await session.get(LocalPreset, preset.id)).name == "Legacy PLA"
        catalog_profile = await session.scalar(
            select(SlicerProfile)
            .join(SlicerProfileAccount, SlicerProfileAccount.id == SlicerProfile.account_id)
            .where(
                SlicerProfileAccount.source == "local",
                SlicerProfile.remote_profile_id == str(preset.id),
            )
        )
        assert catalog_profile.display_name == "Legacy PLA"
        assert (
            len(
                (
                    await session.scalars(
                        select(SlicerProfileRevision).where(SlicerProfileRevision.profile_id == catalog_profile.id)
                    )
                ).all()
            )
            == 1
        )
        provenance = await session.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))
        assert provenance.provenance_state == "provenance_unknown"

    await engine.dispose()


@pytest.mark.asyncio
async def test_create_all_keeps_existing_printer_user_and_slice_job_rows_readable(db):
    user, printer, job = await _seed_existing_rows(db)

    assert (await db.get(User, user.id)).username == "alice"
    assert (await db.get(Printer, printer.id)).name == "X1C"
    assert (await db.get(SliceJobRecord, job.id)).source_name == "benchy.3mf"


@pytest.mark.asyncio
async def test_create_all_plus_backfill_is_idempotent(db):
    user, _printer, job = await _seed_existing_rows(db)

    await backfill_slicer_catalog_state(db)
    await db.commit()
    await backfill_slicer_catalog_state(db)
    await db.commit()

    accounts = (await db.scalars(select(SlicerProfileAccount).where(SlicerProfileAccount.user_id == user.id))).all()
    provenance = (await db.scalars(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))).all()
    assert len(accounts) == 1
    assert len(provenance) == 1


@pytest.mark.asyncio
async def test_account_namespace_allows_same_display_name_but_rejects_duplicate_remote_identity(db):
    user, _printer, _job = await _seed_existing_rows(db)
    first = await _account(db, user.id, "orca-a")
    second = await _account(db, user.id, "orca-b")
    db.add_all(
        [
            SlicerProfile(
                account_id=first.id,
                profile_type="process",
                display_name="Shared name",
                remote_profile_id="p1",
            ),
            SlicerProfile(
                account_id=second.id,
                profile_type="process",
                display_name="Shared name",
                remote_profile_id="p1",
            ),
        ]
    )
    await db.commit()

    db.add(
        SlicerProfile(
            account_id=first.id,
            profile_type="process",
            display_name="duplicate",
            remote_profile_id="p1",
        )
    )
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


@pytest.mark.asyncio
async def test_duplicate_content_hash_is_per_profile(db):
    user, _printer, _job = await _seed_existing_rows(db)
    account = await _account(db, user.id)
    first, second = await _profile(db, account.id, "first"), await _profile(db, account.id, "second")
    first_id, second_id = first.id, second.id
    db.add_all(
        [
            SlicerProfileRevision(profile_id=first_id, content_hash="hash-1", content={"x": 1}),
            SlicerProfileRevision(profile_id=first_id, content_hash="hash-1", content={"x": 1}),
        ]
    )
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    db.add(SlicerProfileRevision(profile_id=second_id, content_hash="hash-1", content={"x": 1}))
    await db.commit()


@pytest.mark.asyncio
async def test_exact_binding_duplicate_fails_but_alternate_profile_same_nozzle_works(db):
    user, printer, _job = await _seed_existing_rows(db)
    account = await _account(db, user.id)
    first, second = await _profile(db, account.id, "first"), await _profile(db, account.id, "second")
    printer_id, first_id, second_id = printer.id, first.id, second.id
    db.add_all(
        [
            PrinterSlicerBinding(
                printer_id=printer_id,
                profile_id=first_id,
                expected_nozzle_diameter=0.4,
                tool_index=0,
            ),
            PrinterSlicerBinding(
                printer_id=printer_id,
                profile_id=first_id,
                expected_nozzle_diameter=0.4,
                tool_index=0,
            ),
        ]
    )
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    db.add(
        PrinterSlicerBinding(
            printer_id=printer_id,
            profile_id=second_id,
            expected_nozzle_diameter=0.4,
            tool_index=0,
        )
    )
    await db.commit()


@pytest.mark.asyncio
async def test_orca_credential_backfill_is_pending_without_consent(db):
    user, _printer, _job = await _seed_existing_rows(db)
    await backfill_slicer_catalog_state(db)
    await db.commit()
    account = await db.scalar(select(SlicerProfileAccount).where(SlicerProfileAccount.user_id == user.id))
    assert account.source == "orca_cloud"
    assert account.sharing_state == "pending"
    assert account.consent_at is None


@pytest.mark.asyncio
async def test_existing_slice_job_gets_unknown_provenance(db):
    _user, _printer, job = await _seed_existing_rows(db)
    await backfill_slicer_catalog_state(db)
    await db.commit()
    provenance = await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))
    assert provenance.provenance_state == "provenance_unknown"


@pytest.mark.asyncio
async def test_partially_precreated_backfill_state_recovers_idempotently(db):
    user, _printer, job = await _seed_existing_rows(db)
    db.add_all(
        [
            SlicerProfileAccount(user_id=user.id, source="orca_cloud", remote_account_id="orca-alice"),
            SlicerJobProvenance(slice_job_id=job.id, provenance_state="provenance_unknown"),
        ]
    )
    await db.commit()

    await backfill_slicer_catalog_state(db)
    await db.commit()
    await backfill_slicer_catalog_state(db)
    await db.commit()

    assert (
        len((await db.scalars(select(SlicerProfileAccount).where(SlicerProfileAccount.user_id == user.id))).all()) == 1
    )
    assert (
        len((await db.scalars(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))).all())
        == 1
    )
