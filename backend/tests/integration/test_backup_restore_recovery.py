import io
import os
import shutil
import sqlite3
import zipfile
from contextlib import closing
from unittest.mock import AsyncMock

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import insert, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.api.routes import settings as settings_routes
from backend.app.core import database, encryption
from backend.app.core.config import settings
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.models.user_totp import UserTOTP


def write_database(path, value):
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE settings (id INTEGER PRIMARY KEY, key TEXT, value TEXT)")
        connection.execute("INSERT INTO settings VALUES (1, 'currency', ?)", (value,))


@pytest.fixture
def restore_fixture(monkeypatch, tmp_path):
    live = tmp_path / "live"
    live.mkdir()
    key = live / ".mfa_encryption_key"
    original_key = Fernet.generate_key()
    key.write_bytes(original_key)
    archive = live / "archive"
    archive.mkdir()
    (archive / "old.txt").write_text("original", encoding="utf-8")
    current_db = live / "layercove.db"
    write_database(current_db, "SEK")
    backup = tmp_path / "backup.db"
    write_database(backup, "EUR")
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as zipped:
        zipped.write(backup, "layercove.db")
        zipped.writestr(".mfa_encryption_key", Fernet.generate_key())
        zipped.writestr("archive/new.txt", "replacement")

    monkeypatch.setenv("DATA_DIR", str(live))
    monkeypatch.setattr(settings, "base_dir", live)
    monkeypatch.setattr(settings, "archive_dir", archive)
    monkeypatch.setattr(settings, "database_url", f"sqlite+aiosqlite:///{current_db}")
    monkeypatch.setattr(database, "close_all_connections", AsyncMock())
    monkeypatch.setattr(database, "reinitialize_database", AsyncMock())
    monkeypatch.setattr(database, "init_db", AsyncMock())
    monkeypatch.setattr("backend.app.services.print_scheduler.scheduler.stop", lambda: None)
    monkeypatch.setattr("backend.app.services.smart_plug_manager.smart_plug_manager.stop_scheduler", lambda: None)
    monkeypatch.setattr(
        "backend.app.services.notification_service.notification_service.stop_digest_scheduler", lambda: None
    )
    monkeypatch.setattr(settings_routes, "_resume_background_services", lambda: None)

    def assert_original():
        if key.read_bytes() != original_key:
            pytest.fail("Restore replaced the original encryption key")
        assert (archive / "old.txt").read_text(encoding="utf-8") == "original"
        with closing(sqlite3.connect(current_db)) as db:
            assert db.execute("SELECT value FROM settings WHERE key = 'currency'").fetchone() == ("SEK",)

    return {"file": ("backup.zip", payload.getvalue(), "application/zip")}, assert_original


@pytest.mark.integration
async def test_import_failure_preserves_live_key_database_and_files(async_client, monkeypatch, restore_fixture):
    files, assert_original = restore_fixture
    monkeypatch.setattr("backend.app.core.db_dialect.is_sqlite", lambda: False)
    monkeypatch.setattr(
        settings_routes, "_import_sqlite_to_postgres", AsyncMock(side_effect=RuntimeError("fixture import failure"))
    )

    response = await async_client.post("/api/v1/settings/restore", files=files)

    assert response.status_code == 500
    assert_original()


@pytest.mark.integration
async def test_file_failure_aborts_restore_with_original_files(async_client, monkeypatch, restore_fixture):
    files, assert_original = restore_fixture
    copy2 = shutil.copy2

    def copy_file(source, target, *args, **kwargs):
        if os.fspath(source).endswith("/new.txt"):
            raise OSError("fixture storage failure")
        return copy2(source, target, *args, **kwargs)

    monkeypatch.setattr(shutil, "copy2", copy_file)
    response = await async_client.post("/api/v1/settings/restore", files=files)

    assert response.status_code == 500
    assert_original()


@pytest.mark.integration
async def test_sqlite_backup_restores_committed_wal_rows_files_and_key(async_client, monkeypatch, tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    source_db = source / "layercove.db"
    source_url = f"sqlite+aiosqlite:///{source_db}"
    source_engine = create_async_engine(source_url)
    source_key = Fernet.generate_key()
    (source / ".mfa_encryption_key").write_bytes(source_key)
    (source / "archive").mkdir()
    (source / "archive" / "fixture.gcode").write_bytes(b"; archived file")
    try:
        async with source_engine.begin() as connection:
            await connection.run_sync(database.Base.metadata.create_all)
            await connection.execute(insert(Settings).values(key="currency", value="SEK"))
            await connection.execute(insert(User).values(id=7, username="restored-user"))
            secret = "fernet:" + Fernet(source_key).encrypt(b"fixture-totp-seed").decode()
            await connection.execute(UserTOTP.__table__.insert().values(user_id=7, secret=secret))
    finally:
        await source_engine.dispose()

    monkeypatch.setenv("DATA_DIR", str(source))
    monkeypatch.setattr(settings, "base_dir", source)
    monkeypatch.setattr(settings, "archive_dir", source / "archive")
    monkeypatch.setattr(settings, "database_url", source_url)
    with closing(sqlite3.connect(source_db)) as writer, closing(sqlite3.connect(source_db)) as reader:
        writer.execute("PRAGMA journal_mode=WAL").fetchone()
        reader.execute("BEGIN")
        assert reader.execute("SELECT value FROM settings WHERE key='currency'").fetchone() == ("SEK",)
        writer.execute("UPDATE settings SET value='EUR' WHERE key='currency'")
        writer.commit()
        backup = await async_client.get("/api/v1/settings/backup")
    assert backup.status_code == 200

    destination = tmp_path / "destination"
    destination.mkdir()
    destination_db = destination / "layercove.db"
    destination_url = f"sqlite+aiosqlite:///{destination_db}"
    destination_engine = create_async_engine(destination_url)
    monkeypatch.setenv("DATA_DIR", str(destination))
    monkeypatch.setattr(settings, "base_dir", destination)
    monkeypatch.setattr(settings, "archive_dir", destination / "archive")
    monkeypatch.setattr(settings, "database_url", destination_url)
    monkeypatch.setattr(database, "engine", destination_engine)
    monkeypatch.setattr(database, "async_session", async_sessionmaker(destination_engine, expire_on_commit=False))
    try:
        await database.init_db()
        restored = await async_client.post(
            "/api/v1/settings/restore",
            files={"file": ("backup.zip", backup.content, "application/zip")},
        )
        assert restored.status_code == 200
    finally:
        await destination_engine.dispose()

    reopened = create_async_engine(destination_url)
    try:
        async with reopened.connect() as connection:
            assert await connection.scalar(select(Settings.value).where(Settings.key == "currency")) == "EUR"
            stored = await connection.scalar(select(UserTOTP._secret_enc).where(UserTOTP.user_id == 7))
            if encryption.mfa_decrypt(stored) != "fixture-totp-seed":
                pytest.fail("The restored setting cannot be decrypted")
        assert (destination / "archive" / "fixture.gcode").read_bytes() == b"; archived file"
    finally:
        await reopened.dispose()
