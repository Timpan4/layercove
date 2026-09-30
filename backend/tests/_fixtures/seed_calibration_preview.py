"""Seed the disconnected calibration preview, never an installed printer database."""
import asyncio
import os

import httpx
from sqlalchemy import select

from backend.app.core.config import settings
from backend.app.core.database import async_session
from backend.app.models.printer import Printer
from backend.app.services.slicer_catalog import (
    CatalogInput,
    CatalogProfile,
    activate_revision,
    approve_review_batch,
    ingest_catalog,
)


async def main():
    if os.environ.get("CALIBRATION_PREVIEW_SEED") != "1" or not str(settings.base_dir).startswith("/tmp/layercove-calibration-preview"):
        raise RuntimeError("Use an isolated /tmp/layercove-calibration-preview data directory")
    async with httpx.AsyncClient() as client:
        response = await client.get(settings.slicer_api_url + "/profiles/bundled")
        response.raise_for_status()
        bundled = response.json()
    names = {"printer": "Voron 2.4 250 0.4 nozzle", "process": "0.20mm Standard @Voron", "filament": "Generic PLA @System"}
    profiles = []
    for kind, name in names.items():
        content = dict(next(row["content"] for row in bundled[kind] if row["name"] == name))
        if kind == "filament":
            content["nozzle_temperature"] = ["210"]
            content["nozzle_temperature_initial_layer"] = ["210"]
        if kind != "printer":
            content["compatible_printers"] = [names["printer"]]
        profiles.append(CatalogProfile(kind, kind, "Preview PLA" if kind == "filament" else "Preview " + kind, content))
    async with async_session() as db:
        if await db.scalar(select(Printer.id)) is not None:
            raise RuntimeError("Preview database already has printers")
        db.add(Printer(name="Preview printer", provider="moonraker", is_active=False))
        catalog = await ingest_catalog(db, CatalogInput(source="local", remote_account_id="calibration-preview", profiles=profiles))
        await approve_review_batch(db, catalog.review_batch_id)
        for revision in catalog.revision_ids:
            await activate_revision(db, revision)
        from backend.app.api.routes.auth import set_auth_enabled, set_setup_completed
        await set_auth_enabled(db, False)
        await set_setup_completed(db, True)
        await db.commit()


if __name__ == "__main__":
    asyncio.run(main())
