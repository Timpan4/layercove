"""Authoritative slicer compatibility and derived readiness."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

CatalogGroup = Literal["selected_printer", "other_installed_printers", "unclassified", "incompatible"]
CompatibilityState = Literal["match", "mismatch", "unknown"]
ReadinessState = Literal["ready", "acknowledgement_required", "blocked"]
NozzleStatus = Literal["confirmed", "offline", "stale", "unknown"]


@dataclass(frozen=True)
class BindingEvidence:
    id: int
    printer_id: int
    printer_profile_id: int
    printer_profile_name: str
    expected_nozzle_diameter: Decimal
    aliases: tuple[str, ...] = ()
    active: bool = True
    profile_available: bool = True
    defaults_available: bool = True


@dataclass(frozen=True)
class ProfileEvidence:
    profile_id: int
    revision_id: int
    display_name: str
    compatible_printers: tuple[str, ...] | None
    active: bool = True
    approved: bool = True
    tombstoned: bool = False


@dataclass(frozen=True)
class NozzleEvidence:
    status: NozzleStatus
    diameter: Decimal | None = None
    tool_index: int = 0


@dataclass(frozen=True)
class Classification:
    group: CatalogGroup
    compatibility: CompatibilityState
    readiness: ReadinessState
    reason_codes: tuple[str, ...]
    selectable: bool
    auto_selectable: bool
    acknowledgement_required: bool


@dataclass(frozen=True)
class Readiness:
    state: ReadinessState
    reason_codes: tuple[str, ...]


@dataclass(frozen=True)
class ShadowEvaluation:
    legacy_eligible: bool
    new_classification: Classification
    differs: bool
    dispatch_eligible: bool


def _normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def _binding_names(binding: BindingEvidence) -> set[str]:
    return {_normalize(binding.printer_profile_name), *(_normalize(alias) for alias in binding.aliases)}


def evaluate_nozzle(binding: BindingEvidence, nozzle: NozzleEvidence) -> Readiness:
    if not binding.active:
        return Readiness("blocked", ("binding_inactive",))
    if not binding.profile_available:
        return Readiness("blocked", ("profile_unavailable",))
    if not binding.defaults_available:
        return Readiness("blocked", ("default_unavailable",))
    if nozzle.status == "offline":
        return Readiness("acknowledgement_required", ("offline_unknown",))
    if nozzle.status == "stale":
        return Readiness("acknowledgement_required", ("telemetry_stale",))
    if nozzle.status == "unknown" or nozzle.diameter is None:
        return Readiness("acknowledgement_required", ("nozzle_unknown",))
    if nozzle.diameter != binding.expected_nozzle_diameter:
        return Readiness("blocked", ("nozzle_mismatch",))
    return Readiness("ready", ("nozzle_match",))


def classify_profile(
    profile: ProfileEvidence,
    selected: BindingEvidence,
    installed: tuple[BindingEvidence, ...],
    nozzle: NozzleEvidence,
    mapped_printer_ids: frozenset[int] = frozenset(),
) -> Classification:
    if profile.tombstoned:
        return Classification("incompatible", "mismatch", "blocked", ("profile_tombstoned",), False, False, False)
    if not profile.active:
        return Classification("incompatible", "mismatch", "blocked", ("profile_inactive",), False, False, False)
    if not profile.approved:
        return Classification("incompatible", "mismatch", "blocked", ("revision_unreviewed",), False, False, False)

    compatible = profile.compatible_printers
    selected_match = False
    other_match = False
    compatibility: CompatibilityState
    authority_reason: str
    if compatible:
        declared = {_normalize(name) for name in compatible}
        selected_match = bool(declared & _binding_names(selected))
        if not selected_match:
            other_match = any(
                binding.printer_id != selected.printer_id and bool(declared & _binding_names(binding))
                for binding in installed
                if binding.active and binding.profile_available
            )
        compatibility = "match" if selected_match else "mismatch"
        authority_reason = "resolved_metadata_match" if selected_match else "resolved_metadata_mismatch"
    elif selected.printer_id in mapped_printer_ids:
        selected_match = True
        compatibility = "match"
        authority_reason = "administrator_mapping"
    elif any(
        binding.printer_id in mapped_printer_ids
        for binding in installed
        if binding.printer_id != selected.printer_id and binding.active and binding.profile_available
    ):
        other_match = True
        compatibility = "mismatch"
        authority_reason = "administrator_mapping_other_printer"
    else:
        compatibility = "unknown"
        authority_reason = "compatibility_unknown"

    if other_match:
        return Classification(
            "other_installed_printers",
            compatibility,
            "blocked",
            (authority_reason, "other_installed_printer"),
            False,
            False,
            False,
        )
    if not selected_match:
        if compatibility == "unknown":
            readiness = evaluate_nozzle(selected, nozzle)
            if readiness.state == "blocked":
                return Classification(
                    "incompatible",
                    "unknown",
                    "blocked",
                    (authority_reason, *readiness.reason_codes),
                    False,
                    False,
                    False,
                )
            return Classification(
                "unclassified",
                "unknown",
                readiness.state,
                (authority_reason, *readiness.reason_codes),
                True,
                False,
                True,
            )
        return Classification("incompatible", "mismatch", "blocked", (authority_reason,), False, False, False)

    readiness = evaluate_nozzle(selected, nozzle)
    if readiness.state == "blocked":
        return Classification(
            "incompatible",
            compatibility,
            "blocked",
            (authority_reason, *readiness.reason_codes),
            False,
            False,
            False,
        )
    return Classification(
        "selected_printer",
        compatibility,
        readiness.state,
        (authority_reason, *readiness.reason_codes),
        True,
        True,
        readiness.state == "acknowledgement_required",
    )


def shadow_evaluate(legacy_eligible: bool, classification: Classification) -> ShadowEvaluation:
    new_eligible = classification.group == "selected_printer" and classification.selectable
    return ShadowEvaluation(
        legacy_eligible=legacy_eligible,
        new_classification=classification,
        differs=legacy_eligible != new_eligible,
        dispatch_eligible=legacy_eligible,
    )


def suggest_p1s_binding(
    *,
    provider: str,
    printer_model: str | None,
    active_printer_profiles: tuple[tuple[int, str, str | None], ...],
) -> tuple[int, ...]:
    """Return unconfirmed profile suggestions from explicit P1S model metadata."""
    if provider != "bambu" or printer_model is None or "p1s" not in _normalize(printer_model):
        return ()
    return tuple(
        profile_id
        for profile_id, _display_name, profile_model in active_printer_profiles
        if profile_model is not None and "p1s" in _normalize(profile_model)
    )
