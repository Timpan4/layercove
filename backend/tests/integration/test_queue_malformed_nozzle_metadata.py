"""Malformed slicer nozzle metadata must not break queue reads."""

import pytest
from httpx import AsyncClient

from backend.app.models.archive import PrintArchive
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer


@pytest.mark.asyncio
@pytest.mark.integration
async def test_queue_list_survives_malformed_nozzle_json(async_client: AsyncClient, db_session):
    printer = Printer(
        name="N", ip_address="192.168.8.8", serial_number="NZ0000000001", access_code="12345678", model="H2C"
    )
    archive = PrintArchive(
        filename="a.3mf",
        print_name="a",
        file_path="archives/a.3mf",
        file_size=1,
        content_hash="nzhash",
        status="completed",
    )
    db_session.add_all([printer, archive])
    await db_session.commit()
    db_session.add(
        PrintQueueItem(
            printer_id=printer.id,
            archive_id=archive.id,
            status="pending",
            position=1,
            nozzle_mapping='{"bad": 1}',
            nozzles_info="[1]",
        )
    )
    await db_session.commit()

    resp = await async_client.get("/api/v1/queue/")
    assert resp.status_code == 200
    assert resp.json()[0]["nozzle_mapping"] is None


def test_vp_nozzle_mapping_rejects_non_integer_lists():
    from backend.app.services.virtual_printer.manager import _nozzle_mapping_json

    assert _nozzle_mapping_json({"bad": 1}, "vp") is None
    assert _nozzle_mapping_json('[1, "x"]', "vp") is None
    assert _nozzle_mapping_json("[0, 1]", "vp") == "[0, 1]"
    assert _nozzle_mapping_json(None, "vp") is None
