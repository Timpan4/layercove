"""Integration tests for named 4via6 network sites."""

from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select


@pytest.fixture
def mock_printer_connection():
    with (
        patch(
            "backend.app.services.printer_manager.printer_manager.test_connection",
            new=AsyncMock(return_value={"success": True}),
        ) as test_connection,
        patch(
            "backend.app.api.routes.printers.printer_manager.connect_printer",
            new=AsyncMock(return_value=True),
        ),
        patch("backend.app.api.routes.printers.MoonrakerHTTPClient") as moonraker_client,
        patch(
            "backend.app.api.routes.printers.printer_manager.disconnect_printer_async",
            new=AsyncMock(),
        ),
    ):
        moonraker_client.return_value.test_connection = AsyncMock(return_value=True)
        test_connection.moonraker_client = moonraker_client
        yield test_connection


@pytest.mark.asyncio
@pytest.mark.integration
async def test_create_and_list_network_site(async_client: AsyncClient):
    created = await async_client.post(
        "/api/v1/network-sites",
        json={"name": "Timpa Home", "site_number": 1, "ipv4_cidr": "192.168.1.0/24"},
    )

    assert created.status_code == 201, created.text
    assert created.json() == {
        "id": 1,
        "name": "Timpa Home",
        "site_number": 1,
        "ipv4_cidr": "192.168.1.0/24",
        "four_via_six_cidr": "fd7a:115c:a1e0:b1a:0:1:c0a8:100/120",
        "printer_count": 0,
    }

    listed = await async_client.get("/api/v1/network-sites")
    assert listed.status_code == 200
    assert listed.json() == [created.json()]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_update_and_delete_unused_network_site(async_client: AsyncClient):
    created = await async_client.post(
        "/api/v1/network-sites",
        json={"name": "Old name", "site_number": 2, "ipv4_cidr": "192.168.2.0/24"},
    )
    site_id = created.json()["id"]

    updated = await async_client.patch(
        f"/api/v1/network-sites/{site_id}",
        json={"name": "Dogge Home", "site_number": 3, "ipv4_cidr": "192.168.3.0/24"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "Dogge Home"
    assert updated.json()["site_number"] == 3
    assert updated.json()["four_via_six_cidr"] == "fd7a:115c:a1e0:b1a:0:3:c0a8:300/120"

    deleted = await async_client.delete(f"/api/v1/network-sites/{site_id}")
    assert deleted.status_code == 204
    assert (await async_client.get("/api/v1/network-sites")).json() == []


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize("field", ["name", "site_number", "ipv4_cidr"])
async def test_update_rejects_explicit_null_fields(async_client: AsyncClient, field: str):
    site = (
        await async_client.post(
            "/api/v1/network-sites",
            json={"name": "Timpa Home", "site_number": 1, "ipv4_cidr": "192.168.1.0/24"},
        )
    ).json()

    response = await async_client.patch(f"/api/v1/network-sites/{site['id']}", json={field: None})

    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    "cidr",
    [
        "192.168.1.1/24",
        "192.168.1.0/16",
        "8.8.8.0/24",
        "fd00::/24",
        "192.168.1.0/24; touch /tmp/pwned",
    ],
)
async def test_rejects_malformed_or_non_private_site_cidr(async_client: AsyncClient, cidr: str):
    response = await async_client.post(
        "/api/v1/network-sites",
        json={"name": "Invalid", "site_number": 4, "ipv4_cidr": cidr},
    )

    assert response.status_code == 422


@pytest.mark.asyncio
@pytest.mark.integration
async def test_site_name_is_case_insensitively_unique(async_client: AsyncClient):
    first = await async_client.post(
        "/api/v1/network-sites",
        json={"name": "Timpa Home", "site_number": 1, "ipv4_cidr": "192.168.1.0/24"},
    )
    duplicate = await async_client.post(
        "/api/v1/network-sites",
        json={"name": "timpa home", "site_number": 2, "ipv4_cidr": "192.168.2.0/24"},
    )

    assert first.status_code == 201
    assert duplicate.status_code == 409


@pytest.mark.asyncio
@pytest.mark.integration
async def test_site_crud_requires_matching_printer_permissions_when_auth_is_enabled(async_client: AsyncClient):
    site = (
        await async_client.post(
            "/api/v1/network-sites",
            json={"name": "Timpa Home", "site_number": 1, "ipv4_cidr": "192.168.1.0/24"},
        )
    ).json()
    enabled = await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "admin", "admin_password": "AdminPass1!"},
    )
    assert enabled.status_code == 200

    responses = [
        await async_client.get("/api/v1/network-sites"),
        await async_client.post(
            "/api/v1/network-sites",
            json={"name": "Dogge Home", "site_number": 2, "ipv4_cidr": "192.168.2.0/24"},
        ),
        await async_client.patch(f"/api/v1/network-sites/{site['id']}", json={"name": "Renamed"}),
        await async_client.delete(f"/api/v1/network-sites/{site['id']}"),
    ]

    assert [response.status_code for response in responses] == [401, 401, 401, 401]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_create_bambu_printer_on_network_site(async_client: AsyncClient, db_session, mock_printer_connection):
    site = (
        await async_client.post(
            "/api/v1/network-sites",
            json={"name": "Timpa Home", "site_number": 1, "ipv4_cidr": "192.168.1.0/24"},
        )
    ).json()

    created = await async_client.post(
        "/api/v1/printers/",
        json={
            "name": "Voron",
            "serial_number": "00M09A111111111",
            "access_code": "12345678",
            "network_site_id": site["id"],
            "network_site_lan_ip": "192.168.1.87",
        },
    )

    assert created.status_code == 200, created.text
    assert created.json()["ip_address"] == "192-168-1-87-via-1"
    assert created.json()["network_site_lan_ip"] == "192.168.1.87"
    assert created.json()["network_site"] == {"id": site["id"], "name": "Timpa Home", "site_number": 1}
    mock_printer_connection.assert_awaited_once_with(
        ip_address="192-168-1-87-via-1",
        serial_number="00M09A111111111",
        access_code="12345678",
    )

    from backend.app.models.printer import Printer

    stored = (await db_session.execute(select(Printer).where(Printer.id == created.json()["id"]))).scalar_one()
    assert stored.network_site_id == site["id"]

    overridden = await async_client.patch(
        f"/api/v1/printers/{created.json()['id']}",
        json={"ip_address": "10.0.0.8"},
    )
    assert overridden.status_code == 200, overridden.text
    assert overridden.json()["ip_address"] == "192-168-1-87-via-1"


