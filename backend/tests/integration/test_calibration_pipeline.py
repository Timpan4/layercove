"""Calibration transport, durable artifact, and printer dispatch through public HTTP."""

import json
from email.parser import BytesParser
from email.policy import default
from unittest.mock import AsyncMock

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.api.routes import slicer_catalog_bindings
from backend.app.core.config import settings
from backend.app.models.library import LibraryFile
from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.slicer_profile_catalog import SlicerProfile, SlicerProfileActivation
from backend.app.services import print_scheduler, printer_manager, slicer_api, slicer_catalog_selection
from backend.app.services.print_scheduler import PrintScheduler
from backend.app.services.printer_backend_registry import PrinterBackendRegistry
from backend.app.services.printer_manager import PrinterManager
from backend.app.services.printer_types import PrinterProvider
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
    ingest_catalog,
)
from backend.tests._fixtures.calibration import filament_schema  # noqa: F401
from backend.tests.integration.test_fake_moonraker import _backend, _wait_for
from backend.tests.integration.test_library_slice_api import _wait_for_job
from backend.tests.unit.services.test_slicer_api import TestPinnedContract as PinnedContractFixture


async def test_calibration_generates_a_pinned_artifact_and_dispatches_to_the_selected_printer(
    async_client,
    db_session,
    test_engine,
    fake_moonraker,
    monkeypatch,
    tmp_path,
):
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archive")
    monkeypatch.setattr(settings, "slicer_api_url", "http://calibration-orca.test:3000")
    printer = Printer(
        name="Calibration printer",
        provider="moonraker",
        moonraker_config=MoonrakerPrinterConfig(base_url=fake_moonraker.base_url),
    )
    db_session.add(printer)
    catalog = await ingest_catalog(
        db_session,
        CatalogInput(
            source="local",
            remote_account_id="calibration-pipeline",
            profiles=[
                CatalogProfile(
                    kind,
                    kind,
                    f"Calibration {kind}",
                    {
                        "name": f"Calibration {kind}",
                        "type": kind,
                        **(
                            {"gcode_flavor": "klipper", "nozzle_diameter": ["0.4"]}
                            if kind == "printer"
                            else {"compatible_printers": ["Calibration printer"]}
                        ),
                    },
                )
                for kind in ("printer", "process", "filament")
            ],
        ),
    )
    await approve_review_batch(db_session, catalog.review_batch_id)
    for revision in catalog.revision_ids:
        await activate_revision(db_session, revision)
    await db_session.commit()
    profiles = {row.profile_type: row.id for row in (await db_session.scalars(select(SlicerProfile))).all()}
    fake_moonraker.status["configfile"] = {"settings": {"extruder": {"nozzle_diameter": 0.4}}}
    registry = PrinterBackendRegistry()
    registry.register(
        PrinterProvider.MOONRAKER,
        lambda _printer, *, emit: _backend(fake_moonraker, monkeypatch, emit, bootstrap_timeout=5),
    )
    manager = PrinterManager(registry)
    monkeypatch.setattr(manager, "_sync_moonraker_cameras_once", AsyncMock())
    for module in (printer_manager, slicer_catalog_selection, slicer_catalog_bindings, print_scheduler):
        monkeypatch.setattr(module, "printer_manager", manager)
    monkeypatch.setattr(print_scheduler, "async_session", async_sessionmaker(test_engine, expire_on_commit=False))
    scheduler = PrintScheduler()
    monkeypatch.setattr(print_scheduler, "scheduler", scheduler)
    await manager.connect_printer(printer)
    await _wait_for(lambda: manager.get_snapshot(printer.id).connected, timeout=5)
    schema = PinnedContractFixture.schema_payload()
    identity = PinnedContractFixture.contract()
    identity["calibration"] = {"available": True, "version": "1"}
    raw_gcode = b"; gcode_flavor = klipper\n; filament_type = PLA\nG28\nG1 X10 Y10\n"
    fields = []

    def sidecar(request):
        if request.url.path == "/capabilities":
            return httpx.Response(200, json=identity)
        if request.url.path == "/schema/process":
            return httpx.Response(200, json={**identity, **schema})
        if request.method == "POST" and request.url.path == "/slice":
            message = BytesParser(policy=default).parsebytes(
                f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode() + request.read()
            )
            fields.append(
                {
                    part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
                    for part in message.iter_parts()
                }
            )
            return httpx.Response(200, content=raw_gcode, headers={"X-Print-Time-Seconds": "60"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(sidecar))
    slicer_api.set_shared_http_client(client)
    try:
        binding = await async_client.post(
            "/api/v1/slicer/catalog/bindings",
            json={
                "printer_id": printer.id,
                "profile_id": profiles["printer"],
                "expected_nozzle_diameter": 0.4,
                "default_process_profile_id": profiles["process"],
                "default_filament_profile_id": profiles["filament"],
            },
        )
        assert binding.status_code == 201, binding.text
        activation = await db_session.scalar(
            select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == profiles["filament"])
        )
        started = await async_client.post(
            "/api/v1/calibration/sessions",
            json={
                "printer_id": printer.id,
                "filament_profile_id": profiles["filament"],
                "filament_revision_id": activation.revision_id,
                "nozzle_diameter": 0.4,
            },
        )
        assert started.status_code == 201, started.text
        session = started.json()
        base = f"/api/v1/calibration/sessions/{session['id']}"
        updated = await async_client.put(
            base + "/parameters/temperature",
            json={"version": session["version"], "lowest": 200, "highest": 220, "increment": 5, "baseline": 210},
        )
        session = updated.json()
        generated = await async_client.post(
            base + "/generate/temperature",
            json={
                "version": session["version"],
                "binding_id": binding.json()["id"],
                "process_profile_id": profiles["process"],
            },
        )
        assert generated.status_code == 200, generated.text
        session = generated.json()
        job = await _wait_for_job(async_client, session["runs"]["temperature"])
        assert job["status"] == "completed", job
        assert job["provenance"]["filament_revision_ids"] == [activation.revision_id]
        assert "file" not in fields[0]
        assert json.loads(fields[0]["calibration"])["highest"] == 220
        artifact = await db_session.get(LibraryFile, job["result"]["library_file_id"])
        assert (tmp_path / artifact.file_path).read_bytes() == raw_gcode
        # Changing the displayed range must retire the old printable test.
        changed = await async_client.put(
            base + "/parameters/temperature",
            json={"version": session["version"], "lowest": 205, "highest": 220, "increment": 5, "baseline": 210},
        )
        session = changed.json()
        assert "temperature" not in session["runs"]
        stale = await async_client.post(
            base + "/print/temperature", json={"version": session["version"], "plate_clear": True}
        )
        assert stale.status_code == 409
        regenerated = await async_client.post(
            base + "/generate/temperature",
            json={
                "version": session["version"],
                "binding_id": binding.json()["id"],
                "process_profile_id": profiles["process"],
            },
        )
        session = regenerated.json()
        assert (await _wait_for_job(async_client, session["runs"]["temperature"]))["status"] == "completed"
        wrong_provider = await async_client.post(
            base + "/print/temperature",
            json={"version": session["version"], "plate_clear": True, "use_ams": True, "ams_mapping": [0]},
        )
        assert wrong_provider.status_code == 422, wrong_provider.text
        stale_mapping = await async_client.post(
            base + "/print/temperature",
            json={"version": session["version"], "plate_clear": True, "use_ams": False, "ams_mapping": [0]},
        )
        assert stale_mapping.status_code == 422, stale_mapping.text
        # Firmware may nest the AMS unit list under an "ams" object.
        from dataclasses import replace
        from types import SimpleNamespace

        original_snapshot = manager.get_snapshot(printer.id)
        with monkeypatch.context() as context:
            context.setattr(
                manager, "get_snapshot", lambda _id: replace(original_snapshot, provider=PrinterProvider.BAMBU)
            )
            context.setattr(
                manager,
                "get_bambu_state",
                lambda _id: SimpleNamespace(
                    raw_data={"ams": {"ams": [{"id": "0", "tray": [{"id": "0", "tray_type": "PETG"}]}]}}
                ),
            )
            wrong_material = await async_client.post(
                base + "/print/temperature",
                json={"version": session["version"], "plate_clear": True, "use_ams": True, "ams_mapping": [0]},
            )
            assert wrong_material.status_code == 409, wrong_material.text
        printed = await async_client.post(
            base + "/print/temperature", json={"version": session["version"], "plate_clear": True}
        )
        assert printed.status_code == 200, printed.text
        session = printed.json()
        queue_id = session["prints"]["temperature"]
        blocked = await async_client.put(
            base + "/results/temperature", json={"version": session["version"], "value": 210}
        )
        assert blocked.status_code == 409
        await scheduler.check_queue()
        assert fake_moonraker.uploads[0][1] == raw_gcode
        assert fake_moonraker.commands == [("start", fake_moonraker.upload_paths[0])]
        queued = await db_session.get(PrintQueueItem, queue_id)
        assert queued.printer_id == printer.id
        assert queued.provider_correlation_id in fake_moonraker.upload_paths[0]
    finally:
        slicer_api.set_shared_http_client(None)
        await client.aclose()
        await manager.disconnect_printer_async(printer.id)
