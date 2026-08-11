"""Binding, classification, readiness, mapping, and shadow API contracts."""

from collections import Counter
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

import backend.app.models  # noqa: F401
from backend.app.api.routes.slicer_catalog_bindings import (
    BindingRequest,
    BindingUpdate,
    EvaluationRequest,
    FilamentRuleRequest,
    MappingRequest,
    PreferenceRequest,
    RetirementRequest,
    classify_catalog,
    create_binding,
    create_filament_rule,
    create_mapping,
    evaluate_catalog,
    list_preferences,
    list_printer_bindings,
    retire_profile,
    save_preference,
    suggest_binding,
    update_binding,
)
from backend.app.core.database import Base
from backend.app.models.printer import Printer
from backend.app.models.slice_job import SliceJobRecord  # noqa: F401
from backend.app.models.slicer_profile_catalog import (
    PrinterSlicerBinding,
    SlicerFilamentRule,
    SlicerProfile,
    SlicerSelectionEvaluation,
)
from backend.app.models.user import User
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_types import (
    NormalizedPrinterState,
    NozzleSnapshot,
    PrinterProvider,
    PrinterSnapshot,
)
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
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


async def install_profiles(db: AsyncSession) -> dict[str, SlicerProfile]:
    specs = [
        ("p1s-printer", "printer", "Bambu Lab P1S 0.4 nozzle", None, {"model": "P1S"}),
        ("voron-printer", "printer", "Voron 2.4 0.4 nozzle", None, {"model": "Voron 2.4"}),
        ("p1s-process", "process", "P1S process", ["Bambu Lab P1S 0.4 nozzle"], None),
        ("p1s-filament", "filament", "P1S filament", ["Bambu Lab P1S 0.4 nozzle"], None),
        ("voron-process", "process", "Voron process", ["Voron 2.4 0.4 nozzle"], None),
        ("voron-filament", "filament", "Voron filament", ["Voron 2.4 0.4 nozzle"], None),
        ("dremel-process", "process", "Dremel process", ["Dremel 3D40"], None),
        ("unknown-process", "process", "Unknown process", None, None),
    ]
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="test-installation",
            profiles=[
                CatalogProfile(
                    remote_profile_id=remote_id,
                    profile_type=profile_type,
                    display_name=name,
                    content={"type": profile_type, **(content or {})},
                    metadata={"compatible_printers": compatibility},
                )
                for remote_id, profile_type, name, compatibility, content in specs
            ],
        ),
    )
    await approve_review_batch(db, result.review_batch_id)
    for revision_id in result.revision_ids:
        await activate_revision(db, revision_id)
    db.add_all(
        [
            Printer(name="P1S", provider="bambu", model="P1S", is_active=True),
            Printer(name="Voron", provider="moonraker", model=None, is_active=True),
        ]
    )
    await db.commit()
    profiles = (await db.scalars(select(SlicerProfile))).all()
    return {profile.remote_profile_id: profile for profile in profiles}


def binding_request(printer_id: int, profiles: dict[str, SlicerProfile], prefix: str) -> BindingRequest:
    return BindingRequest(
        printer_id=printer_id,
        profile_id=profiles[f"{prefix}-printer"].id,
        expected_nozzle_diameter=Decimal("0.4"),
        default_process_profile_id=profiles[f"{prefix}-process"].id,
        default_filament_profile_id=profiles[f"{prefix}-filament"].id,
    )


async def test_bindings_allow_independent_bambu_and_moonraker_setup(db, monkeypatch):
    profiles = await install_profiles(db)
    monkeypatch.setattr(printer_manager, "get_snapshot", lambda _printer_id: None)

    p1s = await create_binding(binding_request(1, profiles, "p1s"), None, db)
    voron = await create_binding(binding_request(2, profiles, "voron"), None, db)

    assert p1s["readiness"] == {"state": "acknowledgement_required", "reason_codes": ("offline_unknown",)}
    assert voron["readiness"] == {"state": "acknowledgement_required", "reason_codes": ("offline_unknown",)}
    assert len(await list_printer_bindings(1, None, db)) == 1
    assert len(await list_printer_bindings(2, None, db)) == 1
    with pytest.raises(HTTPException) as duplicate:
        await create_binding(binding_request(1, profiles, "p1s"), None, db)
    assert duplicate.value.status_code == 409


