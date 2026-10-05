"""API keys restricted to one printer must not reach another printer's routes."""

from unittest.mock import AsyncMock, patch

import pytest

from backend.app.core.auth import generate_api_key
from backend.app.models.api_key import APIKey
from backend.app.models.settings import Settings

# (method, path suffix, json body)
CONTROL_ROUTES = [
    ("POST", "/ams/load?tray_id=0", None),
    ("POST", "/ams/unload", None),
    ("POST", "/ams-backup?enabled=false", None),
    ("POST", "/hms/execute-action", {"print_error": "00000000", "action": "DBL_CHECK_RESUME", "job_id": None}),
    ("POST", "/emergency-stop", None),
    ("POST", "/temperature/nozzle", {"target": 320}),
    ("GET", "/files", None),
    ("DELETE", "/files?path=/example.gcode", None),
]


async def _key(db_session, **kwargs) -> str:
    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(APIKey(name="k", key_hash=key_hash, key_prefix=key_prefix, **kwargs))
    db_session.add(Settings(key="auth_enabled", value="true"))
    await db_session.commit()
    return full_key


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("method,suffix,body", CONTROL_ROUTES)
@pytest.mark.parametrize("header", ["x-api-key", "bearer"])
async def test_key_scoped_to_other_printer_is_forbidden(
    async_client, db_session, printer_factory, method, suffix, body, header
):
    allowed = await printer_factory()
    denied = await printer_factory()
    key = await _key(db_session, can_control_printer=True, can_read_status=True, printer_ids=[allowed.id])
    headers = {"X-API-Key": key} if header == "x-api-key" else {"Authorization": f"Bearer {key}"}

    response = await async_client.request(method, f"/api/v1/printers/{denied.id}{suffix}", headers=headers, json=body)

    assert response.status_code == 403, response.text


@pytest.mark.asyncio
@pytest.mark.integration
async def test_read_only_key_cannot_load_ams(async_client, db_session, printer_factory):
    printer = await printer_factory()
    key = await _key(db_session, can_read_status=True, can_control_printer=False)

    response = await async_client.post(f"/api/v1/printers/{printer.id}/ams/load?tray_id=0", headers={"X-API-Key": key})

    assert response.status_code == 403, response.text


@pytest.mark.asyncio
@pytest.mark.integration
async def test_key_scoped_to_printer_passes_scope_gate(async_client, db_session, printer_factory):
    printer = await printer_factory()
    key = await _key(db_session, can_control_printer=True, printer_ids=[printer.id])

    response = await async_client.post(f"/api/v1/printers/{printer.id}/ams/unload", headers={"X-API-Key": key})

    assert response.status_code == 400, response.text  # "Printer not connected", past auth


@pytest.mark.asyncio
@pytest.mark.integration
async def test_printer_update_without_inventory_permission_cannot_set_spoolman_fields(async_client):
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "spooladmin", "admin_password": "AdminPass1!"},
    )
    login = await async_client.post("/api/v1/auth/login", json={"username": "spooladmin", "password": "AdminPass1!"})
    admin = {"Authorization": f"Bearer {login.json()['access_token']}"}
    group = await async_client.post(
        "/api/v1/groups/",
        headers=admin,
        json={"name": "PrintersNoInventory", "permissions": ["printers:read", "printers:create", "printers:update"]},
    )
    await async_client.post(
        "/api/v1/users/",
        headers=admin,
        json={"username": "noinv", "password": "NoinvPass1!", "group_ids": [group.json()["id"]]},
    )
    user_login = await async_client.post("/api/v1/auth/login", json={"username": "noinv", "password": "NoinvPass1!"})
    user = {"Authorization": f"Bearer {user_login.json()['access_token']}"}
    config = {"base_url": "http://klipper.local:7125"}
    # Keep the real printer_manager untouched so the created printer does not leak into later tests.
    with (
        patch("backend.app.api.routes.printers.MoonrakerHTTPClient") as client_class,
        patch("backend.app.api.routes.printers.printer_manager.connect_printer", new=AsyncMock(return_value=True)),
        patch("backend.app.api.routes.printers.printer_manager.disconnect_printer_async", new=AsyncMock()),
    ):
        client_class.return_value.test_connection = AsyncMock(return_value=True)
        created = await async_client.post(
            "/api/v1/printers/",
            headers=user,
            json={"name": "Klipper", "provider": "moonraker", "moonraker_config": config},
        )
        assert created.status_code == 200, created.text

        response = await async_client.patch(
            f"/api/v1/printers/{created.json()['id']}",
            headers=user,
            json={
                "moonraker_config": {
                    "base_url": config["base_url"],
                    "spoolman_accounting_owner": "layercove",
                    "spoolman_spool_id": 1,
                }
            },
        )

    assert response.status_code == 403, response.text
