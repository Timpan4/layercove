"""Tests for library files displaying filenames instead of embedded 3MF titles."""

from backend.app.api.routes.library import _without_print_name

# --- _without_print_name ---------------------------------------------------


def test_strips_print_name_keeps_siblings():
    cleaned = _without_print_name({"print_name": "Exported 3D Model", "print_time_seconds": 100})
    assert cleaned == {"print_time_seconds": 100}


def test_none_passes_through():
    assert _without_print_name(None) is None


def test_dict_without_print_name_returned_unchanged():
    meta = {"print_time_seconds": 50}
    # No copy needed when there's nothing to strip — same object back.
    assert _without_print_name(meta) is meta


def test_does_not_mutate_input():
    original = {"print_name": "Whatever", "filament_used_grams": 12}
    cleaned = _without_print_name(original)
    assert original == {"print_name": "Whatever", "filament_used_grams": 12}  # untouched
    assert cleaned == {"filament_used_grams": 12}


def test_print_name_only_collapses_to_empty_dict():
    assert _without_print_name({"print_name": "Exported 3D Model"}) == {}
