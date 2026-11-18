import asyncio
import io
import os
import shutil
import sqlite3
import zipfile
from contextlib import closing
from unittest.mock import AsyncMock

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import insert, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.api.routes import settings as settings_routes
from backend.app.core import database, encryption
from backend.app.core.config import settings
from backend.app.core.database import async_session as application_session
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.models.user_totp import UserTOTP


def write_database(path, value, *, settings_only=False):
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE settings (id INTEGER PRIMARY KEY, key TEXT, value TEXT)")
        connection.execute("INSERT INTO settings VALUES (1, 'currency', ?)", (value,))
        if not settings_only:
            connection.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
            connection.execute("CREATE TABLE printers (id INTEGER PRIMARY KEY, name TEXT)")
            connection.execute(
                "CREATE TABLE print_archives (id INTEGER PRIMARY KEY, filename TEXT, file_path TEXT, file_size INTEGER)"
            )


@pytest.fixture
def restore_fixture(monkeypatch, tmp_path, request):
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
    write_database(backup, "EUR", settings_only=getattr(request, "param", None) == "settings-only")
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as zipped:
        zipped.write(backup, "layercove.db")
        zipped.writestr(".mfa_encryption_key", Fernet.generate_key())
        zipped.mkdir("archive/")
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
@pytest.mark.parametrize("restore_fixture", ["settings-only"], indirect=True)
async def test_settings_only_backup_is_rejected_before_changing_live_data(async_client, restore_fixture):
    files, assert_original = restore_fixture

    response = await async_client.post("/api/v1/settings/restore", files=files)

    assert response.status_code == 400, response.text
    assert "missing" in response.json()["detail"].lower()
    assert_original()


@pytest.mark.integration
@pytest.mark.parametrize("credential", ["api_key_ciphertext", "authorization_ciphertext"])
async def test_restore_rejects_moonraker_credentials_encrypted_with_another_key(
    async_client, tmp_path, restore_fixture, credential
):
    _, assert_original = restore_fixture
    backup = tmp_path / "moonraker.db"
    write_database(backup, "EUR")
    encrypted = "fernet:" + Fernet(Fernet.generate_key()).encrypt(b"fixture credential").decode()
    with closing(sqlite3.connect(backup)) as db, db:
        db.execute("CREATE TABLE moonraker_printer_configs (api_key_ciphertext TEXT, authorization_ciphertext TEXT)")
        values = (encrypted, None) if credential == "api_key_ciphertext" else (None, encrypted)
        db.execute("INSERT INTO moonraker_printer_configs VALUES (?, ?)", values)
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.write(backup, "layercove.db")

    response = await async_client.post(
        "/api/v1/settings/restore", files={"file": ("backup.zip", payload.getvalue(), "application/zip")}
    )

    assert response.status_code == 400, response.text
    assert_original()


def test_failed_key_rollback_preserves_key_backups_and_recovers_independent_files(tmp_path, monkeypatch):
    from backend.app.services.backup_restore import RestoreFiles

    extracted = tmp_path / "extracted"
    extracted.mkdir()
    incoming = extracted / "archive"
    incoming.mkdir()
    (incoming / "model.txt").write_text("replacement")
    target = tmp_path / "archive"
    target.mkdir()
    model = target / "model.txt"
    model.write_text("original")
    key = tmp_path / ".mfa_encryption_key"
    key.write_bytes(b"old fixture key")
    (extracted / key.name).write_bytes(b"new fixture key")
    files = RestoreFiles()
    files.stage(extracted, [("archive", target)], key)
    files.install()

    replace = os.replace

    def reject_key_move(source, destination):
        if source == key:
            raise OSError("fixture key move failed")
        return replace(source, destination)

    monkeypatch.setattr(os, "replace", reject_key_move)
    with pytest.raises(OSError):
        files.rollback()

    assert model.read_text() == "original"
    assert key.read_bytes() == b"new fixture key"
    assert (files.workspaces[-1] / "previous-key").read_bytes() == b"old fixture key"


@pytest.mark.integration
@pytest.mark.parametrize("limit", ["bytes", "entries"])
async def test_restore_enforces_configured_zip_limits(async_client, monkeypatch, tmp_path, restore_fixture, limit):
    from backend.app.services.local_backup import local_backup_service

    files, assert_original = restore_fixture
    payload = files["file"][1]
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        total = sum(entry.file_size for entry in archive.infolist())
        count = len(archive.infolist())
    monkeypatch.setenv("BACKUP_RESTORE_MAX_UNCOMPRESSED_BYTES", str(total - (limit == "bytes")))
    monkeypatch.setenv("BACKUP_RESTORE_MAX_ENTRIES", str(count - (limit == "entries")))
    configured = type(settings)(
        base_dir=settings.base_dir, database_url=settings.database_url, archive_dir=settings.archive_dir
    )
    monkeypatch.setattr(settings_routes, "app_settings", configured)

    if limit == "bytes":
        response = await async_client.post("/api/v1/settings/restore", files=files)
    else:
        filename = "layercove-backup-20261118-120000.zip"
        (tmp_path / filename).write_bytes(payload)
        monkeypatch.setattr(local_backup_service, "_load_settings", AsyncMock(return_value={"path": str(tmp_path)}))
        response = await async_client.post(f"/api/v1/local-backup/backups/{filename}/restore")

    assert response.status_code == 413, response.text
    assert limit in response.json()["detail"]
    assert_original()


