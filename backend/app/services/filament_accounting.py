"""Filament writer precedence and value-normalization policy.

Persistence adapters own commits: local inventory writes SQL and Spoolman writes
its API. This module only decides the value a writer may apply.
"""

from __future__ import annotations

import math


def _percentage(remain: object, *, minimum: int) -> int | None:
    """Return a whole AMS percentage within the caller's accepted range."""
    if remain is None or isinstance(remain, bool):
        return None
    try:
        value = int(remain)
    except (TypeError, ValueError, OverflowError):
        return None
    if not isinstance(remain, str) and remain != value:
        return None
    return value if minimum <= value <= 100 else None


def weight_used_from_ams_percentage(
    *,
    print_active: bool,
    weight_locked: bool,
    remain: object,
    label_weight: int | None,
    weight_used: float | None,
) -> float | None:
    """Return a higher idle, unlocked ``weight_used`` estimate, if any."""
    remain_value = _percentage(remain, minimum=1)
    if print_active or weight_locked or remain_value is None:
        return None
    new_used = round((label_weight or 1000) * (100 - remain_value) / 100.0, 1)
    return new_used if new_used > (weight_used or 0) + 1 else None


def weight_used_from_manual_ams_percentage(
    *,
    print_active: bool,
    weight_locked: bool,
    remain: object,
    label_weight: int | None,
) -> float | None:
    """Return a manual AMS recovery measurement, never while printing."""
    remain_value = _percentage(remain, minimum=0)
    if print_active or weight_locked or remain_value is None:
        return None
    return round((label_weight or 1000) * (100 - remain_value) / 100.0, 1)


def initial_weight_used_from_rfid_percentage(*, remain: object, label_weight: int | None) -> float:
    """Return the creation-time RFID estimate; later tag links never call this."""
    remain_value = _percentage(remain, minimum=0)
    if remain_value is None:
        remain_value = 100
    return round((label_weight or 1000) * (100 - remain_value) / 100.0, 1)


def weight_used_from_scale(*, gross_weight: object, label_weight: int | None, core_weight: int | None) -> float | None:
    """Return the absolute stable-scale measurement, clamped to non-negative use."""
    try:
        gross = float(gross_weight)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(gross):
        return None
    net_filament = max(0.0, gross - (core_weight or 0))
    return max(0.0, (label_weight or 1000) - net_filament)


def print_usage_delta(weight_grams: object) -> float | None:
    """Return a positive finite print deduction for an additive writer."""
    try:
        grams = float(weight_grams)
    except (TypeError, ValueError, OverflowError):
        return None
    return grams if math.isfinite(grams) and grams > 0 else None
