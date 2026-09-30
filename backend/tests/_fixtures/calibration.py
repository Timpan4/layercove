"""Filament schema exported from pinned Orca 2.4.2 source, for offline workflow tests."""
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from backend.app.schemas.slicer_contract import SlicerProcessSchemaResponse
from backend.app.services.slicer_api import SlicerApiService
from backend.tests.unit.services.test_slicer_api import TestPinnedContract


@pytest.fixture(autouse=True)
def filament_schema(monkeypatch):
    payload = json.loads(Path(__file__).with_name("calibration-filament-schema.json").read_text())
    schema = SlicerProcessSchemaResponse.model_validate({**TestPinnedContract.contract(), **payload})
    monkeypatch.setattr(SlicerApiService, "profile_schema", AsyncMock(return_value=schema))
    return schema
