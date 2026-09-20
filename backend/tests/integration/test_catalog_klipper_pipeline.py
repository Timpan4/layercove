"""Physical-printer selection through slicing, persistence, queue, and real HTTP upload."""

import asyncio
import hashlib
import io
import json
import zipfile
from email.parser import BytesParser
from email.policy import default
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.api.routes import slicer_catalog_bindings
from backend.app.core.config import settings
from backend.app.models.archive import PrintArchive
from backend.app.models.library import LibraryFile
from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
from backend.app.models.print_queue import PrintQueueItem
from backend.app.models.printer import Printer
from backend.app.models.settings import Settings
from backend.app.models.slice_job import SliceJobRecord
from backend.app.models.slicer_profile_catalog import SlicerJobProvenance, SlicerProfile, SlicerProfileActivation
from backend.app.services import print_scheduler, slicer_api, slicer_catalog_selection
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
from backend.tests.integration.test_fake_moonraker import _backend, _wait_for
from backend.tests.integration.test_library_slice_api import _wait_for_job


@pytest.mark.parametrize("edit_filament", [False, True])
@pytest.mark.parametrize("source_kind", ["library", "archive"])
@pytest.mark.parametrize("packaged_response", [False, True])
async def test_catalog_slice_reaches_moonraker_as_raw_gcode(
    async_client,
    db_session,
    test_engine,
    fake_moonraker,
    monkeypatch,
    tmp_path,
    source_kind,
    packaged_response,
    edit_filament,
):
    """Only the external slicer is replaced; no slice/pin/persist/dispatch logic is mocked."""
    monkeypatch.setattr(settings, "base_dir", tmp_path)
    monkeypatch.setattr(settings, "archive_dir", tmp_path / "archive")
    monkeypatch.setattr(settings, "slicer_api_url", "http://orca.test:3000")
    db_session.add(Settings(key="preferred_slicer", value="bambu_studio"))
    printer = Printer(
        name="Physical device",
        provider="moonraker",
        moonraker_config=MoonrakerPrinterConfig(base_url=fake_moonraker.base_url),
    )
    db_session.add(printer)
    result = await ingest_catalog(
        db_session,
        CatalogInput(
            source="local",
            remote_account_id="pipeline",
            profiles=[
                CatalogProfile(
                    kind,
                    kind,
                    f"Pipeline {kind}",
                    {
                        "name": f"Pipeline {kind}",
                        "type": kind,
                        **(
                            {"gcode_flavor": "klipper", "nozzle_diameter": ["0.4"]}
                            if kind == "printer"
                            else {"compatible_printers": ["Pipeline printer"]}
                        ),
                    },
                )
                for kind in ("printer", "process", "filament")
            ],
        ),
    )
    await approve_review_batch(db_session, result.review_batch_id)
    for revision_id in result.revision_ids:
        await activate_revision(db_session, revision_id)
    await db_session.commit()
    profiles = {row.profile_type: row.id for row in (await db_session.scalars(select(SlicerProfile))).all()}
    printer_id = printer.id
    fake_moonraker.status["configfile"] = {"settings": {"extruder": {"nozzle_diameter": 0.4}}}
    registry = PrinterBackendRegistry()
    registry.register(
        PrinterProvider.MOONRAKER,
        lambda _printer, *, emit: _backend(fake_moonraker, monkeypatch, emit, bootstrap_timeout=5),
    )
    manager = PrinterManager(registry)
    monkeypatch.setattr(manager, "_sync_moonraker_cameras_once", AsyncMock())
    monkeypatch.setattr(slicer_catalog_selection, "printer_manager", manager)
    monkeypatch.setattr(slicer_catalog_bindings, "printer_manager", manager)
    monkeypatch.setattr(print_scheduler, "printer_manager", manager)
    monkeypatch.setattr(print_scheduler, "async_session", async_sessionmaker(test_engine, expire_on_commit=False))
    monkeypatch.setattr(print_scheduler.notification_service, "on_queue_job_started", AsyncMock())
    monkeypatch.setattr(print_scheduler.notification_service, "on_queue_job_failed", AsyncMock())
    messages = []

    async def record_message(_user, payload):
        messages.append(payload)

    monkeypatch.setattr(print_scheduler.ws_manager, "broadcast_to_user", record_message)
    scheduler = PrintScheduler()
    monkeypatch.setattr(scheduler, "_propagate_owner_to_printer_manager", AsyncMock())
    await manager.connect_printer(printer)
    await _wait_for(lambda: manager.get_snapshot(printer_id).connected, timeout=5)

    raw_gcode = b"; gcode_flavor = klipper\nG28\nG1 X10 Y10\n"
    packaged = io.BytesIO()
    with zipfile.ZipFile(packaged, "w") as bundle:
        bundle.writestr("Metadata/plate_1.gcode", raw_gcode)
    captured = []

    def sidecar(request):
        if request.method != "POST":
            return httpx.Response(404)
        message = BytesParser(policy=default).parsebytes(
            f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode() + request.read()
        )
        fields = {
            part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
            for part in message.iter_parts()
        }
        captured.append((str(request.url), fields))
        return httpx.Response(200, content=packaged.getvalue() if packaged_response else raw_gcode)

    sidecar_client = httpx.AsyncClient(transport=httpx.MockTransport(sidecar))
    slicer_api.set_shared_http_client(sidecar_client)
    try:
        binding_response = await async_client.post(
            "/api/v1/slicer/catalog/bindings",
            json={
                "printer_id": printer_id,
                "profile_id": profiles["printer"],
                "expected_nozzle_diameter": 0.4,
                "default_process_profile_id": profiles["process"],
                "default_filament_profile_id": profiles["filament"],
            },
        )
        assert binding_response.status_code == 201, binding_response.text
        assert binding_response.json()["readiness"]["state"] == "ready"
        if source_kind == "library":
            model_path = tmp_path / "cube.stl"
            model_path.write_bytes(b"solid cube\nendsolid\n")
            source = LibraryFile(filename=model_path.name, file_path=model_path.name, file_type="stl", file_size=22)
            db_session.add(source)
            await db_session.commit()
            endpoint = f"/api/v1/library/files/{source.id}/slice"
        else:
            model_path = tmp_path / "source.3mf"
            with zipfile.ZipFile(model_path, "w") as bundle:
                bundle.writestr("3D/3dmodel.model", "<model/>")
            source = PrintArchive(
                filename=model_path.name,
                file_path=model_path.name,
                file_size=model_path.stat().st_size,
                status="archived",
            )
            db_session.add(source)
            await db_session.commit()
            endpoint = f"/api/v1/archives/{source.id}/slice"
        if edit_filament:
            activation = await db_session.scalar(
                select(SlicerProfileActivation).where(SlicerProfileActivation.profile_id == profiles["filament"])
            )
            copied = await async_client.post(
                f"/api/v1/slicer/catalog/profiles/{profiles['filament']}/filament-copy",
                json={
                    "base_revision_id": activation.revision_id,
                    "name": "Edited filament",
                    "overrides": {"nozzle_temperature": ["237"], "filament_flow_ratio": ["0.97"]},
                    "share_local_copy": True,
                },
            )
            assert copied.status_code == 201, copied.text
            profiles["filament"] = copied.json()["profile_id"]
        # Deliberately omit the destination, reproducing the original workbench request.
        # The durable selection must derive it from the stored physical provider.
        response = await async_client.post(
            endpoint,
            json={
                "arrange": True,
                "printer_preset": {"source": "local", "id": "printer"},
                "process_preset": {"source": "local", "id": "process"},
                "filament_presets": [{"source": "local", "id": "filament"}],
                "catalog_printer_id": printer_id,
                "catalog_binding_id": binding_response.json()["id"],
                "catalog_process_profile_id": profiles["process"],
                "catalog_filament_profile_ids": [profiles["filament"]],
            },
        )
        assert response.status_code == 202, response.text
        slice_id = response.json()["job_id"]
        completed = await _wait_for_job(async_client, slice_id)
        assert len(captured) == 1
        assert captured[0][0].startswith("http://orca.test:3000/")
        assert captured[0][1].get("exportType") != b"3mf"
        assert captured[0][1].get("arrange") == b"true"
        assert "modelState" not in captured[0][1]  # Independent of unsupported bridge transforms.
        if edit_filament:
            assert any(b'"nozzle_temperature": ["237"]' in value for value in captured[0][1].values())
            assert any(b'"filament_flow_ratio": ["0.97"]' in value for value in captured[0][1].values())
        assert any(b'"gcode_flavor": "klipper"' in value for value in captured[0][1].values())
        stored_job = await db_session.get(SliceJobRecord, slice_id)
        assert stored_job.request_snapshot["destination_artifact_kind"] == "klipper_gcode"
        fingerprint = hashlib.sha256(
            json.dumps(
                stored_job.request_snapshot,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode()
        ).hexdigest()
        assert stored_job.request_fingerprint == fingerprint
        provenance = await db_session.scalar(
            select(SlicerJobProvenance).where(SlicerJobProvenance.slice_job_id == slice_id)
        )
        assert provenance.provenance_state == "resolved"
        assert provenance.printer_revision_id is not None
        if packaged_response:
            assert completed["status"] == "failed", completed
            assert "invalid Klipper artifact" in completed["error_detail"]
            assert fake_moonraker.uploads == []
            assert (await db_session.scalars(select(LibraryFile))).all() == (
                [source] if source_kind == "library" else []
            )
            assert (await db_session.scalars(select(PrintArchive))).all() == (
                [source] if source_kind == "archive" else []
            )
            return
        assert completed["status"] == "completed", completed
        result = completed["result"]
        artifact_id = result["library_file_id" if source_kind == "library" else "archive_id"]
        artifact = await db_session.get(LibraryFile if source_kind == "library" else PrintArchive, artifact_id)
        assert artifact.filename.endswith(".gcode") and not artifact.filename.endswith(".3mf")
        assert (tmp_path / artifact.file_path).read_bytes() == raw_gcode
        queued = await async_client.post(
            "/api/v1/queue/",
            json={
                "printer_id": printer_id,
                "library_file_id" if source_kind == "library" else "archive_id": artifact_id,
                "require_previous_success": False,
            },
        )
        assert queued.status_code == 200, queued.text
        item_id = queued.json()["id"]
        assert queued.json()["status"] == "pending"
        await scheduler.check_queue()
        await asyncio.sleep(0)  # Drain the thread-to-event-loop byte progress bridge.
        events = [event for event in messages if event.get("queue_item_id") == item_id]
        assert any(event["type"] == "queue_item_uploading" for event in events)
        assert any(
            event["type"] == "queue_item_upload_progress" and event["bytes_transferred"] == len(raw_gcode)
            for event in events
        )
        stages = [
            event.get("stage", event["type"]) for event in events if event["type"] != "queue_item_upload_progress"
        ]
        assert (
            stages.index("preparing")
            < stages.index("queue_item_uploading")
            < stages.index("awaiting_printer")
            < stages.index("queue_item_acked")
        )
        status = await async_client.get(f"/api/v1/queue/{item_id}")
        assert status.status_code == 200, status.text
        assert status.json()["status"] == "printing", status.text
        assert len(fake_moonraker.uploads) == 1
        remote_name, content = fake_moonraker.uploads[0]
        assert content == raw_gcode
        assert remote_name.endswith(".gcode")
        assert remote_name.startswith(f"{Path(artifact.filename).stem}-")
        assert fake_moonraker.commands == [("start", f"queue/{remote_name}")]
        queued_row = await db_session.get(PrintQueueItem, item_id)
        assert queued_row.provider_correlation_id
        assert queued_row.start_reconcile_after is None
    finally:
        slicer_api.set_shared_http_client(None)
        await sidecar_client.aclose()
        await manager.disconnect_printer_async(printer_id)
