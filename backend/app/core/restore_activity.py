"""Stop admitting application work while a backup replaces live state."""

import asyncio
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass


@dataclass
class _Admission:
    active: bool = True


class RestoreActivity:
    def __init__(self) -> None:
        self._paused = False
        self._active = 0
        self._drained: asyncio.Future[None] | None = None
        self._resumed: asyncio.Future[None] | None = None
        self._restore_task: asyncio.Task | None = None
        self._admission: ContextVar[_Admission | None] = ContextVar("restore_admission", default=None)

    @property
    def paused(self) -> bool:
        return self._paused

    @contextmanager
    def admit(self, *, restoring_printer_events: bool = False) -> Iterator[bool]:
        parent = self._admission.get()
        already_admitted = parent is not None and parent.active
        if (
            self._paused
            and not already_admitted
            and not restoring_printer_events
            and asyncio.current_task() is not self._restore_task
        ):
            yield False
            return
        admission = _Admission()
        token = self._admission.set(admission)
        self._active += 1
        try:
            yield True
        finally:
            admission.active = False
            self._admission.reset(token)
            self._active -= 1
            if not self._active and self._drained is not None and not self._drained.done():
                self._drained.set_result(None)

    @asynccontextmanager
    async def wait_for_admission(self) -> AsyncIterator[None]:
        while True:
            with self.admit() as admitted:
                if admitted:
                    yield
                    return
            if self._resumed is not None:
                await asyncio.shield(self._resumed)

    async def pause(self) -> None:
        self._paused = True
        self._restore_task = asyncio.current_task()
        if self._resumed is None:
            self._resumed = asyncio.get_running_loop().create_future()
        if self._active:
            self._drained = asyncio.get_running_loop().create_future()
            try:
                await self._drained
            finally:
                self._drained = None

    def resume(self) -> None:
        self._paused = False
        self._restore_task = None
        if self._resumed is not None:
            self._resumed.set_result(None)
            self._resumed = None


restore_activity = RestoreActivity()
