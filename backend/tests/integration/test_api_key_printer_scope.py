"""API keys restricted to one printer must not reach another printer's data,
and read-only principals must not purge sensor history."""

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.core.auth import create_access_token, generate_api_key, get_password_hash
from backend.app.models.api_key import APIKey
from backend.app.models.group import Group
from backend.app.models.maintenance import MaintenanceType, PrinterMaintenance
from backend.app.models.user import User


@pytest.fixture
async def scoped(async_client: AsyncClient, db_session, printer_factory):
    """Auth on; key restricted to printer_a; plus printer_b and a viewer JWT."""
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "scopeadmin", "admin_password": "AdminPass1!"},
    )
    admin = (await db_session.execute(select(User).where(User.username == "scopeadmin"))).scalar_one()
    printer_a = await printer_factory(name="A")
    printer_b = await printer_factory(name="B")

    full_key, key_hash, key_prefix = generate_api_key()
    db_session.add(
        APIKey(
            name="scoped",
            key_hash=key_hash,
            key_prefix=key_prefix,
            user_id=admin.id,
            printer_ids=[printer_a.id],
            can_manage_inventory=True,
            can_manage_maintenance=True,
        )
    )

    viewers = (await db_session.execute(select(Group).where(Group.name == "Viewers"))).scalar_one()
    viewer = User(username="viewer_scope", password_hash=get_password_hash("x"), is_active=True)
    viewer.groups.append(viewers)
    db_session.add(viewer)

    mtype = MaintenanceType(name="Custom", is_system=False)
    db_session.add(mtype)
    await db_session.commit()
    await db_session.refresh(mtype)
    item_b = PrinterMaintenance(printer_id=printer_b.id, maintenance_type_id=mtype.id)
    db_session.add(item_b)
    await db_session.commit()
    await db_session.refresh(item_b)

    return {
        "headers": {"X-API-Key": full_key},
        "viewer_headers": {"Authorization": f"Bearer {create_access_token(data={'sub': 'viewer_scope'})}"},
        "a": printer_a,
        "b": printer_b,
        "item_b": item_b,
        "type": mtype,
    }


@pytest.mark.asyncio
@pytest.mark.integration
async def test_from_slot_rejects_out_of_scope_printer(async_client: AsyncClient, scoped):
    resp = await async_client.post(
        "/api/v1/inventory/spools/from-slot",
        headers=scoped["headers"],
        json={"printer_id": scoped["b"].id, "ams_id": 0, "tray_id": 0},
    )
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PATCH", "/api/v1/maintenance/items/{item}", {"enabled": False}),
        ("DELETE", "/api/v1/maintenance/items/{item}", None),
        ("POST", "/api/v1/maintenance/items/{item}/perform", {}),
        ("POST", "/api/v1/maintenance/printers/{b}/assign/{type}", None),
        ("PATCH", "/api/v1/maintenance/printers/{b}/hours?total_hours=5", None),
    ],
)
async def test_maintenance_rejects_out_of_scope_printer(async_client: AsyncClient, scoped, method, path, body):
    path = path.format(item=scoped["item_b"].id, b=scoped["b"].id, type=scoped["type"].id)
    resp = await async_client.request(method, path, headers=scoped["headers"], json=body)
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
@pytest.mark.integration
async def test_support_bundle_rejects_api_keys(async_client: AsyncClient, scoped):
    resp = await async_client.get("/api/v1/support/bundle", headers=scoped["headers"])
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
@pytest.mark.integration
async def test_sensor_history_purge_denied_to_viewers_and_api_keys(async_client: AsyncClient, scoped):
    url = f"/api/v1/printer-sensor-history/{scoped['b'].id}?days=1"
    assert (await async_client.delete(url, headers=scoped["viewer_headers"])).status_code == 403
    assert (await async_client.delete(url, headers=scoped["headers"])).status_code == 403
