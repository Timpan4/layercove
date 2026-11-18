"""Validate backup contents and retain the previous files during a restore."""

import logging
import os
import shutil
import sqlite3
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path
from typing import BinaryIO

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from sqlalchemy import Table

from backend.app.utils.safe_path import PathTraversalError, safe_join_under

logger = logging.getLogger(__name__)
RESTORE_WORKSPACE_PREFIX = ".layercove-restore-"


def extract_backup(file: BinaryIO, destination: Path) -> Path:
    try:
        with zipfile.ZipFile(file) as archive:
            names = archive.namelist()
            legacy = set(names) & {"bambutrack.db", "bambuddy.db"}
            if legacy:
                raise HTTPException(
                    400,
                    "Unsupported legacy backup database: "
                    + ", ".join(sorted(legacy))
                    + ". Export legacy data and create a new LayerCove backup.",
                )
            if "layercove.db" not in names:
                raise HTTPException(400, "Invalid backup: missing layercove.db")
            for name in names:
                try:
                    safe_join_under(destination, name, http=False)
                except PathTraversalError:
                    raise HTTPException(400, f"Invalid backup: unsafe path in ZIP: {name!r}") from None
            archive.extractall(destination)
    except zipfile.BadZipFile:
        raise HTTPException(400, "Invalid backup file: not a valid ZIP")
    return destination / "layercove.db"


def open_source_database(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)


def copy_sqlite_database(source: Path, destination: Path) -> None:
    with closing(open_source_database(source)) as reader, closing(sqlite3.connect(destination)) as writer:
        reader.backup(writer)


def source_columns(source: sqlite3.Connection, table: Table) -> set[str]:
    # Table names come from the application's SQLAlchemy metadata.
    return {row[1] for row in source.execute(f'PRAGMA table_info("{table.name}")')}


def validate_backup_database(path: Path, postgres_tables: tuple[Table, ...] = ()) -> None:
    try:
        with closing(open_source_database(path)) as source:
            if source.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise HTTPException(400, "Invalid backup: database integrity check failed")
            if source.execute("PRAGMA table_info(settings)").fetchone() is None:
                raise HTTPException(400, "Invalid backup: layercove.db has no settings table")
            for table in postgres_tables:
                columns = source_columns(source, table)
                if not columns:
                    continue
                missing = [
                    col.name
                    for col in table.columns
                    if col.name not in columns
                    and (col.primary_key or (not col.nullable and col.default is None and col.server_default is None))
                ]
                if missing and source.execute(f'SELECT 1 FROM "{table.name}" LIMIT 1').fetchone():  # noqa: S608
                    raise HTTPException(
                        400, f"Invalid backup: {table.name} is missing required columns: {', '.join(missing)}"
                    )
    except sqlite3.DatabaseError:
        raise HTTPException(400, "Invalid backup: layercove.db is not a readable SQLite database")


def validate_backup_secrets(database: Path, backup_key: Path, current_key: Path) -> None:
    from backend.app.core.encryption import _FERNET_PREFIX, _LEGACY_ENV_KEY, _PREFERRED_ENV_KEY

    configured_keys = [
        value.encode() for name in (_PREFERRED_ENV_KEY, _LEGACY_ENV_KEY) if (value := os.environ.get(name)) is not None
    ]
    key_path = backup_key if backup_key.exists() else current_key
    if backup_key.exists() and not backup_key.is_file():
        raise HTTPException(400, "Invalid backup: the MFA encryption key is invalid")
    file_key = key_path.read_bytes().strip() if key_path.is_file() else None
    if backup_key.exists() and file_key is not None:
        try:
            Fernet(file_key)
        except ValueError:
            raise HTTPException(400, "Invalid backup: the MFA encryption key is invalid")

    with closing(open_source_database(database)) as source:
        for table, column in (("oidc_providers", "client_secret"), ("user_totp", "secret")):
            columns = {item[1] for item in source.execute(f"PRAGMA table_info({table})")}
            if column not in columns:
                continue
            rows = source.execute(f"SELECT {column} FROM {table} WHERE {column} LIKE ?", (_FERNET_PREFIX + "%",))  # noqa: S608
            for (value,) in rows:
                try:
                    if configured_keys and any(other != configured_keys[0] for other in configured_keys):
                        raise ValueError
                    key = configured_keys[0] if configured_keys else file_key
                    if key is None:
                        raise ValueError
                    Fernet(key).decrypt(value.removeprefix(_FERNET_PREFIX).encode())
                except (InvalidToken, ValueError):
                    raise HTTPException(400, "Invalid backup: encrypted settings cannot be opened with the restore key")


class RestoreFiles:
    """Stage replacements on each target filesystem, including mounted directories."""

    def __init__(self) -> None:
        self.workspaces: list[Path] = []
        self._directories: list[tuple[Path, Path]] = []
        self._key: tuple[Path, Path] | None = None
        self._completed_moves: list[tuple[Path, Path]] = []

    def workspace(self, parent: Path) -> Path:
        working = Path(tempfile.mkdtemp(prefix=RESTORE_WORKSPACE_PREFIX, dir=parent))
        self.workspaces.append(working)
        return working

    def stage(self, extracted: Path, directories: list[tuple[str, Path]], key: Path) -> None:
        for name, target in directories:
            source = extracted / name
            if not source.exists():
                continue
            if not source.is_dir():
                raise HTTPException(400, f"Invalid backup: {name} must be a directory")
            target.mkdir(parents=True, exist_ok=True)
            working = self.workspace(target)
            shutil.copytree(
                source,
                working / "replacement",
                copy_function=shutil.copy2,
                ignore=shutil.ignore_patterns(f"{RESTORE_WORKSPACE_PREFIX}*"),
            )
            (working / "previous").mkdir()
            self._directories.append((target, working))

        source = extracted / key.name
        if source.exists():
            try:
                key.parent.mkdir(parents=True, exist_ok=True)
                working = self.workspace(key.parent)
                staged_key = working / ".mfa_encryption_key.restore-tmp"
                fd = os.open(staged_key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as destination, source.open("rb") as reader:
                    shutil.copyfileobj(reader, destination)
                self._key = key, working
            except OSError:
                raise HTTPException(500, "Restore aborted: MFA key write failed. Database is unchanged.")

    def _move(self, source: Path, target: Path) -> None:
        os.replace(source, target)
        self._completed_moves.append((source, target))

    def install(self) -> None:
        for target, working in self._directories:
            for current in list(target.iterdir()):
                if not current.name.startswith(RESTORE_WORKSPACE_PREFIX):
                    self._move(current, working / "previous" / current.name)
            for replacement in list((working / "replacement").iterdir()):
                self._move(replacement, target / replacement.name)
        if self._key is not None:
            key, working = self._key
            if key.exists() or key.is_symlink():
                self._move(key, working / "previous-key")
            self._move(working / ".mfa_encryption_key.restore-tmp", key)

    def rollback(self) -> None:
        for source, target in reversed(self._completed_moves):
            os.replace(target, source)
        self._completed_moves.clear()

    def clean_up(self) -> None:
        for working in reversed(self.workspaces):
            try:
                shutil.rmtree(working)
            except OSError:
                logger.exception("Could not remove restore workspace %s", working)