@pytest.mark.integration
async def test_scheduled_backup_restores_through_the_same_preflight(
    async_client, monkeypatch, tmp_path, restore_fixture
):
    from backend.app.services.local_backup import local_backup_service

    files, _ = restore_fixture
    filename = "layercove-backup-20261118-120000.zip"
    (tmp_path / filename).write_bytes(files["file"][1])
    monkeypatch.setattr(local_backup_service, "_load_settings", AsyncMock(return_value={"path": str(tmp_path)}))

    response = await async_client.post(f"/api/v1/local-backup/backups/{filename}/restore")

    assert response.is_success, response.text
    with closing(sqlite3.connect(tmp_path / "live" / "layercove.db")) as connection:
        assert connection.execute("SELECT value FROM settings WHERE key = 'currency'").fetchone() == ("EUR",)


@pytest.mark.integration
async def test_import_failure_preserves_live_key_database_and_files(async_client, monkeypatch, restore_fixture, caplog):
    files, assert_original = restore_fixture
    monkeypatch.setattr("backend.app.core.db_dialect.is_sqlite", lambda: False)
    monkeypatch.setattr(
        settings_routes, "_import_sqlite_to_postgres", AsyncMock(side_effect=RuntimeError("fixture private backup row"))
    )

    response = await async_client.post("/api/v1/settings/restore", files=files)

    assert response.status_code == 500
    assert_original()
    assert "fixture private backup row" not in caplog.text


@pytest.mark.integration
async def test_http_requests_wait_for_restore_recovery(async_client, monkeypatch, restore_fixture):
    from backend.app import main
    from backend.app.services.printer_manager import PrintLifecycleEvent

    files, assert_original = restore_fixture
    importing = asyncio.Event()
    finish_import = asyncio.Event()
    background_started = asyncio.Event()
    background_entered = asyncio.Event()
    printer_events = []

    async def record_event(printer_id, data):
        printer_events.append(printer_id)

    async def fail_import(*args):
        importing.set()
        await finish_import.wait()
        raise RuntimeError("fixture import failure")

    async def background_query():
        background_started.set()
        async with application_session() as db:
            background_entered.set()
            return await db.scalar(text("SELECT 1"))

    monkeypatch.setattr("backend.app.core.db_dialect.is_sqlite", lambda: False)
    monkeypatch.setattr(settings_routes, "_import_sqlite_to_postgres", fail_import)
    monkeypatch.setattr(main, "on_print_start", record_event)
    restore = asyncio.create_task(async_client.post("/api/v1/settings/restore", files=files))
    entered = asyncio.create_task(importing.wait())
    background = None
    try:
        await asyncio.wait((restore, entered), return_when=asyncio.FIRST_COMPLETED)
        assert importing.is_set()
        response = await async_client.get("/api/v1/settings/")
        assert response.status_code == 503
        background = asyncio.create_task(background_query())
        await background_started.wait()
        assert not background_entered.is_set()
        await main.on_print_lifecycle(PrintLifecycleEvent(1, "started", {}))
        assert printer_events == []
    finally:
        finish_import.set()
        entered.cancel()
        response = await restore
        if background is not None:
            assert await background == 1
    assert response.status_code == 500
    assert_original()
    assert (await async_client.get("/api/v1/settings/")).status_code == 200
    await main.on_print_lifecycle(PrintLifecycleEvent(1, "started", {}))
    assert printer_events == [1]


@pytest.mark.integration
async def test_http_admission_stays_paused_until_printers_reconnect(async_client, monkeypatch, restore_fixture):
    files, _ = restore_fixture
    reconnecting = asyncio.Event()
    finish_reconnecting = asyncio.Event()

    async def reconnect(db):
        reconnecting.set()
        await finish_reconnecting.wait()

    monkeypatch.setattr("backend.app.services.printer_manager.init_printer_connections", reconnect)
    restore = asyncio.create_task(async_client.post("/api/v1/settings/restore", files=files))
    entered = asyncio.create_task(reconnecting.wait())
    try:
        await asyncio.wait((restore, entered), return_when=asyncio.FIRST_COMPLETED)
        assert reconnecting.is_set()
        assert (await async_client.get("/api/v1/settings/")).status_code == 503
    finally:
        finish_reconnecting.set()
        entered.cancel()
        response = await restore
    assert response.status_code == 200
    assert (await async_client.get("/api/v1/settings/")).status_code == 200


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
@pytest.mark.parametrize("legacy_key", [None, "invalid-legacy-key"])
async def test_sqlite_backup_restores_committed_wal_rows_files_and_key(async_client, monkeypatch, tmp_path, legacy_key):
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
    if legacy_key is not None:
        monkeypatch.setenv("MFA_ENCRYPTION_KEY", legacy_key)
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
