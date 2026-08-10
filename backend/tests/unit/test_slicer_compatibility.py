"""Contract tests for authoritative compatibility and readiness."""

from decimal import Decimal

from backend.app.services.slicer_compatibility import (
    BindingEvidence,
    NozzleEvidence,
    ProfileEvidence,
    classify_profile,
    evaluate_nozzle,
    shadow_evaluate,
    suggest_p1s_binding,
)

P1S = BindingEvidence(1, 1, 10, "Bambu Lab P1S 0.4 nozzle", Decimal("0.4"), aliases=("P1S",))
DREMEL = BindingEvidence(2, 2, 20, "Dremel 3D40", Decimal("0.4"))
VORON = BindingEvidence(3, 3, 30, "Voron 2.4 0.4", Decimal("0.4"), aliases=("Voron 2.4",))
MATCHING_NOZZLE = NozzleEvidence("confirmed", Decimal("0.4"))


def profile(compatible=None, **overrides):
    values = {
        "profile_id": 100,
        "revision_id": 200,
        "display_name": "Candidate",
        "compatible_printers": compatible,
    }
    values.update(overrides)
    return ProfileEvidence(**values)


def test_resolved_metadata_beats_near_name_and_mapping():
    candidate = profile(("Dremel 3D40",), display_name="P1S-looking process")

    result = classify_profile(candidate, P1S, (P1S, DREMEL), MATCHING_NOZZLE, frozenset({P1S.printer_id}))

    assert result.group == "other_installed_printers"
    assert "resolved_metadata_mismatch" in result.reason_codes
    assert "administrator_mapping" not in result.reason_codes


def test_mapping_fills_unknown_only():
    unknown = profile(None)

    mapped = classify_profile(unknown, P1S, (P1S,), MATCHING_NOZZLE, frozenset({P1S.printer_id}))
    unclassified = classify_profile(unknown, P1S, (P1S,), MATCHING_NOZZLE)

    assert mapped.group == "selected_printer"
    assert mapped.auto_selectable is True
    assert unclassified.group == "unclassified"
    assert unclassified.selectable is True
    assert unclassified.auto_selectable is False
    assert unclassified.acknowledgement_required is True


def test_unclassified_profile_still_applies_nozzle_readiness():
    unknown = profile(None)

    mismatch = classify_profile(unknown, P1S, (P1S,), NozzleEvidence("confirmed", Decimal("0.6")))
    offline = classify_profile(unknown, P1S, (P1S,), NozzleEvidence("offline"))

    assert mismatch.readiness == "blocked"
    assert "nozzle_mismatch" in mismatch.reason_codes
    assert offline.readiness == "acknowledgement_required"
    assert "offline_unknown" in offline.reason_codes


def test_unclassified_profile_cannot_acknowledge_binding_failure():
    broken = BindingEvidence(
        1, 1, 10, "Bambu Lab P1S 0.4 nozzle", Decimal("0.4"), profile_available=False
    )

    result = classify_profile(profile(None), broken, (broken,), NozzleEvidence("offline"))

    assert result.readiness == "blocked"
    assert result.selectable is False
    assert "profile_unavailable" in result.reason_codes


def test_mapping_never_bypasses_confirmed_nozzle_mismatch():
    result = classify_profile(
        profile(None),
        P1S,
        (P1S,),
        NozzleEvidence("confirmed", Decimal("0.6")),
        frozenset({P1S.printer_id}),
    )

    assert result.group == "incompatible"
    assert result.selectable is False
    assert "nozzle_mismatch" in result.reason_codes


def test_bambu_nozzle_match_mismatch_unknown_offline_and_stale():
    assert evaluate_nozzle(P1S, MATCHING_NOZZLE).state == "ready"
    assert evaluate_nozzle(P1S, NozzleEvidence("confirmed", Decimal("0.6"))).reason_codes == ("nozzle_mismatch",)
    assert evaluate_nozzle(P1S, NozzleEvidence("unknown")).state == "acknowledgement_required"
    assert evaluate_nozzle(P1S, NozzleEvidence("offline")).reason_codes == ("offline_unknown",)
    assert evaluate_nozzle(P1S, NozzleEvidence("stale", Decimal("0.4"))).reason_codes == ("telemetry_stale",)


def test_readiness_isolated_per_printer_and_voron_requires_setup():
    voron = BindingEvidence(
        3,
        3,
        30,
        "Voron 2.4 0.4",
        Decimal("0.4"),
        profile_available=False,
    )

    assert evaluate_nozzle(P1S, MATCHING_NOZZLE).state == "ready"
    assert evaluate_nozzle(voron, MATCHING_NOZZLE).reason_codes == ("profile_unavailable",)


def test_lifecycle_conflicts_are_incompatible():
    assert classify_profile(
        profile((P1S.printer_profile_name,), tombstoned=True), P1S, (P1S,), MATCHING_NOZZLE
    ).reason_codes == ("profile_tombstoned",)
    assert classify_profile(
        profile((P1S.printer_profile_name,), approved=False), P1S, (P1S,), MATCHING_NOZZLE
    ).reason_codes == ("revision_unreviewed",)


def test_shadow_evaluation_never_changes_legacy_dispatch():
    incompatible = classify_profile(profile(("Dremel 3D40",)), P1S, (P1S,), MATCHING_NOZZLE)

    shadow = shadow_evaluate(True, incompatible)

    assert shadow.differs is True
    assert shadow.dispatch_eligible is True


def test_p1s_and_voron_shadow_oracle_has_all_four_authoritative_groups():
    installed = (P1S, VORON)
    p1s_process = profile((P1S.printer_profile_name,), profile_id=101, display_name="P1S process")
    voron_process = profile((VORON.printer_profile_name,), profile_id=102, display_name="Voron process")
    dremel_process = profile(("Dremel 3D40",), profile_id=103, display_name="Dremel process")
    afinia_filament = profile(("Afinia H480",), profile_id=104, display_name="Afinia filament")
    unknown = profile(None, profile_id=105, display_name="Unknown")

    p1s_results = {
        candidate.profile_id: classify_profile(candidate, P1S, installed, MATCHING_NOZZLE)
        for candidate in (p1s_process, voron_process, dremel_process, afinia_filament, unknown)
    }
    voron_result = classify_profile(voron_process, VORON, installed, MATCHING_NOZZLE)

    assert p1s_results[101].group == "selected_printer"
    assert p1s_results[101].auto_selectable is True
    assert p1s_results[102].group == "other_installed_printers"
    assert p1s_results[103].group == "incompatible"
    assert p1s_results[104].group == "incompatible"
    assert p1s_results[105].group == "unclassified"
    assert p1s_results[105].auto_selectable is False
    assert voron_result.group == "selected_printer"
    assert voron_result.auto_selectable is True



def test_p1s_suggestion_uses_explicit_model_metadata_and_requires_confirmation_elsewhere():
    suggestions = suggest_p1s_binding(
        provider="bambu",
        printer_model="Bambu Lab P1S",
        active_printer_profiles=(
            (10, "P1S-looking but wrong", "X1C"),
            (11, "Canonical", "Bambu Lab P1S"),
        ),
    )

    assert suggestions == (11,)
    assert (
        suggest_p1s_binding(
            provider="moonraker",
            printer_model="Voron 2.4",
            active_printer_profiles=((12, "Voron", "Voron 2.4"),),
        )
        == ()
    )
