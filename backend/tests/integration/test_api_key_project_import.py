"""Project import must not let a project-scoped key write to the library."""

import io
import json
import zipfile

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.routes.library import get_library_dir
from backend.app.core.auth import generate_api_key
from backend.app.models.api_key import APIKey
from backend.app.models.user import User


def _zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("project.json", json.dumps({"name": "Imp", "linked_folders": [{"name": "x"}]}))
        for name, content in entries.items():
            zf.writestr(name, content)
    return buf.getvalue()


async def _key(client: AsyncClient, db_session, *, library: bool) -> dict:
    await client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "impadmin", "admin_password": "AdminPass1!"},
    )
    admin = (await db_session.execute(select(User).where(User.username == "impadmin"))).scalar_one()
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(
            name="proj",
            key_hash=key_hash,
            key_prefix=key_prefix,
            user_id=admin.id,
            can_manage_projects=True,
            can_manage_library=library,
        )
    )
    await db_session.commit()
    return {"X-API-Key": full_key}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_project_key_without_library_scope_cannot_import_files(async_client: AsyncClient, db_session):
    headers = await _key(async_client, db_session, library=False)
    files = {"file": ("p.zip", _zip({"files/x/a.3mf": b"new"}), "application/zip")}

    resp = await async_client.post("/api/v1/projects/import/file", files=files, headers=headers)

    assert resp.status_code == 403, resp.text
    assert not (get_library_dir() / "x" / "a.3mf").exists()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_import_entry_cannot_escape_its_folder_to_overwrite_managed_file(async_client: AsyncClient, db_session):
    headers = await _key(async_client, db_session, library=True)
    victim = get_library_dir() / "files" / "victim.3mf"
    victim.parent.mkdir(parents=True, exist_ok=True)
    victim.write_bytes(b"original")
    files = {"file": ("p.zip", _zip({"files/x/../files/victim.3mf": b"tampered"}), "application/zip")}

    resp = await async_client.post("/api/v1/projects/import/file", files=files, headers=headers)

    assert resp.status_code == 400, resp.text
    assert victim.read_bytes() == b"original"
