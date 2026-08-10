"""Durable catalog selection, enforcement, and revision-pinning contracts."""

import asyncio
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

import backend.app.models  # noqa: F401
from backend.app.core import database
from backend.app.core.database import Base
from backend.app.models.printer import Printer
from backend.app.models.slice_job import SliceJobRecord
from backend.app.models.slicer_profile_catalog import (
    PrinterSlicerBinding,
    SlicerJobProvenance,
    SlicerProfile,
    SlicerProfileRevision,
)
from backend.app.schemas.slicer import HistoricalReslicePrepareRequest, PresetRef, SliceRequest
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_types import (
    NormalizedPrinterState,
    NozzleSnapshot,
    PrinterProvider,
    PrinterSnapshot,
)
from backend.app.services.slice_dispatch import SliceDispatchService
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
    ingest_catalog,
)
from backend.app.services.slicer_catalog_selection import (
    CatalogSelectionError,
    load_pinned_profile_content,
    persist_catalog_selection,
    prepare_historical_reslice,
)


@pytest.fixture
async def catalog_db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", factory)
    yield factory
    await engine.dispose()


async def setup_catalog(
    factory,
    *,
    enforcement_state: str = "enforced",
    source: str = "standard",
    user_id: int | None = None,
) -> dict[str, int]:
    async with factory() as db:
        result = await ingest_catalog(
            db,
            CatalogInput(
                source=source,
                remote_account_id="selection-test" if source == "standard" else f"selection-test-{source}",
                user_id=user_id,
                profiles=[
                    CatalogProfile(
                        "printer",
                        "printer",
                        "Bambu Lab P1S 0.4 nozzle",
                        {"type": "printer", "printer_model": "P1S"},
                        metadata={"compatible_printers": None},
                    ),
                    CatalogProfile(
                        "process",
                        "process",
                        "P1S process",
                        {"type": "process", "version": 1},
                        metadata={"compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]},
                    ),
                    CatalogProfile(
                        "filament",
                        "filament",
                        "P1S filament",
                        {"type": "filament"},
                        metadata={"compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]},
                    ),
                    CatalogProfile(
                        "dremel",
                        "process",
                        "Dremel process",
                        {"type": "process"},
                        metadata={"compatible_printers": ["Dremel 3D40"]},
                    ),
                ],
            ),
        )
        await approve_review_batch(db, result.review_batch_id)
        for revision_id in result.revision_ids:
            await activate_revision(db, revision_id)
        db.add(Printer(name="P1S", provider="bambu", model="P1S", is_active=True))
        await db.flush()
        profiles = {profile.remote_profile_id: profile for profile in (await db.scalars(select(SlicerProfile))).all()}
        binding = PrinterSlicerBinding(
            printer_id=1,
            profile_id=profiles["printer"].id,
            expected_nozzle_diameter=Decimal("0.4"),
            tool_index=0,
            default_process_profile_id=profiles["process"].id,
            default_filament_profile_id=profiles["filament"].id,
            enforcement_state=enforcement_state,
            is_active=True,
        )
        db.add(binding)
        await db.commit()
        return {**{key: profile.id for key, profile in profiles.items()}, "binding": binding.id}


def request_for(ids: dict[str, int], *, process: str = "process", acknowledgement=None) -> SliceRequest:
    return SliceRequest(
        printer_preset=PresetRef(source="standard", id="legacy-printer"),
        process_preset=PresetRef(source="standard", id="legacy-process"),
        filament_presets=[PresetRef(source="standard", id="legacy-filament")],
        catalog_printer_id=1,
        catalog_binding_id=ids["binding"],
        catalog_process_profile_id=ids[process],
        catalog_filament_profile_ids=[ids["filament"]],
        catalog_acknowledgement=acknowledgement,
        catalog_selection_evidence={"process_reason": "binding_default"},
    )


@pytest.mark.asyncio
async def test_enqueue_pins_revision_atomically_and_dispatches_old_content(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    )
    request = request_for(ids)
    release = asyncio.Event()

    async def run(_job_id):
        await release.wait()
        return {"library_file_id": 10}

    async def before_commit(db, job):
        await persist_catalog_selection(db, job, request)

    service = SliceDispatchService()
    job = await service.enqueue(
        kind="library_file",
        source_id=1,
        source_name="model.3mf",
        request_snapshot=request.model_dump(mode="json"),
        run=run,
        before_commit=before_commit,
    )
    async with catalog_db() as db:
        provenance = await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))
        pinned_process_revision = provenance.process_revision_id
        update = await ingest_catalog(
            db,
            CatalogInput(
                source="standard",
                remote_account_id="selection-test",
                profiles=[
                    CatalogProfile(
                        "process",
                        "process",
                        "P1S process",
                        {"type": "process", "version": 2},
                        metadata={"compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]},
                    )
                ],
            ),
        )
        await approve_review_batch(db, update.review_batch_id)
        await activate_revision(db, update.revision_ids[0])
        await db.commit()
        pinned = await load_pinned_profile_content(db, job.id)
        assert pinned is not None
        assert '"version": 1' in pinned.process
        assert provenance.process_revision_id == pinned_process_revision

    release.set()
    await service._tasks[job.id]
    async with catalog_db() as db:
        completed = await db.get(SliceJobRecord, job.id)
        assert completed.status == "completed"
        assert completed.expires_at is None


@pytest.mark.asyncio
async def test_enforced_selection_blocks_bypass_and_rolls_back_job(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    )
    request = request_for(ids, process="dremel")
    service = SliceDispatchService()

    async def before_commit(db, job):
        await persist_catalog_selection(db, job, request)

    with pytest.raises(CatalogSelectionError) as blocked:
        await service.enqueue(
            kind="library_file",
            source_id=1,
            source_name="model.3mf",
            request_snapshot=request.model_dump(mode="json"),
            run=lambda _job_id: None,
            before_commit=before_commit,
        )
    assert blocked.value.code == "slicer_profile_incompatible"
    async with catalog_db() as db:
        assert await db.scalar(select(func.count(SliceJobRecord.id))) == 0
        assert await db.scalar(select(func.count(SlicerJobProvenance.id))) == 0


@pytest.mark.asyncio
async def test_enforced_printer_profile_rejects_missing_catalog_binding(catalog_db):
    await setup_catalog(catalog_db)
    legacy_request = SliceRequest(
        printer_preset=PresetRef(source="standard", id="printer"),
        process_preset=PresetRef(source="standard", id="process"),
        filament_presets=[PresetRef(source="standard", id="filament")],
    )
    async with catalog_db() as db:
        job = SliceJobRecord(
            source_kind="library_file",
            source_id=1,
            source_name="model.3mf",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.flush()
        with pytest.raises(CatalogSelectionError) as blocked:
            await persist_catalog_selection(db, job, legacy_request)
        assert blocked.value.code == "slicer_binding_required"
        await db.rollback()

    bypass_request = legacy_request.model_copy(deep=True)
    bypass_request.printer_preset = PresetRef(source="standard", id="unbound-bypass")
    async with catalog_db() as db:
        bypass_job = SliceJobRecord(
            source_kind="library_file",
            source_id=2,
            source_name="bypass.3mf",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(bypass_job)
        await db.flush()
        await persist_catalog_selection(db, bypass_job, bypass_request)
        await db.commit()
        assert await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == bypass_job.id))


@pytest.mark.parametrize("filament_count", [0, 2])
def test_catalog_filament_selection_count_must_match_presets(filament_count):
    with pytest.raises(ValueError, match="catalog_filament_profile_ids must match filament_presets"):
        SliceRequest(
            printer_preset=PresetRef(source="standard", id="printer"),
            process_preset=PresetRef(source="standard", id="process"),
            filament_presets=[PresetRef(source="standard", id="filament")],
            catalog_printer_id=1,
            catalog_binding_id=1,
            catalog_process_profile_id=1,
            catalog_filament_profile_ids=([1] if filament_count == 1 else list(range(filament_count))),
        )


@pytest.mark.asyncio
async def test_catalog_filament_selection_count_accepts_matching_multicolor_presets():
    request = SliceRequest(
        printer_preset=PresetRef(source="standard", id="printer"),
        process_preset=PresetRef(source="standard", id="process"),
        filament_presets=[
            PresetRef(source="standard", id="filament-1"),
            PresetRef(source="standard", id="filament-2"),
        ],
        catalog_printer_id=1,
        catalog_binding_id=1,
        catalog_process_profile_id=1,
        catalog_filament_profile_ids=[1, 2],
    )
    assert len(request.catalog_filament_profile_ids) == len(request.filament_presets)


@pytest.mark.asyncio
async def test_private_cloud_profiles_remain_usable_only_by_account_owner(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db, source="orca_cloud", user_id=7)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    )
    async with catalog_db() as db:
        owner_job = SliceJobRecord(
            owner_id=7,
            source_kind="library_file",
            source_id=1,
            source_name="owner.3mf",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(owner_job)
        await db.flush()
        await persist_catalog_selection(db, owner_job, request_for(ids))
        await db.commit()

    async with catalog_db() as db:
        outsider_job = SliceJobRecord(
            owner_id=8,
            source_kind="library_file",
            source_id=2,
            source_name="outsider.3mf",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(outsider_job)
        await db.flush()
        with pytest.raises(CatalogSelectionError) as blocked:
            await persist_catalog_selection(db, outsider_job, request_for(ids))
        assert blocked.value.code == "profile_not_shared"


@pytest.mark.asyncio
async def test_offline_requires_acknowledgement_but_shadow_never_blocks(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db)
    monkeypatch.setattr(printer_manager, "get_snapshot", lambda _printer_id: None)
    async with catalog_db() as db:
        profile_count = await db.scalar(select(func.count(SlicerProfile.id)))
        revision_count = await db.scalar(select(func.count(SlicerProfileRevision.id)))
        job = SliceJobRecord(
            source_kind="library_file",
            source_id=1,
            source_name="model",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.flush()
        with pytest.raises(CatalogSelectionError) as warning:
            await persist_catalog_selection(
                db,
                job,
                request_for(ids, acknowledgement={"reason_codes": ["offline_unknown"]}),
            )
        assert warning.value.code == "slicer_acknowledgement_required"
        await db.rollback()

    async with catalog_db() as db:
        binding = await db.get(PrinterSlicerBinding, ids["binding"])
        binding.enforcement_state = "shadow"
        await db.commit()
        job = SliceJobRecord(
            source_kind="library_file",
            source_id=2,
            source_name="model",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.flush()
        await persist_catalog_selection(db, job, request_for(ids, process="dremel"))
        await db.commit()
        provenance = await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))
        assert provenance.selection_evidence["enforcement_state"] == "shadow"
        assert provenance.selection_evidence["compatibility"][0]["classification"]["selectable"] is False
        assert await load_pinned_profile_content(db, job.id) is not None
        binding = await db.get(PrinterSlicerBinding, ids["binding"])
        assert binding.is_active is True
        assert binding.enforcement_state == "shadow"
        assert await db.scalar(select(func.count(SlicerProfile.id))) == profile_count
        assert await db.scalar(select(func.count(SlicerProfileRevision.id))) == revision_count


async def _persist_original_job(factory, ids: dict[str, int]) -> tuple[int, int]:
    original_request = request_for(ids)
    async with factory() as db:
        job = SliceJobRecord(
            owner_id=7,
            source_kind="library_file",
            source_id=1,
            source_name="model.3mf",
            request_snapshot=original_request.model_dump(mode="json", exclude_none=True),
            status="completed",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.flush()
        await persist_catalog_selection(db, job, original_request)
        await db.commit()
        provenance = await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))
        return job.id, provenance.process_revision_id


@pytest.mark.asyncio
async def test_exact_history_uses_retained_tombstone_revision_and_records_acknowledgement(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    )
    source_job_id, old_process_revision_id = await _persist_original_job(catalog_db, ids)

    async with catalog_db() as db:
        update = await ingest_catalog(
            db,
            CatalogInput(
                source="standard",
                remote_account_id="selection-test",
                profiles=[
                    CatalogProfile(
                        "process",
                        "process",
                        "P1S process",
                        {"type": "process", "version": 2},
                        metadata={"compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]},
                    )
                ],
            ),
        )
        await approve_review_batch(db, update.review_batch_id)
        await activate_revision(db, update.revision_ids[0])
        process = await db.get(SlicerProfile, ids["process"])
        process.tombstoned_at = datetime.now(timezone.utc)
        await db.commit()

        replay = request_for(ids)
        replay.catalog_history_job_id = source_job_id
        replay.catalog_history_mode = "exact"
        replay.catalog_tombstone_acknowledgement = {"confirmed": True}
        job = SliceJobRecord(
            owner_id=7,
            source_kind="library_file",
            source_id=1,
            source_name="model.3mf",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.flush()
        await persist_catalog_selection(db, job, replay)
        await db.commit()

        provenance = await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))
        assert provenance.process_revision_id == old_process_revision_id
        assert provenance.selection_evidence["history"] == {
            "source_job_id": source_job_id,
            "mode": "exact",
            "tombstone_acknowledgement": {"confirmed": True},
        }
        pinned = await load_pinned_profile_content(db, job.id)
        assert pinned is not None
        assert '"version": 1' in pinned.process


@pytest.mark.asyncio
async def test_history_replay_survives_binding_printer_profile_retirement(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    )
    source_job_id, _old_process_revision_id = await _persist_original_job(catalog_db, ids)
    async with catalog_db() as db:
        source_provenance = await db.scalar(
            select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == source_job_id)
        )
        old_printer_revision_id = source_provenance.printer_revision_id

    async with catalog_db() as db:
        update = await ingest_catalog(
            db,
            CatalogInput(
                source="standard",
                remote_account_id="selection-test",
                profiles=[
                    CatalogProfile(
                        "printer-retired",
                        "printer",
                        "Bambu Lab P1S current nozzle",
                        {"type": "printer", "printer_model": "P1S"},
                        metadata={
                            "compatible_printers": None,
                            "aliases": ["Bambu Lab P1S 0.4 nozzle"],
                        },
                    )
                ],
            ),
        )
        await approve_review_batch(db, update.review_batch_id)
        await activate_revision(db, update.revision_ids[0])
        current_printer = await db.scalar(
            select(SlicerProfile).where(SlicerProfile.remote_profile_id == "printer-retired")
        )
        binding = await db.get(PrinterSlicerBinding, ids["binding"])
        binding.profile_id = current_printer.id
        await db.commit()

        replay = request_for(ids)
        replay.catalog_history_job_id = source_job_id
        replay.catalog_history_mode = "exact"
        exact_job = SliceJobRecord(
            owner_id=7,
            source_kind="library_file",
            source_id=1,
            source_name="model.3mf",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(exact_job)
        await db.flush()
        await persist_catalog_selection(db, exact_job, replay)
        await db.commit()
        exact_provenance = await db.scalar(
            select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == exact_job.id)
        )
        assert exact_provenance.printer_revision_id == old_printer_revision_id

        preview = await prepare_historical_reslice(
            db,
            await db.get(SliceJobRecord, source_job_id),
            HistoricalReslicePrepareRequest(mode="upgrade"),
        )
        assert preview.revision_ids["printer"] == update.revision_ids[0]


