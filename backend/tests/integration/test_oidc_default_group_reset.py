"""Regression: PUT default_group_id=null must clear the provider's default group."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
@pytest.mark.integration
async def test_put_default_group_null_clears_privileged_default(async_client: AsyncClient):
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "grpadmin", "admin_password": "AdminPass1!"},
    )
    login = await async_client.post("/api/v1/auth/login", json={"username": "grpadmin", "password": "AdminPass1!"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    groups = (await async_client.get("/api/v1/groups/", headers=headers)).json()
    admin_group = next(g for g in groups if g["name"] == "Administrators")

    created = await async_client.post(
        "/api/v1/auth/oidc/providers",
        headers=headers,
        json={
            "name": "P",
            "issuer_url": "https://idp.example.com",
            "client_id": "c",
            "client_secret": "s",
            "default_group_id": admin_group["id"],
        },
    )
    assert created.status_code == 201, created.text
    pid = created.json()["id"]
    assert created.json()["default_group_id"] == admin_group["id"]

    resp = await async_client.put(
        f"/api/v1/auth/oidc/providers/{pid}", headers=headers, json={"default_group_id": None}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["default_group_id"] is None