async def test_four_groups_mapping_nozzle_and_shadow_authority(db, monkeypatch):
    profiles = await install_profiles(db)
    snapshots = {
        1: PrinterSnapshot(
            PrinterProvider.BAMBU,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
        2: PrinterSnapshot(
            PrinterProvider.MOONRAKER,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, 0.4, "confirmed"),),
        ),
    }
    monkeypatch.setattr(printer_manager, "get_snapshot", snapshots.get)
    p1s = await create_binding(binding_request(1, profiles, "p1s"), None, db)
    await create_binding(binding_request(2, profiles, "voron"), None, db)

    grouped = await classify_catalog(1, p1s["id"], None, db)
    assert profiles["p1s-process"].id in {item["profile_id"] for item in grouped["selected_printer"]}
    assert profiles["voron-process"].id in {item["profile_id"] for item in grouped["other_installed_printers"]}
    assert [item["profile_id"] for item in grouped["unclassified"]] == [profiles["unknown-process"].id]
    assert profiles["dremel-process"].id in {item["profile_id"] for item in grouped["incompatible"]}

    await create_mapping(MappingRequest(profile_id=profiles["unknown-process"].id, printer_id=1), None, db)
    grouped = await classify_catalog(1, p1s["id"], None, db)
    assert profiles["unknown-process"].id in {item["profile_id"] for item in grouped["selected_printer"]}
    with pytest.raises(HTTPException) as mismatch:
        await create_mapping(MappingRequest(profile_id=profiles["dremel-process"].id, printer_id=1), None, db)
    assert mismatch.value.status_code == 422

    snapshots[1] = PrinterSnapshot(
        PrinterProvider.BAMBU,
        True,
        NormalizedPrinterState.IDLE,
        nozzles=(NozzleSnapshot(0, 0.6, "confirmed"),),
    )
    grouped = await classify_catalog(1, p1s["id"], None, db)
    p1s_item = next(item for item in grouped["incompatible"] if item["profile_id"] == profiles["p1s-process"].id)
    assert "nozzle_mismatch" in p1s_item["classification"]["reason_codes"]

    shadow = await evaluate_catalog(
        EvaluationRequest(binding_id=p1s["id"], profile_id=profiles["p1s-process"].id, legacy_eligible=False),
        None,
        db,
    )
    assert shadow["dispatch_eligible"] is True
    assert shadow["differs"] is True
    evaluation = await db.get(SlicerSelectionEvaluation, shadow["evaluation_id"])
    assert evaluation.selected_revision_ids["process"] == p1s_item["revision_id"]
    assert evaluation.compatibility_evidence["legacy_eligible"] is True


async def test_classification_excludes_inactive_profiles(db, monkeypatch):
    profiles = await install_profiles(db)
    monkeypatch.setattr(printer_manager, "get_snapshot", lambda _printer_id: None)
    binding = await create_binding(binding_request(1, profiles, "p1s"), None, db)
    await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="inactive-installation",
            profiles=[
                CatalogProfile(
                    remote_profile_id="inactive-process",
                    profile_type="process",
                    display_name="Inactive process",
                    content={"type": "process"},
                    metadata={"compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]},
                )
            ],
        ),
    )
    await db.commit()
    inactive = await db.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == "inactive-process"))

    grouped = await classify_catalog(1, binding["id"], None, db)

    returned_ids = {item["profile_id"] for group in grouped.values() for item in group}
    assert inactive.id not in returned_ids


