import io
import os
import sqlite3
import zipfile
from contextlib import closing

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import insert, select
from sqlalchemy.engine import make_url

from backend.app.core import database, encryption
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.models.user_totp import UserTOTP


@pytest.mark.parametrize("failure", ["schema", "import", "encryption", None])
async def test_postgres_restore_keeps_previous_database_on_failure(async_client, tmp_path, monkeypatch, failure):
    url = os.environ.get("TEST_POSTGRES_DATABASE_URL")
    if not url:
        pytest.skip("TEST_POSTGRES_DATABASE_URL is not configured")
    if not (make_url(url).database or "").endswith("_test"):
        pytest.fail("TEST_POSTGRES_DATABASE_URL must name an isolated *_test database")

    data_dir = tmp_path / "live"
    data_dir.mkdir()
    monkeypatch.setenv("DATA_DIR", str(data_dir))
    monkeypatch.setattr(database.settings, "base_dir", data_dir)
    monkeypatch.setattr(database.settings, "archive_dir", data_dir / "archive")
    monkeypatch.setattr(database.settings, "database_url", url)
    monkeypatch.setattr("backend.app.api.routes.settings._resume_background_services", lambda: None)

    source_key = Fernet.generate_key()
    current_key = Fernet.generate_key()
    key_path = data_dir / ".mfa_encryption_key"
    key_path.write_bytes(current_key)
    if failure == "encryption":
        monkeypatch.setenv("MFA_ENCRYPTION_KEY", current_key.decode())
    archive_dir = data_dir / "archive"
    archive_dir.mkdir()
    (archive_dir / "existing.txt").write_text("existing archive", encoding="utf-8")

    backup = tmp_path / "backup.db"
    with closing(sqlite3.connect(backup)) as source, source:
        source.execute("CREATE TABLE settings (id INTEGER PRIMARY KEY, key TEXT, value TEXT)")
        source.execute("INSERT INTO settings VALUES (1, 'currency', 'EUR')")
        if failure == "schema":
            source.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)")
            source.execute("INSERT INTO users VALUES (7)")
        else:
            source.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
            source.execute("INSERT INTO users VALUES (7, 'restored-user')")
        if failure == "import":
            source.execute("INSERT INTO settings VALUES (2, 'currency', 'USD')")
        source.execute("CREATE TABLE user_totp (id INTEGER PRIMARY KEY, user_id INTEGER, secret TEXT)")
        encrypted = Fernet(source_key).encrypt(b"fixture-totp-seed").decode()
        source.execute("INSERT INTO user_totp VALUES (9, 7, ?)", ("fernet:" + encrypted,))

    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.write(backup, "layercove.db")
        archive.writestr(".mfa_encryption_key", source_key)
        archive.writestr("archive/restored.txt", "restored archive")

    engine = database._create_engine()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Settings.__table__.create, checkfirst=True)
            prior = await conn.scalar(select(Settings.id).where(Settings.key == "currency"))
            if prior is None:
                await conn.execute(insert(Settings).values(key="currency", value="SEK"))
            else:
                await conn.execute(Settings.__table__.update().where(Settings.id == prior).values(value="SEK"))

        response = await async_client.post(
            "/api/v1/settings/restore",
            files={"file": ("backup.zip", payload.getvalue(), "application/zip")},
        )
        async with engine.connect() as conn:
            currency = await conn.scalar(select(Settings.value).where(Settings.key == "currency"))
            if failure is not None:
                assert response.status_code == (500 if failure == "import" else 400)
                assert currency == "SEK"
                assert (archive_dir / "existing.txt").is_file()
                if key_path.read_bytes() != current_key:
                    pytest.fail("Restore changed the original encryption key")
            else:
                assert response.status_code == 200
                assert currency == "EUR"
                assert await conn.scalar(select(User.role).where(User.id == 7)) == "user"
                secret = await conn.scalar(select(UserTOTP._secret_enc).where(UserTOTP.user_id == 7))
                if encryption.mfa_decrypt(secret) != "fixture-totp-seed":
                    pytest.fail("The restored key did not decrypt the restored setting")
                assert (archive_dir / "restored.txt").read_text(encoding="utf-8") == "restored archive"
                assert not (archive_dir / "existing.txt").exists()
    finally:
        await engine.dispose()
