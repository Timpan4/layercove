"""Authorization regressions for POST /queue/ (cleanup flag and batch ownership)."""

import pytest
from httpx import AsyncClient

from backend.app.models.library import LibraryFile
from backend.app.models.print_batch import PrintBatch
from backend.app.models.printer import Printer


async def _admin_headers(async_client: AsyncClient) -> dict[str, str]:
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "qcadmin", "admin_password": "AdminPass1!"},
    )
    resp = await async_client.post("/api/v1/auth/login", json={"username": "qcadmin", "password": "AdminPass1!"})
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _user_headers(async_client: AsyncClient, admin: dict[str, str], permissions: list[str]) -> dict[str, str]:
    group = await async_client.post(
        "/api/v1/groups/", headers=admin, json={"name": "qc_group", "permissions": permissions}
    )
    assert group.status_code == 201
    created = await async_client.post(
        "/api/v1/users/",
        headers=admin,
        json={"username": "qcuser", "password": "Userpass1!", "group_ids": [group.json()["id"]]},
    )
    assert created.status_code in (200, 201)
    login = await async_client.post("/api/v1/auth/login", json={"username": "qcuser", "password": "Userpass1!"})
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.fixture
async def printer(db_session):
    p = Printer(name="QC", ip_address="192.168.7.7", serial_number="QC0000000001", access_code="12345678", model="X1C")
    db_session.add(p)
    await db_session.commit()
    await db_session.refresh(p)
    return p


@pytest.fixture
async def library_file(db_session):
    f = LibraryFile(filename="victim.3mf", file_path="/tmp/victim.3mf", file_size=1, file_type="3mf")  # nosec B108
    db_session.add(f)
    await db_session.commit()
    await db_session.refresh(f)
    return f


@pytest.mark.asyncio
@pytest.mark.integration
async def test_cleanup_flag_requires_library_delete_permission(async_client: AsyncClient, printer, library_file):
    admin = await _admin_headers(async_client)
    user = await _user_headers(
        async_client, admin, ["queue:create", "library:read_all", "printers:read", "queue:read_all"]
    )
    resp = await async_client.post(
        "/api/v1/queue/",
        headers=user,
        json={"printer_id": printer.id, "library_file_id": library_file.id, "cleanup_library_after_dispatch": True},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
@pytest.mark.integration
async def test_cleanup_flag_rejected_for_queue_only_api_key(
    async_client: AsyncClient, printer, library_file, db_session
):
    from backend.app.core.auth import generate_api_key
    from backend.app.models.api_key import APIKey

    await _admin_headers(async_client)
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(
            name="q",
            key_hash=key_hash,
            key_prefix=key_prefix,
            can_queue=True,
            can_manage_library=False,
            can_read_status=True,
            enabled=True,
        )
    )
    await db_session.commit()
    resp = await async_client.post(
        "/api/v1/queue/",
        headers={"X-API-Key": full_key},
        json={"printer_id": printer.id, "library_file_id": library_file.id, "cleanup_library_after_dispatch": True},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
@pytest.mark.integration
async def test_ownerless_batch_rejected_without_update_all(
    async_client: AsyncClient, printer, library_file, db_session
):
    admin = await _admin_headers(async_client)
    user = await _user_headers(
        async_client, admin, ["queue:create", "library:read_all", "printers:read", "queue:read_own"]
    )
    batch = PrintBatch(name="ownerless", quantity=1, status="active", created_by_id=None)
    db_session.add(batch)
    await db_session.commit()
    await db_session.refresh(batch)
    resp = await async_client.post(
        "/api/v1/queue/",
        headers=user,
        json={"printer_id": printer.id, "library_file_id": library_file.id, "batch_id": batch.id},
    )
    assert resp.status_code == 404
