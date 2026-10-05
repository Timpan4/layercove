import time

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from backend.app.models.print_queue import PrintQueueItem
from backend.app.services.virtual_printer.manager import VirtualPrinterInstance


@pytest.mark.asyncio
@pytest.mark.integration
async def test_late_restamp_does_not_overwrite_item_dispatched_mid_restamp(test_engine, tmp_path):
    """The scheduler moving the item out of 'pending' between the restamp's
    statements must leave the dispatched item's slicer fields untouched."""
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        item = PrintQueueItem(status="pending", position=1, timelapse=False)
        db.add(item)
        await db.commit()
        item_id = item.id

    class RacingSession:
        """Delegates to a real session; the scheduler claims the item before every statement after the first."""

        def __init__(self, inner):
            self._inner = inner
            self._calls = 0

        async def execute(self, *args, **kwargs):
            self._calls += 1
            if self._calls > 1:
                async with maker() as other:
                    await other.execute(
                        update(PrintQueueItem).where(PrintQueueItem.id == item_id).values(status="printing")
                    )
                    await other.commit()
            return await self._inner.execute(*args, **kwargs)

        def __getattr__(self, name):
            return getattr(self._inner, name)

    class Factory:
        def __call__(self):
            outer = maker()

            class Ctx:
                async def __aenter__(self_inner):
                    self_inner.db = await outer.__aenter__()
                    return RacingSession(self_inner.db)

                async def __aexit__(self_inner, *exc):
                    return await outer.__aexit__(*exc)

            return Ctx()

    inst = VirtualPrinterInstance(
        vp_id=1,
        name="Race",
        mode="queue",
        model="O1C2",
        access_code="12345678",
        serial_suffix="391800001",
        base_dir=tmp_path,
        session_factory=Factory(),
    )
    inst._recent_queue_items["a.3mf"] = ([item_id], time.monotonic())

    await inst._restamp_recent_queue_item("a.3mf", {"timelapse": True})

    async with maker() as db:
        row = (await db.execute(select(PrintQueueItem).where(PrintQueueItem.id == item_id))).scalar_one()
    assert not (row.status != "pending" and row.timelapse is True)
