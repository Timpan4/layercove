"""Read-only real statistics routes with an isolated, fictional database."""

import asyncio
import json
import os
import socket
import sys
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import uvicorn
from fastapi import APIRouter, FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


async def main():
    with tempfile.TemporaryDirectory(prefix="layercove-stats-export-") as directory:
        os.environ["DATA_DIR"] = directory
        os.environ["LOG_DIR"] = directory
        os.environ["LOG_TO_FILE"] = "false"
        os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{directory}/fixture.db"
        from backend.app import main as registered_models  # noqa: F401
        from backend.app.api.routes import archives
        from backend.app.core import auth
        from backend.app.core.database import Base, get_db
        from backend.app.models.print_log import PrintLogEntry
        from backend.app.models.user import User

        engine = create_async_engine(os.environ["DATABASE_URL"])
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            db.add_all([User(id=901, username="Fixture Alice"), User(id=902, username="Fixture Bob")])
            await db.flush()
            now = datetime.now(timezone.utc)
            for created_at, status, user in [
                (datetime(2020, 1, 5, tzinfo=timezone.utc), "completed", 901),
                (datetime(2020, 1, 12, 23, 59, 59, tzinfo=timezone.utc), "failed", 901),
                (datetime(2020, 1, 7, tzinfo=timezone.utc), "failed", None),
                (now - timedelta(days=10), "completed", 901),
                (now - timedelta(days=60), "failed", 902),
            ]:
                db.add(
                    PrintLogEntry(
                        created_at=created_at,
                        status=status,
                        created_by_id=user,
                        print_name="Fictional export run",
                        filament_type="PLA",
                        failure_reason="Fixture failure" if status == "failed" else None,
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

        @asynccontextmanager
        async def lifespan(_app):
            print("STATS_EXPORT_FIXTURE=" + json.dumps({"port": port}), flush=True)
            yield

        app = FastAPI(lifespan=lifespan)
        app.dependency_overrides[get_db] = fixture_db
        router = APIRouter()
        allowed = {"/archives/stats/export", "/archives/stats", "/archives/analysis/failures"}
        router.routes.extend(route for route in archives.router.routes if route.path in allowed)
        app.include_router(router, prefix="/api/v1")

        @app.get("/health")
        async def health():
            return {"fixture": "read-only statistics exports"}

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