async def test_classification_query_count_does_not_grow_per_active_profile(db, monkeypatch):
    profiles = await install_profiles(db)
    monkeypatch.setattr(printer_manager, "get_snapshot", lambda _printer_id: None)
    binding = await create_binding(binding_request(1, profiles, "p1s"), None, db)

    async def classify_with_query_counts():
        counts: Counter[str] = Counter()

        def increment(_connection, _cursor, statement, *_args):
            tables = (
                "slicer_profile_activations",
                "slicer_profile_revisions",
                "printer_slicer_bindings",
                "slicer_compatibility_mappings",
            )
            counts[next((table for table in tables if table in statement), "other")] += 1

        engine = db.bind.sync_engine
        event.listen(engine, "before_cursor_execute", increment)
        try:
            grouped = await classify_catalog(1, binding["id"], None, db)
        finally:
            event.remove(engine, "before_cursor_execute", increment)
        return counts, grouped

    baseline, _grouped = await classify_with_query_counts()
    added = await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="expanded-installation",
            profiles=[
                CatalogProfile(
                    remote_profile_id="extra-p1s-process",
                    profile_type="process",
                    display_name="Extra P1S process",
                    content={"type": "process"},
                    metadata={"compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]},
                )
            ],
        ),
    )
    await approve_review_batch(db, added.review_batch_id)
    await activate_revision(db, added.revision_ids[0])
    await db.commit()
    extra = await db.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == "extra-p1s-process"))

    expanded, grouped = await classify_with_query_counts()

    returned_ids = {item["profile_id"] for group in grouped.values() for item in group}
    assert extra.id in returned_ids
    assert expanded == baseline, f"one active profile added classification queries: {expanded - baseline}"


async def test_binding_defaults_can_be_set_one_at_a_time(db, monkeypatch):
    profiles = await install_profiles(db)
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
    binding = await create_binding(
        BindingRequest(
            printer_id=1,
            profile_id=profiles["p1s-printer"].id,
            expected_nozzle_diameter=Decimal("0.4"),
        ),
        None,
        db,
    )

    grouped = await classify_catalog(1, binding["id"], None, db)
    selected_ids = {item["profile_id"] for item in grouped["selected_printer"]}
    assert profiles["p1s-process"].id in selected_ids
    assert profiles["p1s-filament"].id in selected_ids
    assert profiles["unknown-process"].id in {item["profile_id"] for item in grouped["incompatible"]}

    updated = await update_binding(
        binding["id"],
        BindingUpdate(default_process_profile_id=profiles["p1s-process"].id),
        None,
        db,
    )
    assert updated["readiness"] == {"state": "blocked", "reason_codes": ("default_unavailable",)}

    updated = await update_binding(
        binding["id"],
        BindingUpdate(default_filament_profile_id=profiles["p1s-filament"].id),
        None,
        db,
    )
    assert updated["readiness"] == {"state": "ready", "reason_codes": ("nozzle_match",)}


async def test_exact_filament_rules_and_preferences_stay_binding_scoped(db, monkeypatch):
    profiles = await install_profiles(db)
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
    binding = await create_binding(binding_request(1, profiles, "p1s"), None, db)
    user = User(username="picker")
    db.add(user)
    await db.commit()

    rule = await create_filament_rule(
        FilamentRuleRequest(
            scope="exact_external",
            filament_profile_id=profiles["p1s-filament"].id,
            binding_id=binding["id"],
            external_source="spoolman",
            external_identity="spool:42",
        ),
        user,
        db,
    )
    assert rule["scope"] == "exact_external"
    stored_rule = await db.get(SlicerFilamentRule, rule["id"])
    assert stored_rule.binding_id == binding["id"]
    with pytest.raises(HTTPException) as duplicate:
        await create_filament_rule(
            FilamentRuleRequest(
                scope="exact_external",
                filament_profile_id=profiles["p1s-filament"].id,
                binding_id=binding["id"],
                external_source="spoolman",
                external_identity="spool:42",
            ),
            user,
            db,
        )
    assert duplicate.value.status_code == 409

    preference = await save_preference(
        PreferenceRequest(
            binding_id=binding["id"],
            profile_id=profiles["p1s-process"].id,
            profile_type="process",
        ),
        user,
        db,
    )
    assert preference["value"] == {"profile_id": profiles["p1s-process"].id}
    assert await list_preferences(binding["id"], user, db) == [preference]
    with pytest.raises(HTTPException) as incompatible:
        await save_preference(
            PreferenceRequest(
                binding_id=binding["id"],
                profile_id=profiles["dremel-process"].id,
                profile_type="process",
            ),
            user,
            db,
        )
    assert incompatible.value.status_code == 422


