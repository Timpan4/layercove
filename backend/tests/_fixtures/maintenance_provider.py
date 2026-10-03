"""Real maintenance routes over an isolated fictional database, with read-only HTTP."""

import asyncio
import json
import os
import socket
import sys
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime

import uvicorn
from fastapi import APIRouter, FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


async def main():
    with tempfile.TemporaryDirectory(prefix="layercove-provider-maintenance-") as directory:
        os.environ["DATA_DIR"] = directory
        os.environ["LOG_DIR"] = directory
        os.environ["LOG_TO_FILE"] = "false"
        os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{directory}/fixture.db"
        from backend.app import main as registered_models  # noqa: F401
        from backend.app.api.routes import maintenance
        from backend.app.core import auth
        from backend.app.core.database import Base, get_db
        from backend.app.models.maintenance import MaintenanceHistory, MaintenanceType, PrinterMaintenance
        from backend.app.models.printer import Printer

        engine = create_async_engine(os.environ["DATABASE_URL"])
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            printers = [
                (901, "Fixture Voron", "moonraker", "Voron 2.4"),
                (902, "Fixture Bambu X1C", "bambu", "X1C"),
                (903, "Fixture Bambu P2S", "bambu", "P2S"),
                (904, "Fixture Bambu A1 Mini", "bambu", "A1 Mini"),
                (905, "Fixture Bambu H2D", "bambu", "H2D"),
                (906, "Fixture Unknown Bambu", "bambu", "UNKNOWN"),
                (907, "Fixture Moonraker X1C", "moonraker", "X1C"),
            ]
            for ident, name, provider, model in printers:
                db.add(
                    Printer(
                        id=ident,
                        name=name,
                        provider=provider,
                        model=model,
                        is_active=True,
                        runtime_seconds=7200,
                        print_hours_offset=121.5,
                        serial_number=f"fictional-{ident}",
                        ip_address=None,
                        access_code=None,
                    )
                )
            await db.commit()
            await maintenance.ensure_default_types(db)
            carbon = (
                await db.execute(
                    select(MaintenanceType).where(
                        MaintenanceType.name == "Clean Carbon Rods", MaintenanceType.is_system.is_(True)
                    )
                )
            ).scalar_one()
            custom = MaintenanceType(
                name="Replace HEPA Filter",
                is_system=False,
                default_interval_hours=37,
                interval_type="days",
                icon="Filter",
                wiki_url="https://example.invalid/operator-guide",
            )
            db.add(custom)
            await db.flush()
            inherited = PrinterMaintenance(
                printer_id=901,
                maintenance_type_id=carbon.id,
                enabled=False,
                custom_interval_hours=71,
                custom_interval_type="days",
                last_performed_hours=17.5,
                last_performed_at=datetime(2026, 1, 2),
            )
            db.add(inherited)
            await db.flush()
            db.add(
                MaintenanceHistory(
                    printer_maintenance_id=inherited.id,
                    hours_at_maintenance=17.5,
                    performed_at=datetime(2026, 1, 2),
                    notes="Fictional saved operator history",
                )
            )
            for ident in [901, 902]:
                db.add(
                    PrinterMaintenance(
                        printer_id=ident,
                        maintenance_type_id=custom.id,
                        enabled=False,
                        custom_interval_hours=37,
                        custom_interval_type="days",
                        last_performed_hours=21.5,
                        last_performed_at=datetime(2026, 2, 3),
                    )
                )
            await db.commit()
        auth.async_session = sessions

        async def fixture_db():
            async with sessions() as db:
                yield db

        sock = socket.socket()
        sock.bind(("0.0.0.0", 0))
        sock.listen()
        port = sock.getsockname()[1]
        writes = []

        @asynccontextmanager
        async def lifespan(_app):
            print("MAINTENANCE_PROVIDER_FIXTURE=" + json.dumps({"port": port}), flush=True)
            yield

        app = FastAPI(lifespan=lifespan)
        app.dependency_overrides[get_db] = fixture_db
        router = APIRouter()
        router.routes.extend(route for route in maintenance.router.routes if "GET" in route.methods)
        app.include_router(router, prefix="/api/v1")

        @app.middleware("http")
        async def read_only(request, call_next):
            if request.method != "GET":
                writes.append(f"{request.method} {request.url.path}")
                return JSONResponse({"detail": "Read-only maintenance fixture"}, status_code=405)
            return await call_next(request)

        @app.get("/health")
        async def health():
            return {"fixture": "read-only provider maintenance", "writes": writes}

        server = uvicorn.Server(uvicorn.Config(app, log_level="error", access_log=False))

        async def shutdown_on_stdin():
            await asyncio.to_thread(sys.stdin.readline)
            server.should_exit = True

        try:
            await asyncio.gather(server.serve(sockets=[sock]), shutdown_on_stdin())
        finally:
            sock.close()
            await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