@pytest.mark.asyncio
async def test_exact_history_rechecks_current_nozzle_mismatch_even_in_shadow(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    )
    source_job_id, _revision_id = await _persist_original_job(catalog_db, ids)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.6, "confirmed"),),
        ),
    )

    async with catalog_db() as db:
        binding = await db.get(PrinterSlicerBinding, ids["binding"])
        binding.enforcement_state = "shadow"
        job = SliceJobRecord(
            owner_id=7,
            source_kind="library_file",
            source_id=1,
            source_name="model.3mf",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.flush()
        replay = request_for(ids)
        replay.catalog_history_job_id = source_job_id
        replay.catalog_history_mode = "exact"
        with pytest.raises(CatalogSelectionError) as blocked:
            await persist_catalog_selection(db, job, replay)
        assert blocked.value.code == "slicer_profile_incompatible"
        assert "nozzle_mismatch" in blocked.value.reason_codes


@pytest.mark.asyncio
async def test_history_upgrade_pins_current_active_revision(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    )
    source_job_id, old_process_revision_id = await _persist_original_job(catalog_db, ids)

    async with catalog_db() as db:
        update = await ingest_catalog(
            db,
            CatalogInput(
                source="standard",
                remote_account_id="selection-test",
                profiles=[
                    CatalogProfile(
                        "process",
                        "process",
                        "P1S process",
                        {"type": "process", "version": 2},
                        metadata={"compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]},
                    )
                ],
            ),
        )
        await approve_review_batch(db, update.review_batch_id)
        await activate_revision(db, update.revision_ids[0])
        await db.commit()

        job = SliceJobRecord(
            owner_id=7,
            source_kind="library_file",
            source_id=1,
            source_name="model.3mf",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.flush()
        replay = request_for(ids)
        replay.catalog_history_job_id = source_job_id
        replay.catalog_history_mode = "upgrade"
        await persist_catalog_selection(db, job, replay)
        await db.commit()
        provenance = await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))
        assert provenance.process_revision_id == update.revision_ids[0]
        assert provenance.process_revision_id != old_process_revision_id
        assert provenance.selection_evidence["history"]["mode"] == "upgrade"


@pytest.mark.asyncio
async def test_exact_history_rejects_unknown_provenance(catalog_db):
    ids = await setup_catalog(catalog_db)
    async with catalog_db() as db:
        source = SliceJobRecord(
            owner_id=7,
            source_kind="library_file",
            source_id=1,
            source_name="old.3mf",
            status="completed",
            created_at=datetime.now(timezone.utc),
        )
        db.add(source)
        await db.flush()
        db.add(SlicerJobProvenance(slice_job_id=source.id, provenance_state="provenance_unknown"))
        job = SliceJobRecord(
            owner_id=7,
            source_kind="library_file",
            source_id=1,
            source_name="new.3mf",
            status="pending",
            created_at=datetime.now(timezone.utc),
        )
        db.add(job)
        await db.flush()
        replay = request_for(ids)
        replay.catalog_history_job_id = source.id
        replay.catalog_history_mode = "exact"
        with pytest.raises(CatalogSelectionError) as blocked:
            await persist_catalog_selection(db, job, replay)
        assert blocked.value.code == "historical_provenance_unknown"


@pytest.mark.asyncio
async def test_historical_preview_clears_old_warning_acknowledgement(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    )
    source_job_id, process_revision_id = await _persist_original_job(catalog_db, ids)
    async with catalog_db() as db:
        source_job = await db.get(SliceJobRecord, source_job_id)
        source_job.request_snapshot["catalog_acknowledgement"] = {"confirmed": True, "old": True}
        preview = await prepare_historical_reslice(
            db,
            source_job,
            HistoricalReslicePrepareRequest(mode="exact"),
        )

    assert preview.request.catalog_acknowledgement is None
    assert preview.request.catalog_history_job_id == source_job_id
    assert preview.request.catalog_history_mode == "exact"
    assert preview.revision_ids["process"] == process_revision_id


@pytest.mark.asyncio
async def test_failed_catalog_job_keeps_complete_provenance(catalog_db, monkeypatch):
    ids = await setup_catalog(catalog_db)
    monkeypatch.setattr(
        printer_manager,
        "get_snapshot",
        lambda _printer_id: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    )
    request = request_for(ids)

    async def fail(_job_id):
        raise RuntimeError("sidecar failed")

    async def before_commit(db, job):
        await persist_catalog_selection(db, job, request)

    service = SliceDispatchService()
    job = await service.enqueue(
        kind="library_file",
        source_id=1,
        source_name="model.3mf",
        owner_id=7,
        request_snapshot=request.model_dump(mode="json"),
        run=fail,
        before_commit=before_commit,
    )
    await service._tasks[job.id]

    async with catalog_db() as db:
        failed = await db.get(SliceJobRecord, job.id)
        provenance = await db.scalar(select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == job.id))
        assert failed.status == "failed"
        assert failed.expires_at is None
        assert provenance.provenance_state == "resolved"
        assert provenance.printer_revision_id is not None
        assert provenance.process_revision_id is not None
        assert provenance.filament_revision_ids
