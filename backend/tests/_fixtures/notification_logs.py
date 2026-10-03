"""Isolated notification log routes. Only cleanup of fictional rows can write."""

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
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


async def main():
    with tempfile.TemporaryDirectory(prefix="layercove-notification-log-") as directory:
        os.environ["DATA_DIR"] = directory
        os.environ["LOG_DIR"] = directory
        os.environ["LOG_TO_FILE"] = "false"
        os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{directory}/fixture.db"
        from backend.app import main as registered_models  # noqa: F401
        from backend.app.api.routes import notifications
        from backend.app.core import auth
        from backend.app.core.database import Base, get_db
        from backend.app.models.notification import NotificationLog, NotificationProvider

        engine = create_async_engine(os.environ["DATABASE_URL"])
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as db:
            db.add(
                NotificationProvider(
                    id=268, name="Fixture notifications", provider_type="ntfy", config="{}", enabled=False
                )
            )
            await db.flush()
            if os.environ.get("NOTIFICATION_LOG_FIXTURE_EMPTY") != "1":
                now = datetime.now(timezone.utc)
                for ident, name, age, success in [
                    (1, "Recent", 1 / 24, True),
                    (2, "Six-day failed", 6, False),
                    (3, "Twenty-day", 20, True),
                    (4, "Forty-day failed", 40, False),
                    (5, "Eighty-day", 80, True),
                ]:
                    db.add(
                        NotificationLog(
                            id=ident,
                            provider_id=268,
                            event_type="test",
                            title=name,
                            message="Fictional notification, never sent",
                            success=success,
                            printer_name=name,
                            created_at=now - timedelta(days=age),
                            error_message=None if success else "Fictional delivery failure",
                        )
                    )
            await db.commit()
        auth.async_session = sessions

        async def fixture_db():
            async with sessions() as db:
                yield db

        sock = socket.socket()
        sock.bind((os.environ.get("NOTIFICATION_LOG_BIND_HOST", "127.0.0.1"), 0))
        sock.listen()
        port = sock.getsockname()[1]
        writes = []

        @asynccontextmanager
        async def lifespan(_app):
            print("NOTIFICATION_LOG_FIXTURE=" + json.dumps({"port": port}), flush=True)
            yield

        app = FastAPI(lifespan=lifespan)
        app.dependency_overrides[get_db] = fixture_db
        router = APIRouter()
        router.routes.extend(
            route
            for route in notifications.router.routes
            if route.path in ["/notifications/logs", "/notifications/logs/stats"]
        )
        app.include_router(router, prefix="/api/v1")

        @app.middleware("http")
        async def fictional_only(request, call_next):
            if request.method != "GET":
                allowed = request.method == "DELETE" and request.url.path == "/api/v1/notifications/logs"
                writes.append(
                    {"method": request.method, "path": request.url.path, "query": request.url.query, "allowed": allowed}
                )
                if not allowed:
                    return JSONResponse({"detail": "Fictional cleanup only"}, status_code=405)
            return await call_next(request)

        @app.get("/health")
        async def health():
            async with sessions() as db:
                ids = list((await db.execute(select(NotificationLog.id).order_by(NotificationLog.id))).scalars())
            return {
                "fixture": "isolated fictional notification logs",
                "record_ids": ids,
                "writes": writes,
                "bind_host": sock.getsockname()[0],
            }

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