@pytest.mark.asyncio
@pytest.mark.integration
@pytest.mark.parametrize(
    ("lan_ip", "expected_status"),
    [
        ("192.168.2.87", 400),
        ("192.168.1.0", 400),
        ("192.168.1.255", 400),
        ("$(touch /tmp/pwned)", 422),
    ],
)
async def test_rejects_unusable_printer_address(
    async_client: AsyncClient,
    mock_printer_connection,
    lan_ip: str,
    expected_status: int,
):
    site = (
        await async_client.post(
            "/api/v1/network-sites",
            json={"name": "Timpa Home", "site_number": 1, "ipv4_cidr": "192.168.1.0/24"},
        )
    ).json()

    response = await async_client.post(
        "/api/v1/printers/",
        json={
            "name": "Invalid",
            "serial_number": "00M09A111111111",
            "access_code": "12345678",
            "network_site_id": site["id"],
            "network_site_lan_ip": lan_ip,
        },
    )

    assert response.status_code == expected_status
    mock_printer_connection.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_moonraker_site_lifecycle(async_client: AsyncClient, mock_printer_connection):
    site = (
        await async_client.post(
            "/api/v1/network-sites",
            json={"name": "Workshop", "site_number": 2, "ipv4_cidr": "192.168.50.0/24"},
        )
    ).json()
    printer = await async_client.post(
        "/api/v1/printers/",
        json={
            "name": "Voron",
            "provider": "moonraker",
            "network_site_id": site["id"],
            "network_site_lan_ip": "192.168.50.8",
            "moonraker_config": {
                "base_url": "https://192.168.50.8:7136",
                "websocket_url_override": "wss://192.168.50.8:7136/websocket",
            },
        },
    )
    assert printer.status_code == 200, printer.text
    assert printer.json()["moonraker_config"]["base_url"] == "https://192-168-50-8-via-2:7136"
    assert printer.json()["moonraker_config"]["websocket_url_override"] == ("wss://192-168-50-8-via-2:7136/websocket")

    overridden = await async_client.patch(
        f"/api/v1/printers/{printer.json()['id']}",
        json={
            "moonraker_config": {
                "base_url": "https://wrong-host:7999",
                "websocket_url_override": "wss://wrong-host:7999/websocket",
            }
        },
    )
    assert overridden.status_code == 200, overridden.text
    assert overridden.json()["moonraker_config"]["base_url"] == "https://192-168-50-8-via-2:7999"
    assert overridden.json()["moonraker_config"]["websocket_url_override"] == (
        "wss://192-168-50-8-via-2:7999/websocket"
    )

    locked = await async_client.patch(f"/api/v1/network-sites/{site['id']}", json={"ipv4_cidr": "192.168.51.0/24"})
    assert locked.status_code == 409
    assert (await async_client.delete(f"/api/v1/network-sites/{site['id']}")).status_code == 409

    renamed = await async_client.patch(f"/api/v1/network-sites/{site['id']}", json={"name": "Dogge Home"})
    assert renamed.status_code == 200
    fetched = await async_client.get(f"/api/v1/printers/{printer.json()['id']}")
    assert fetched.json()["network_site"]["name"] == "Dogge Home"

    detached = await async_client.patch(
        f"/api/v1/printers/{printer.json()['id']}",
        json={"network_site_id": None, "network_site_lan_ip": None},
    )
    assert detached.status_code == 200, detached.text
    assert detached.json()["network_site"] is None
    assert (await async_client.delete(f"/api/v1/network-sites/{site['id']}")).status_code == 204
