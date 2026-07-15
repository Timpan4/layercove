#!/usr/bin/env python3
"""Back up or restore a Spoolman data directory safely."""

from __future__ import annotations

import argparse
import os
import shutil
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

STAGING_NAME = ".layercove-restore-staging"
ROLLBACK_NAME = ".layercove-restore-rollback"
ROLLBACK_MARKER = ".complete"


def _remove(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def _copy_contents(source: Path, destination: Path, *, skip: set[str] | None = None) -> None:
    skip = skip or set()
    for item in source.iterdir():
        if item.name in skip:
            continue
        target = destination / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)


def _clear_live_data(data_dir: Path) -> None:
    for item in data_dir.iterdir():
        if item.name not in {STAGING_NAME, ROLLBACK_NAME}:
            _remove(item)


def _recover_interrupted_restore(data_dir: Path) -> None:
    staging = data_dir / STAGING_NAME
    rollback = data_dir / ROLLBACK_NAME
    marker = rollback / ROLLBACK_MARKER
    if rollback.exists() and marker.is_file():
        _clear_live_data(data_dir)
        _copy_contents(rollback, data_dir, skip={ROLLBACK_MARKER})
        marker.unlink()
    _remove(staging)
    _remove(rollback)


def _validate_archive(source: tarfile.TarFile) -> None:
    reserved = {STAGING_NAME, ROLLBACK_NAME}
    for member in source.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise tarfile.ExtractError(f"unsafe path in backup: {member.name}")
        if path.parts and path.parts[0] in reserved:
            raise tarfile.ExtractError(f"reserved path in backup: {member.name}")
        if not (member.isfile() or member.isdir()):
            raise tarfile.ExtractError(f"unsupported entry in backup: {member.name}")


def _discard_rollback(rollback: Path) -> None:
    marker = rollback / ROLLBACK_MARKER
    if marker.is_file():
        marker.unlink()
    _remove(rollback)


def backup(data_dir: Path, archive: Path) -> None:
    if not data_dir.is_dir():
        raise SystemExit(f"Spoolman data directory does not exist: {data_dir}")
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=f".{archive.name}.", suffix=".tmp", dir=archive.parent)
        os.close(descriptor)
        temporary = Path(name)
        with tarfile.open(temporary, "w:gz") as output:
            for item in data_dir.iterdir():
                if item.name not in {STAGING_NAME, ROLLBACK_NAME}:
                    output.add(item, arcname=item.name)
        with tarfile.open(temporary, "r:gz") as source:
            _validate_archive(source)
        temporary.chmod(0o640)
        os.replace(temporary, archive)
        temporary = None
    finally:
        if temporary is not None:
            _remove(temporary)


def restore(data_dir: Path, archive: Path) -> None:
    if not archive.is_file():
        raise SystemExit(f"Spoolman backup does not exist: {archive}")
    data_dir.mkdir(parents=True, exist_ok=True)
    _recover_interrupted_restore(data_dir)

    staging = data_dir / STAGING_NAME
    rollback = data_dir / ROLLBACK_NAME
    staging.mkdir()
    replacement_succeeded = False
    rollback_succeeded = False
    try:
        with tarfile.open(archive, "r:gz") as source:
            _validate_archive(source)
            source.extractall(staging, filter="data")

        rollback.mkdir()
        _copy_contents(data_dir, rollback, skip={STAGING_NAME, ROLLBACK_NAME})
        (rollback / ROLLBACK_MARKER).touch()

        _clear_live_data(data_dir)
        _copy_contents(staging, data_dir)
        replacement_succeeded = True
    except BaseException:
        if (rollback / ROLLBACK_MARKER).is_file():
            try:
                _clear_live_data(data_dir)
                _copy_contents(rollback, data_dir, skip={ROLLBACK_MARKER})
                rollback_succeeded = True
            except BaseException as rollback_error:
                raise RuntimeError(
                    f"Restore and automatic rollback failed; intact snapshot retained at {rollback}"
                ) from rollback_error
        raise
    finally:
        _remove(staging)
        if replacement_succeeded or rollback_succeeded:
            _discard_rollback(rollback)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("backup", "restore"))
    parser.add_argument("data_dir", type=Path)
    parser.add_argument("archive", type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    globals()[args.operation](args.data_dir, args.archive)


if __name__ == "__main__":
    main()
