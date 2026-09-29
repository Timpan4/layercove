"""Fresh-schema DDL tests for spoolman_slot_assignments."""

import pytest
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.schema import CreateTable

from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment


@pytest.mark.parametrize(
    "dialect",
    [sqlite.dialect(), postgresql.dialect()],
    ids=["sqlite", "postgresql"],
)
def test_fresh_schema_has_spoolman_slot_constraints(dialect):
    ddl = " ".join(str(CreateTable(SpoolmanSlotAssignment.__table__).compile(dialect=dialect)).split())

    assert "CONSTRAINT uq_slot_assignment UNIQUE (printer_id, ams_id, tray_id)" in ddl
    assert (
        "CONSTRAINT ck_ams_id_range CHECK "
        "((ams_id >= 0 AND ams_id <= 7) OR (ams_id >= 128 AND ams_id <= 191) OR ams_id = 255)"
    ) in ddl
    assert "CONSTRAINT ck_tray_id_range CHECK (tray_id >= 0 AND tray_id <= 3)" in ddl
