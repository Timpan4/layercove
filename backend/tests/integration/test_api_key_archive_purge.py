"""can_manage_archives keys may soft-delete archives but never purge statistics."""

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.core.auth import generate_api_key
from backend.app.models.api_key import APIKey
from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.user import User


@pytest.fixture
async def archive_key(async_client: AsyncClient, db_session):
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "arcadmin", "admin_password": "AdminPass1!"},
    )
    admin = (await db_session.execute(select(User).where(User.username == "arcadmin"))).scalar_one()
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(name="archives", key_hash=key_hash, key_prefix=key_prefix, user_id=admin.id, can_manage_archives=True)
    )
    await db_session.commit()
    return {"X-API-Key": full_key}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_api_key_cannot_purge_archive_stats(
    async_client, db_session, printer_factory, archive_factory, archive_key
):
    printer = await printer_factory()
    archive = await archive_factory(printer.id)

    resp = await async_client.delete(f"/api/v1/archives/{archive.id}?purge_stats=true", headers=archive_key)

    assert resp.status_code == 403, resp.text
    assert (await db_session.execute(select(func.count(PrintLogEntry.id)))).scalar() == 1
    assert (await db_session.get(PrintArchive, archive.id)) is not None


@pytest.mark.asyncio
@pytest.mark.integration
async def test_api_key_cannot_clear_print_log(async_client, db_session, printer_factory, archive_factory, archive_key):
    printer = await printer_factory()
    await archive_factory(printer.id)

    resp = await async_client.delete("/api/v1/print-log/", headers=archive_key)

    assert resp.status_code == 403, resp.text
    assert (await db_session.execute(select(func.count(PrintLogEntry.id)))).scalar() == 1
