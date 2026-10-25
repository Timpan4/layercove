"""Prints that start outside LayerCove are credited to the printer's owner.

Reported: a user's printer was not linked to their profile, so Stats showed
their profile as empty and their prints under "No User (System)". A print the
printer starts on its own (sent from OrcaSlicer, or the touchscreen) carries no
LayerCove user, so the archive was stored with ``created_by_id = NULL``.
"""

import zipfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.core.config import settings as app_settings
from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.printer import Printer


def _bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def _login(client: AsyncClient, username: str, password: str) -> tuple[str, dict]:
    body = (await client.post("/api/v1/auth/login", json={"username": username, "password": password})).json()
    return body["access_token"], body["user"]


@pytest.fixture
async def users(async_client: AsyncClient):
    """An admin plus an Operator, who can edit printers but only their own archives."""
    await async_client.post(
        "/api/v1/auth/setup",
        json={"auth_enabled": True, "admin_username": "owneradmin", "admin_password": "AdminPass1!"},
    )
    admin_token, _ = await _login(async_client, "owneradmin", "AdminPass1!")
    groups = (await async_client.get("/api/v1/groups/", headers=_bearer(admin_token))).json()
    operators = next(g for g in groups if g["name"] == "Operators")
    await async_client.post(
        "/api/v1/users/",
        headers=_bearer(admin_token),
        json={"username": "doggeday", "password": "Operatorpass1!", "group_ids": [operators["id"]]},
    )
    operator_token, operator = await _login(async_client, "doggeday", "Operatorpass1!")
    return {"admin_token": admin_token, "operator_token": operator_token, "operator": operator}


@pytest.fixture
async def printer(db_session) -> Printer:
    printer = Printer(
        name="Doggeday P1S",
        serial_number="01P00A000000001",
        ip_address="192.0.2.10",
        access_code="12345678",
        model="P1S",
    )
    db_session.add(printer)
    await db_session.commit()
    await db_session.refresh(printer)
    return printer


async def _archives_on(test_engine, printer_id: int) -> list[PrintArchive]:
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        return list((await db.execute(select(PrintArchive).where(PrintArchive.printer_id == printer_id))).scalars())


async def _start_print_from_printer(printer_id: int, filename: str, cached_3mf: Path | None = None) -> None:
    """Drive the print-start callback as if the printer reported a new job.

    With ``cached_3mf`` LayerCove archives that 3MF. Without it the printer's
    FTP has no copy of the file (common on P1/A1 firmware), so LayerCove
    records the print without the 3MF.
    """
    from backend.app.main import on_print_start

    with ExitStack() as stack:
        for target, replacement in {
            "backend.app.main.printer_manager": MagicMock(),
            "backend.app.main.ws_manager": AsyncMock(),
            "backend.app.main.mqtt_relay": AsyncMock(),
            "backend.app.main.notification_service": AsyncMock(),
            "backend.app.main.smart_plug_manager": AsyncMock(),
            "backend.app.main.notify_missing_spool_assignments_on_print_start": AsyncMock(),
            "backend.app.main._send_print_start_notification": AsyncMock(),
            "backend.app.main._record_energy_start": AsyncMock(),
            "backend.app.main._store_spoolman_print_data": AsyncMock(),
            "backend.app.main._maybe_start_layer_timelapse": MagicMock(),
            "backend.app.main.get_cached_3mf": MagicMock(return_value=cached_3mf),
            "backend.app.main.get_ftp_retry_settings": AsyncMock(return_value=(False, 0, 0, 1)),
            "backend.app.main.download_file_async": AsyncMock(return_value=False),
            "backend.app.services.bambu_ftp.list_files_async": AsyncMock(return_value=[]),
        }.items():
            stack.enter_context(patch(target, replacement))
        await on_print_start(printer_id, {"filename": f"{filename}.gcode.3mf", "subtask_name": filename})


