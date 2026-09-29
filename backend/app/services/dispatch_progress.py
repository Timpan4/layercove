"""Live dispatch telemetry for the singleton scheduler, not job ownership.

Queue rows remain authoritative. This small cache makes progress available to
polling clients and browsers that reconnect midway through a transfer. A restart
clears in-flight upload telemetry; durable start reconciliation remains in SQL.
"""

from datetime import datetime, timezone
from threading import Lock
from time import monotonic
from typing import Literal

DispatchStage = Literal["preparing", "uploading", "awaiting_printer"]
_MAX_ENTRIES = 1024
_MAX_AGE_SECONDS = 6 * 60 * 60
_lock = Lock()
_progress: dict[int, tuple[float, dict]] = {}


def set_stage(item_id: int, stage: DispatchStage, total_bytes: int | None = None) -> None:
    now = datetime.now(timezone.utc).isoformat()
    with _lock:
        previous = _progress.get(item_id)
        data = dict(previous[1]) if previous else {"started_at": now}
        data.update(stage=stage, stage_started_at=now, updated_at=now)
        if stage == "uploading":
            data.update(bytes_transferred=0, total_bytes=total_bytes)
        if len(_progress) >= _MAX_ENTRIES and item_id not in _progress:
            del _progress[next(iter(_progress))]
        _progress[item_id] = (monotonic(), data)


def update_bytes(item_id: int, transferred: int, total: int) -> None:
    with _lock:
        previous = _progress.get(item_id)
        if previous is None or previous[1]["stage"] != "uploading":
            return  # Late progress must not revive a completed dispatch.
        data = dict(previous[1])
        data.update(
            bytes_transferred=max(0, min(transferred, total)),
            total_bytes=total,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
        _progress[item_id] = (monotonic(), data)


def clear(item_id: int) -> None:
    with _lock:
        _progress.pop(item_id, None)


def snapshot(item_id: int) -> dict | None:
    with _lock:
        value = _progress.get(item_id)
        if value is None:
            return None
        if monotonic() - value[0] > _MAX_AGE_SECONDS:
            _progress.pop(item_id, None)
            return None
        return dict(value[1])
