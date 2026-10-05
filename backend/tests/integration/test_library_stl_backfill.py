"""STL thumbnail backfill must not render on the event-loop thread."""

import threading
from unittest.mock import patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker


@pytest.mark.asyncio
@pytest.mark.integration
async def test_backfill_renders_off_event_loop_thread(test_engine, db_session, tmp_path):
    from backend.app.api.routes import library
    from backend.app.models.library import LibraryFile, LibraryFolder

    stl = tmp_path / "a.stl"
    stl.write_bytes(b"x" * (library.MIN_USABLE_STL_BYTES + 10))
    folder = LibraryFolder(name="ext")
    db_session.add(folder)
    await db_session.commit()
    db_session.add(
        LibraryFile(
            folder_id=folder.id, filename="a.stl", file_path=str(stl), file_type="stl", file_size=stl.stat().st_size
        )
    )
    await db_session.commit()

    threads: list[threading.Thread] = []

    def fake_render(path, out_dir):
        threads.append(threading.current_thread())
        return None

    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with (
        patch.object(library, "async_session", maker),
        patch.object(library, "generate_stl_thumbnail", fake_render),
        patch.object(library, "to_absolute_path", lambda p: stl),
    ):
        await library._backfill_external_stl_thumbnails([folder.id])

    assert threads, "render was never invoked"
    assert threads[0] is not threading.main_thread()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_concurrent_backfills_of_same_folder_render_once(test_engine, db_session, tmp_path):
    import asyncio

    from backend.app.api.routes import library
    from backend.app.models.library import LibraryFile, LibraryFolder

    stl = tmp_path / "a.stl"
    stl.write_bytes(b"x" * (library.MIN_USABLE_STL_BYTES + 10))
    folder = LibraryFolder(name="ext")
    db_session.add(folder)
    await db_session.commit()
    db_session.add(
        LibraryFile(
            folder_id=folder.id, filename="a.stl", file_path=str(stl), file_type="stl", file_size=stl.stat().st_size
        )
    )
    await db_session.commit()

    gate = threading.Event()
    renders: list[str] = []

    def fake_render(path, out_dir):
        renders.append(str(path))
        gate.wait(5)
        return None

    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    with (
        patch.object(library, "async_session", maker),
        patch.object(library, "generate_stl_thumbnail", fake_render),
        patch.object(library, "to_absolute_path", lambda p: stl),
    ):
        first = asyncio.create_task(library._backfill_external_stl_thumbnails([folder.id]))
        while not renders:
            await asyncio.sleep(0.01)
        await library._backfill_external_stl_thumbnails([folder.id])
        gate.set()
        await first

    assert len(renders) == 1