@pytest.mark.asyncio
@pytest.mark.parametrize("has_3mf", [True, False], ids=["with-3mf", "without-3mf"])
async def test_print_started_outside_layercove_is_credited_to_printer_owner(
    async_client, test_engine, users, printer, has_3mf, tmp_path, monkeypatch
):
    response = await async_client.patch(
        f"/api/v1/printers/{printer.id}",
        headers=_bearer(users["admin_token"]),
        json={"owner_id": users["operator"]["id"]},
    )
    assert response.status_code == 200
    assert response.json()["owner_id"] == users["operator"]["id"]

    cached_3mf = None
    if has_3mf:
        monkeypatch.setattr(app_settings, "base_dir", tmp_path)
        monkeypatch.setattr(app_settings, "archive_dir", tmp_path / "archive")
        cached_3mf = tmp_path / "Benchy.gcode.3mf"
        with zipfile.ZipFile(cached_3mf, "w") as zf:
            zf.writestr("Metadata/slice_info.config", "<config/>")

    await _start_print_from_printer(printer.id, "Benchy", cached_3mf)

    [archive] = await _archives_on(test_engine, printer.id)
    assert archive.created_by_id == users["operator"]["id"]
    # Operators only read their own archives, so the owner now sees the print.
    listed = await async_client.get("/api/v1/archives/", headers=_bearer(users["operator_token"]))
    assert [a["id"] for a in listed.json()] == [archive.id]


@pytest.mark.asyncio
async def test_print_dispatched_by_layercove_keeps_its_user_on_an_owned_printer(
    async_client, db_session, test_engine, users, printer
):
    """Owner attribution is a fallback: a print a user sliced and queued in
    LayerCove stays credited to that user, even on someone else's printer."""
    from backend.app.main import _expected_print_creators, _expected_prints, register_expected_print

    await async_client.patch(
        f"/api/v1/printers/{printer.id}",
        headers=_bearer(users["admin_token"]),
        json={"owner_id": users["operator"]["id"]},
    )
    admin_id = (await async_client.get("/api/v1/auth/me", headers=_bearer(users["admin_token"]))).json()["id"]
    queued = PrintArchive(
        printer_id=printer.id,
        filename="Gear.gcode.3mf",
        file_path="",
        file_size=0,
        print_name="Gear",
        status="archived",
        created_by_id=admin_id,
    )
    db_session.add(queued)
    await db_session.commit()
    register_expected_print(printer.id, "Gear.gcode.3mf", queued.id, created_by_id=admin_id)

    try:
        await _start_print_from_printer(printer.id, "Gear")
    finally:
        _expected_prints.clear()
        _expected_print_creators.clear()

    [archive] = await _archives_on(test_engine, printer.id)
    assert archive.id == queued.id
    assert archive.created_by_id == admin_id


@pytest.mark.asyncio
async def test_setting_owner_can_move_past_no_user_prints_to_owner(async_client, db_session, users, printer):
    other_printer = Printer(name="Shared X1C", serial_number="00M00A000000002", ip_address="192.0.2.11", model="X1C")
    db_session.add(other_printer)
    await db_session.flush()
    for target in (printer, other_printer):
        archive = PrintArchive(
            printer_id=target.id,
            filename="Benchy.gcode.3mf",
            file_path="",
            file_size=0,
            print_name="Benchy",
            status="completed",
        )
        db_session.add(archive)
        await db_session.flush()
        db_session.add(
            PrintLogEntry(archive_id=archive.id, printer_id=target.id, print_name="Benchy", status="completed")
        )
    await db_session.commit()
    operator_id = users["operator"]["id"]

    async def total_prints(created_by_id: int) -> int:
        response = await async_client.get(
            f"/api/v1/archives/stats?created_by_id={created_by_id}", headers=_bearer(users["admin_token"])
        )
        assert response.status_code == 200
        return response.json()["total_prints"]

    assert (await total_prints(operator_id), await total_prints(-1)) == (0, 2)

    response = await async_client.patch(
        f"/api/v1/printers/{printer.id}",
        headers=_bearer(users["admin_token"]),
        json={"owner_id": operator_id, "assign_unowned_prints": True},
    )
    assert response.status_code == 200

    # Only the owned printer's prints move; the shared printer's stay unassigned.
    assert (await total_prints(operator_id), await total_prints(-1)) == (1, 1)
    # The print-log list filters on the stored username, so it moves too.
    owned_id, shared_id = printer.id, other_printer.id
    db_session.expire_all()
    runs = (await db_session.execute(select(PrintLogEntry.printer_id, PrintLogEntry.created_by_username))).all()
    assert dict(runs) == {owned_id: "doggeday", shared_id: None}


