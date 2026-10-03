"""Real archive list and comparison routes over a read-only fictional database."""

import asyncio
import json
import os
import socket
import sys
import tempfile
from contextlib import asynccontextmanager

import uvicorn
from fastapi import APIRouter, FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


async def main():
    with tempfile.TemporaryDirectory(prefix="layercove-archive-comparison-") as directory:
        os.environ["DATA_DIR"] = directory
        os.environ["LOG_DIR"] = directory
        os.environ["LOG_TO_FILE"] = "false"
        os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{directory}/fixture.db"
        from backend.app import main as registered_models  # noqa: F401
        from backend.app.api.routes import archives
        from backend.app.core import auth
        from backend.app.core.database import Base, get_db
        from backend.app.models.archive import PrintArchive
        from backend.app.models.printer import Printer

        engine = create_async_engine(os.environ["DATABASE_URL"])
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            db.add(
                Printer(
                    id=168,
                    name="Fixture Voron",
                    provider="moonraker",
                    model="Voron 2.4",
                    serial_number="fictional-duration",
                    ip_address=None,
                    access_code=None,
                    is_active=True,
                )
            )
            await db.flush()
            for ident, name, seconds in [
                (1681, "Fixture minute", 1440),
                (1682, "Fixture hours", 7380),
                (1683, "Fixture seconds", 45),
                (1684, "Fixture zero", 0),
                (1685, "Fixture reference", 1800),
            ]:
                db.add(
                    PrintArchive(
                        id=ident,
                        printer_id=168,
                        filename=f"fictional-{ident}.gcode.3mf",
                        print_name=name,
                        file_path="",
                        file_size=0,
                        status="completed",
                        print_time_seconds=seconds,
                        layer_height=0.2,
                        nozzle_diameter=0.4,
                        bed_temperature=60,
                        nozzle_temperature=210,
                        filament_type="PLA",
                        filament_used_grams=12.5,
                    )
                )
            await db.commit()
        auth.async_session = sessions

        async def fixture_db():
            async with sessions() as db:
                yield db

        sock = socket.socket()
        sock.bind((os.environ.get("ARCHIVE_COMPARISON_BIND_HOST", "127.0.0.1"), 0))
        sock.listen()
        port = sock.getsockname()[1]
        writes = []

        @asynccontextmanager
        async def lifespan(_app):
            print("ARCHIVE_COMPARISON_FIXTURE=" + json.dumps({"port": port}), flush=True)
            yield

        app = FastAPI(lifespan=lifespan)
        app.dependency_overrides[get_db] = fixture_db
        router = APIRouter()
        router.routes.extend(
            route
            for route in archives.router.routes
            if "GET" in route.methods and route.path in ["/archives/", "/archives/compare"]
        )
        app.include_router(router, prefix="/api/v1")

        @app.middleware("http")
        async def read_only(request, call_next):
            if request.method != "GET":
                writes.append(f"{request.method} {request.url.path}")
                return JSONResponse({"detail": "Read-only archive fixture"}, status_code=405)
            return await call_next(request)

        @app.get("/health")
        async def health():
            return {"fixture": "read-only archive comparison", "writes": writes, "bind_host": sock.getsockname()[0]}

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
