import pytest

from backend.app.services.filament_accounting import (
    initial_weight_used_from_rfid_percentage,
    print_usage_delta,
    weight_used_from_ams_percentage,
    weight_used_from_manual_ams_percentage,
    weight_used_from_scale,
)


@pytest.mark.parametrize(
    ("remain", "expected"),
    [
        (1, 990.0),
        (50, 500.0),
        ("67", 330.0),
        (33, 669.3),
    ],
)
def test_returns_higher_weight_used_from_idle_ams_percentage(remain: object, expected: float):
    assert (
        weight_used_from_ams_percentage(
            print_active=False,
            weight_locked=False,
            remain=remain,
            label_weight=1000 if remain != 33 else 999,
            weight_used=0,
        )
        == expected
    )


def test_accepts_full_ams_percentage():
    assert (
        weight_used_from_ams_percentage(
            print_active=False,
            weight_locked=False,
            remain=100,
            label_weight=1000,
            weight_used=-2,
        )
        == 0.0
    )


@pytest.mark.parametrize("remain", [None, "invalid", True, 0, -1, 50.5, 101, float("inf")])
def test_ignores_invalid_ams_percentages(remain: object):
    assert (
        weight_used_from_ams_percentage(
            print_active=False,
            weight_locked=False,
            remain=remain,
            label_weight=1000,
            weight_used=0,
        )
        is None
    )


def test_uses_default_label_weight_when_missing():
    assert (
        weight_used_from_ams_percentage(
            print_active=False,
            weight_locked=False,
            remain=50,
            label_weight=None,
            weight_used=0,
        )
        == 500.0
    )


@pytest.mark.parametrize("print_active, weight_locked", [(True, False), (False, True)])
def test_skips_active_prints_and_locked_spools(print_active: bool, weight_locked: bool):
    assert (
        weight_used_from_ams_percentage(
            print_active=print_active,
            weight_locked=weight_locked,
            remain=50,
            label_weight=1000,
            weight_used=0,
        )
        is None
    )


@pytest.mark.parametrize("weight_used", [600, 599, 598.9])
def test_ignores_decreases_and_one_gram_noise(weight_used: float):
    assert weight_used_from_ams_percentage(
        print_active=False,
        weight_locked=False,
        remain=40,
        label_weight=1000,
        weight_used=weight_used,
    ) == (600.0 if weight_used == 598.9 else None)


@pytest.mark.parametrize(
    ("print_active", "weight_locked", "remain", "expected"),
    [(False, False, 0, 1000.0), (False, False, 50, 500.0), (True, False, 50, None), (False, True, 50, None)],
)
def test_manual_ams_recovery_is_absolute_but_safe(
    print_active: bool, weight_locked: bool, remain: object, expected: float | None
):
    assert (
        weight_used_from_manual_ams_percentage(
            print_active=print_active,
            weight_locked=weight_locked,
            remain=remain,
            label_weight=1000,
        )
        == expected
    )


def test_rfid_estimate_is_creation_only_and_tolerates_unknown_percentage():
    assert initial_weight_used_from_rfid_percentage(remain=25, label_weight=1000) == 750.0
    assert initial_weight_used_from_rfid_percentage(remain="unknown", label_weight=1000) == 0.0


@pytest.mark.parametrize(
    ("gross_weight", "expected"),
    [(1250, 0.0), (750, 500.0), (0, 1000.0), (float("nan"), None)],
)
def test_scale_measurement_is_absolute(gross_weight: object, expected: float | None):
    assert weight_used_from_scale(gross_weight=gross_weight, label_weight=1000, core_weight=250) == expected


@pytest.mark.parametrize(("grams", "expected"), [(25.5, 25.5), (0, None), (-1, None), (float("inf"), None)])
def test_print_usage_only_allows_positive_finite_deltas(grams: object, expected: float | None):
    assert print_usage_delta(grams) == expected