@pytest.mark.asyncio
async def test_owner_change_requires_rights_over_all_archives(async_client, users, printer):
    """Owning a printer's prints grants edit and delete rights over them, so an
    Operator (who may edit printers but only their own archives) cannot claim
    them. Resending the unchanged owner, as the edit form does, still works."""
    headers = _bearer(users["operator_token"])

    claim = await async_client.patch(
        f"/api/v1/printers/{printer.id}", headers=headers, json={"owner_id": users["operator"]["id"]}
    )
    assert claim.status_code == 403

    rename = await async_client.patch(
        f"/api/v1/printers/{printer.id}", headers=headers, json={"name": "Renamed", "owner_id": None}
    )
    assert rename.status_code == 200
    assert rename.json()["owner_id"] is None


@pytest.mark.asyncio
async def test_owner_credited_print_names_owner_in_print_log(async_client, test_engine, users, printer):
    """The Print Log filters on the stored username, and a print started outside
    LayerCove has no print user, so the run names the archive's owner."""
    import asyncio

    from backend.app.main import _active_prints, on_print_complete
    from backend.app.services.bambu_ftp import DeleteResult

    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        archive = PrintArchive(
            printer_id=printer.id,
            filename="Benchy.3mf",
            file_path="",
            file_size=0,
            print_name="Benchy",
            status="printing",
            created_by_id=users["operator"]["id"],
        )
        db.add(archive)
        await db.commit()
    _active_prints[(printer.id, "Benchy.3mf")] = archive.id

    tasks_before = set(asyncio.all_tasks())
    with ExitStack() as stack:
        for target in ("notification_service", "smart_plug_manager", "ws_manager", "mqtt_relay"):
            stack.enter_context(patch(f"backend.app.main.{target}", AsyncMock()))
        printer_manager = stack.enter_context(patch("backend.app.main.printer_manager"))
        printer_manager.get_printer.return_value = None
        printer_manager.get_current_print_user.return_value = None
        stack.enter_context(
            patch("backend.app.services.bambu_ftp.delete_file_async", AsyncMock(return_value=DeleteResult.NOT_FOUND))
        )
        await on_print_complete(
            printer.id,
            {"status": "completed", "filename": "Benchy.3mf", "subtask_name": "Benchy", "timelapse_was_active": False},
        )
        # Let background tasks finish inside the mocks so SQLite teardown is not locked.
        await asyncio.gather(*(asyncio.all_tasks() - tasks_before - {asyncio.current_task()}), return_exceptions=True)

    async with maker() as db:
        runs = (await db.execute(select(PrintLogEntry).where(PrintLogEntry.archive_id == archive.id))).scalars().all()
    assert [(r.created_by_id, r.created_by_username) for r in runs] == [(users["operator"]["id"], "doggeday")]


@pytest.mark.asyncio
async def test_owner_must_be_an_active_user(async_client, db_session, users, printer):
    from backend.app.models.user import User

    inactive = User(username="gone", password_hash="x", is_active=False)
    db_session.add(inactive)
    await db_session.commit()

    for owner_id in (inactive.id, 999999):
        response = await async_client.patch(
            f"/api/v1/printers/{printer.id}", headers=_bearer(users["admin_token"]), json={"owner_id": owner_id}
        )
        assert response.status_code == 400


@pytest.mark.asyncio
async def test_deleting_the_owner_leaves_the_printer_without_owner(async_client, users, printer):
    headers = _bearer(users["admin_token"])
    await async_client.patch(
        f"/api/v1/printers/{printer.id}", headers=headers, json={"owner_id": users["operator"]["id"]}
    )

    deleted = await async_client.delete(f"/api/v1/users/{users['operator']['id']}", headers=headers)
    assert deleted.status_code in (200, 204)

    response = await async_client.get(f"/api/v1/printers/{printer.id}", headers=headers)
    assert response.json()["owner_id"] is None
