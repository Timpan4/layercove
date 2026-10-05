"""Cloud-read API keys must not mutate the owner's cloud credentials or presets."""

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import generate_api_key
from backend.app.models.api_key import APIKey
from backend.app.models.user import User

MUTATING_CALLS = [
    ("POST", "/api/v1/cloud/logout", None),
    ("POST", "/api/v1/cloud/token", {"access_token": "attacker-token"}),
    ("POST", "/api/v1/cloud/login", {"email": "a@example.com", "password": "x"}),
    ("POST", "/api/v1/cloud/verify", {"email": "a@example.com", "code": "123456"}),
    ("POST", "/api/v1/cloud/settings", {"type": "print", "name": "x", "base_id": "b", "setting": {}}),
    ("PUT", "/api/v1/cloud/settings/PRESET1", {"name": "x", "setting": {}}),
    ("DELETE", "/api/v1/cloud/settings/PRESET1", None),
    ("POST", "/api/v1/orca-cloud/auth/start", {}),
    ("POST", "/api/v1/orca-cloud/auth/password", {"email": "a@example.com", "password": "x"}),
    ("POST", "/api/v1/orca-cloud/auth/finish", {"code": "c", "state": "s"}),
    ("POST", "/api/v1/orca-cloud/logout", None),
]


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(("method", "path", "body"), MUTATING_CALLS)
async def test_cloud_read_key_cannot_mutate_owner_cloud_state(
    async_client: AsyncClient, db_session: AsyncSession, method, path, body
):
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "cloudadmin", "admin_password": "AdminPass1!"},
    )
    admin = (await db_session.execute(select(User).where(User.username == "cloudadmin"))).scalar_one()
    admin.cloud_token = "owner-token"
    admin.cloud_email = "owner@example.com"
    admin.cloud_region = "global"
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(name="cloud-reader", key_hash=key_hash, key_prefix=key_prefix, user_id=admin.id, can_access_cloud=True)
    )
    await db_session.commit()

    resp = await async_client.request(method, path, headers={"X-API-Key": full_key}, json=body)

    assert resp.status_code == 403, resp.text
    await db_session.refresh(admin)
    assert admin.cloud_token == "owner-token"