async def test_referenced_retirement_requires_atomic_replacement_or_explicit_disable(db, monkeypatch):
    profiles = await install_profiles(db)
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
    binding = await create_binding(binding_request(1, profiles, "p1s"), None, db)
    update = await ingest_catalog(
        db,
        CatalogInput(
            source="standard",
            remote_account_id="test-installation",
            profiles=[
                CatalogProfile(
                    remote_profile_id="replacement-process",
                    profile_type="process",
                    display_name="Replacement P1S process",
                    content={"type": "process"},
                    metadata={"compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]},
                )
            ],
        ),
    )
    await approve_review_batch(db, update.review_batch_id)
    await activate_revision(db, update.revision_ids[0])
    await db.commit()
    replacement = await db.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == "replacement-process"))

    with pytest.raises(HTTPException) as unresolved:
        await retire_profile(profiles["p1s-process"].id, RetirementRequest(), None, db)
    assert unresolved.value.status_code == 409

    retired = await retire_profile(
        profiles["p1s-process"].id,
        RetirementRequest(replacement_profile_id=replacement.id),
        None,
        db,
    )
    stored_binding = await db.get(PrinterSlicerBinding, binding["id"])
    await db.refresh(profiles["p1s-process"])
    assert retired["replacement_profile_id"] == replacement.id
    assert stored_binding.default_process_profile_id == replacement.id
    assert profiles["p1s-process"].tombstoned_at is not None

    disabled = await retire_profile(
        replacement.id,
        RetirementRequest(disable_references=True),
        None,
        db,
    )
    await db.refresh(stored_binding)
    assert disabled["disabled_binding_ids"] == [stored_binding.id]
    assert stored_binding.is_active is False


async def test_retirement_reports_only_bindings_disabled_by_that_request(db, monkeypatch):
    profiles = await install_profiles(db)
    monkeypatch.setattr(printer_manager, "get_snapshot", lambda _printer_id: None)
    created = await create_binding(binding_request(1, profiles, "p1s"), None, db)
    stored = await db.get(PrinterSlicerBinding, created["id"])
    stored.is_active = False
    await db.commit()

    retired = await retire_profile(
        profiles["p1s-process"].id,
        RetirementRequest(disable_references=True),
        None,
        db,
    )

    assert retired["disabled_binding_ids"] == []


async def test_private_cloud_profile_is_visible_and_preferred_only_by_owner(db, monkeypatch):
    profiles = await install_profiles(db)
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
    binding = await create_binding(binding_request(1, profiles, "p1s"), None, db)
    owner = User(username="private-owner")
    outsider = User(username="private-outsider")
    db.add_all([owner, outsider])
    await db.commit()
    result = await ingest_catalog(
        db,
        CatalogInput(
            source="orca_cloud",
            remote_account_id="private-owner",
            user_id=owner.id,
            profiles=[
                CatalogProfile(
                    remote_profile_id="private-process",
                    profile_type="process",
                    display_name="Private P1S process",
                    content={"type": "process"},
                    metadata={"compatible_printers": ["Bambu Lab P1S 0.4 nozzle"]},
                )
            ],
        ),
    )
    await approve_review_batch(db, result.review_batch_id, owner.id)
    await activate_revision(db, result.revision_ids[0], owner.id)
    await db.commit()
    private_profile = await db.scalar(select(SlicerProfile).where(SlicerProfile.remote_profile_id == "private-process"))

    owner_groups = await classify_catalog(1, binding["id"], owner, db)
    outsider_groups = await classify_catalog(1, binding["id"], outsider, db)
    preference = await save_preference(
        PreferenceRequest(
            binding_id=binding["id"],
            profile_id=private_profile.id,
            profile_type="process",
        ),
        owner,
        db,
    )

    assert private_profile.id in {item["profile_id"] for item in owner_groups["selected_printer"]}
    assert private_profile.id not in {item["profile_id"] for group in outsider_groups.values() for item in group}
    assert preference["value"] == {"profile_id": private_profile.id}
    with pytest.raises(HTTPException):
        await save_preference(
            PreferenceRequest(
                binding_id=binding["id"],
                profile_id=private_profile.id,
                profile_type="process",
            ),
            outsider,
            db,
        )


async def test_p1s_suggestion_never_creates_binding_and_voron_is_independently_unconfigured(db):
    profiles = await install_profiles(db)

    p1s = await suggest_binding(1, None, db)
    voron = await suggest_binding(2, None, db)

    assert p1s["suggested_profile_ids"] == (profiles["p1s-printer"].id,)
    assert p1s["requires_confirmation"] is True
    assert p1s["readiness"] == "setup_required"
    assert voron["readiness"] == "setup_required"
    assert (await db.scalars(select(PrinterSlicerBinding))).all() == []
