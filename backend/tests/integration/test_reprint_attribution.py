"""Reprinting an ownerless archive (#730) records the reprinter without
making them the archive's owner.

`archive.created_by_id` is the authorization boundary for update/delete, so a
reprint permission must not write to it. The reprinter is stored in
`reprinted_by_id` and shown as the archive's attribution.
"""

import asyncio
from contextlib import ExitStack
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.archive import PrintArchive
from backend.app.models.print_log import PrintLogEntry
from backend.app.models.user import User


@pytest.mark.asyncio
@pytest.mark.integration
async def test_reprint_of_ownerless_archive_does_not_grant_ownership(
    async_client: AsyncClient, db_session, test_engine, printer_factory, archive_factory
):
    from backend.app.main import _active_prints, on_print_complete

    printer = await printer_factory()
    archive = await archive_factory(printer.id, status="printing", created_by_id=None, print_name="Reprint")
    user = User(username="reprinter", password_hash="x", is_active=True)
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    _active_prints[(printer.id, "Reprint.3mf")] = archive.id

    tasks_before = set(asyncio.all_tasks())
    with ExitStack() as stack:
        stack.enter_context(patch("backend.app.main.notification_service")).on_print_complete = AsyncMock()
        stack.enter_context(patch("backend.app.main.smart_plug_manager")).on_print_complete = AsyncMock()
        mock_ws = stack.enter_context(patch("backend.app.main.ws_manager"))
        mock_ws.send_print_complete = AsyncMock()
        mock_ws.broadcast = AsyncMock()
        stack.enter_context(patch("backend.app.main.mqtt_relay")).on_print_complete = AsyncMock()
        mock_pm = stack.enter_context(patch("backend.app.main.printer_manager"))
        mock_pm.get_printer.return_value = None
        mock_pm.get_current_print_user.return_value = {"user_id": user.id, "username": user.username}
        mock_pm.set_awaiting_plate_clear = MagicMock()
        # Avoid the real FTP cleanup against the fake printer address.
        from backend.app.services.bambu_ftp import DeleteResult

        stack.enter_context(
            patch("backend.app.services.bambu_ftp.delete_file_async", AsyncMock(return_value=DeleteResult.NOT_FOUND))
        )

        await on_print_complete(
            printer.id,
            {
                "status": "completed",
                "filename": "Reprint.3mf",
                "subtask_name": "Reprint",
                "timelapse_was_active": False,
            },
        )

        for task in asyncio.all_tasks() - tasks_before:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as fresh:
        refreshed = (await fresh.execute(select(PrintArchive).where(PrintArchive.id == archive.id))).scalar_one()
        log = (await fresh.execute(select(PrintLogEntry).where(PrintLogEntry.archive_id == archive.id))).scalars().all()

    assert refreshed.created_by_id is None
    assert refreshed.reprinted_by_id == user.id
    assert any(e.created_by_username == "reprinter" for e in log)
