"""Exercise nozzle types through HTTP; direct route calls skip JSON serialization."""

import pytest
from sqlalchemy import select

from backend.app.models.printer import Printer
from backend.app.models.slicer_profile_catalog import SlicerProfile
from backend.app.services.printer_manager import printer_manager
from backend.app.services.printer_types import (
    NormalizedPrinterState,
    NozzleSnapshot,
    PrinterProvider,
    PrinterSnapshot,
)
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
    ingest_catalog,
)


@pytest.mark.parametrize("provider", [PrinterProvider.BAMBU, PrinterProvider.MOONRAKER])
@pytest.mark.parametrize("diameter", ["0.25", "0.40", "0.60"])
async def test_binding_nozzle_is_numeric_over_http(async_client, db_session, monkeypatch, provider, diameter):
    printer = Printer(name="Wire-format printer", provider=provider.value, is_active=True)
    db_session.add(printer)
    result = await ingest_catalog(
        db_session,
        CatalogInput(
            source="standard",
            remote_account_id="wire-format-test",
            profiles=[
                CatalogProfile(
                    remote_profile_id=kind,
                    profile_type=kind,
                    display_name=f"Wire-format {kind}",
                    content=(
                        {"nozzle_diameter": [diameter]}
                        if kind == "printer"
                        else {"compatible_printers": ["Wire-format printer"]}
                    ),
                    metadata={"compatible_printers": ["Wire-format printer"]} if kind != "printer" else {},
                )
                for kind in ("printer", "process", "filament")
            ],
        ),
    )
    await approve_review_batch(db_session, result.review_batch_id)
    for revision_id in result.revision_ids:
        await activate_revision(db_session, revision_id)
    await db_session.commit()
    profiles = {profile.profile_type: profile.id for profile in (await db_session.scalars(select(SlicerProfile))).all()}
    live_diameter = float(diameter)

    def snapshot(_printer_id):
        return PrinterSnapshot(
            provider,
            True,
            NormalizedPrinterState.IDLE,
            nozzles=(NozzleSnapshot(0, live_diameter, "confirmed"),),
        )

    monkeypatch.setattr(printer_manager, "get_snapshot", snapshot)
    payload = {
        "printer_id": printer.id,
        "profile_id": profiles["printer"],
        # Decimal inputs and trailing zeroes must not change the response type.
        "expected_nozzle_diameter": diameter,
        "default_process_profile_id": profiles["process"],
        "default_filament_profile_id": profiles["filament"],
    }
    base = "/api/v1/slicer/catalog"
    created = await async_client.post(f"{base}/bindings", json=payload)
    assert created.status_code == 201, created.text
    binding_id = created.json()["id"]
    listed = await async_client.get(f"{base}/bindings", params={"printer_id": printer.id})
    per_printer = await async_client.get(f"{base}/printers/{printer.id}/bindings")
    updated = await async_client.put(f"{base}/bindings/{binding_id}", json={"expected_nozzle_diameter": diameter})
    for response in (listed, per_printer, updated):
        assert response.status_code == 200, response.text
    for binding in (created.json(), listed.json()[0], per_printer.json()[0], updated.json()):
        assert isinstance(binding["expected_nozzle_diameter"], (int, float)), binding
        assert binding["expected_nozzle_diameter"] == binding["nozzle"]["diameter"] == float(diameter)
        assert binding["readiness"]["state"] == "ready"

    # Serialization must not weaken the authoritative mismatch check.
    live_diameter = 0.8
    mismatched = await async_client.get(f"{base}/printers/{printer.id}/bindings")
    assert mismatched.status_code == 200, mismatched.text
    assert mismatched.json()[0]["readiness"] == {"state": "blocked", "reason_codes": ["nozzle_mismatch"]}
