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
from sqlalchemy import Table, literal_column, select

from backend.app.core.database import ARCHIVE_FTS_DEFINITION, ARCHIVE_FTS_TRIGGERS
from backend.app.services.zip_limits import ZipBudget, ZipTooLargeError, check_zip_size
from backend.app.utils.safe_path import PathTraversalError, safe_join_under

logger = logging.getLogger(__name__)
RESTORE_WORKSPACE_PREFIX = ".layercove-restore-"
_REQUIRED_BACKUP_COLUMNS = {
    "settings": {"id", "key", "value"},
    "users": {"id", "username"},
    "printers": {"id", "name"},
    "print_archives": {"id", "filename", "file_path", "file_size"},
}


def extract_backup(file: BinaryIO, destination: Path, *, max_bytes: int, max_entries: int) -> Path:
    try:
        with zipfile.ZipFile(file) as archive:
            entries = archive.infolist()
            if len(entries) > max_entries:
                raise HTTPException(413, f"Backup contains {len(entries)} ZIP entries, over the {max_entries} limit")
            check_zip_size(archive, max_bytes=max_bytes)
            names = {entry.filename for entry in entries}
            legacy = names & {"bambutrack.db", "bambuddy.db"}
            if legacy:
                raise HTTPException(
                    400,
                    "Unsupported legacy backup database: "
                    + ", ".join(sorted(legacy))
                    + ". Export legacy data and create a new LayerCove backup.",
                )
            if "layercove.db" not in names:
                raise HTTPException(400, "Invalid backup: missing layercove.db")
            targets: dict[Path, zipfile.ZipInfo] = {}
            for entry in entries:
                if entry.flag_bits & 1:
                    raise HTTPException(400, "Invalid backup: encrypted ZIP entries are unsupported")
                try:
                    target = safe_join_under(destination, entry.filename, http=False)
                except PathTraversalError:
                    raise HTTPException(400, f"Invalid backup: unsafe path in ZIP: {entry.filename!r}") from None
                if target == destination or target in targets:
                    raise HTTPException(400, "Invalid backup: conflicting ZIP paths")
                targets[target] = entry

            budget = ZipBudget(max_bytes)
            for target, entry in targets.items():
                for parent in target.relative_to(destination).parents:
                    parent_entry = targets.get(destination / parent)
                    if parent_entry is not None and not parent_entry.is_dir():
                        raise HTTPException(400, "Invalid backup: conflicting ZIP paths")
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entry) as reader, target.open("wb") as writer:
                        budget.copy(reader, writer)
    except ZipTooLargeError as error:
        raise HTTPException(413, str(error)) from error
    except (zipfile.BadZipFile, NotImplementedError) as error:
        raise HTTPException(400, "Invalid backup file: invalid or unsupported ZIP") from error
    return destination / "layercove.db"


def open_source_database(path: Path, *, check_same_thread: bool = True) -> sqlite3.Connection:
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, check_same_thread=check_same_thread)


def copy_sqlite_database(source: Path, destination: Path) -> None:
    with closing(open_source_database(source)) as reader, closing(sqlite3.connect(destination)) as writer:
        reader.backup(writer)


def source_columns(source: sqlite3.Connection, table_name: str) -> set[str]:
    return {row[0] for row in source.execute("SELECT name FROM pragma_table_info(?)", (table_name,))}


def require_manual_start_for_pending_prints(database: Path) -> None:
    """Hold pending jobs in the staged database before either backend restores them."""
    with closing(sqlite3.connect(database)) as source, source:
        if not source.execute("SELECT 1 FROM sqlite_schema WHERE name = 'print_queue' AND type = 'table'").fetchone():
            return
        columns = source_columns(source, "print_queue")
        if "status" not in columns:
            raise HTTPException(400, "Invalid backup: print_queue is missing the status column")
        source.execute("BEGIN")
        if "manual_start" not in columns:
            source.execute("ALTER TABLE print_queue ADD COLUMN manual_start BOOLEAN NOT NULL DEFAULT FALSE")
        source.execute("UPDATE print_queue SET manual_start = TRUE WHERE status = 'pending'")


def validate_backup_database(path: Path, postgres_tables: tuple[Table, ...] = ()) -> None:
    try:
        with closing(open_source_database(path)) as source:
            for name, kind, ddl in source.execute(
                "SELECT objects.name, objects.type, objects.sql FROM sqlite_schema AS objects "
                "LEFT JOIN pragma_table_list AS tables ON tables.schema = 'main' AND tables.name = objects.name "
                "WHERE objects.type IN ('trigger', 'view') OR tables.type = 'virtual' OR objects.name = 'archive_fts'"
            ):
                if kind == "trigger" and ddl == f"CREATE TRIGGER {ARCHIVE_FTS_TRIGGERS.get(name, '')}":
                    continue
                if (
                    kind == "table"
                    and name == "archive_fts"
                    and ddl == f"CREATE VIRTUAL TABLE {ARCHIVE_FTS_DEFINITION}"
                ):
                    continue
                raise HTTPException(400, "Invalid backup: unexpected SQLite schema object")
            if source.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise HTTPException(400, "Invalid backup: database integrity check failed")
            for table_name, required_columns in _REQUIRED_BACKUP_COLUMNS.items():
                is_table = source.execute(
                    "SELECT 1 FROM sqlite_schema WHERE name = ? AND type = 'table'", (table_name,)
                ).fetchone()
                if not is_table:
                    raise HTTPException(400, f"Invalid backup: layercove.db is missing the {table_name} table")
                if missing_columns := required_columns - source_columns(source, table_name):
                    names = ", ".join(sorted(missing_columns))
                    raise HTTPException(400, f"Invalid backup: {table_name} is missing required columns: {names}")
            for table in postgres_tables:
                columns = source_columns(source, table.name)
                if not columns:
                    continue
                missing = [
                    col.name
                    for col in table.columns
                    if col.name not in columns
                    and (col.primary_key or (not col.nullable and col.default is None and col.server_default is None))
                ]
                if missing:
                    first_row = select(literal_column("1")).select_from(table).limit(1)
                    query = first_row.compile(compile_kwargs={"literal_binds": True})
                    if source.execute(str(query)).fetchone():
                        raise HTTPException(
                            400, f"Invalid backup: {table.name} is missing required columns: {', '.join(missing)}"
                        )
    except sqlite3.DatabaseError:
        raise HTTPException(400, "Invalid backup: layercove.db is not a readable SQLite database")


def validate_restored_sqlite_columns(path: Path, tables: tuple[Table, ...]) -> None:
    """Check existing tables after startup migrations and before accepting a SQLite restore."""
    with closing(open_source_database(path)) as source:
        for table in tables:
            columns = source_columns(source, table.name)
            if columns and (missing := set(table.columns.keys()) - columns):
                names = ", ".join(sorted(missing))
                raise HTTPException(400, f"Invalid backup: {table.name} is missing required columns: {names}")


def prepare_backup_secrets(database: Path, backup_key: Path, current_key: Path) -> None:
    from backend.app.core.encryption import _FERNET_PREFIX, configured_fernet_key, read_fernet_key_file

    env_key, key_source = configured_fernet_key()
    key_path = backup_key if backup_key.exists() else current_key
    if backup_key.exists() and not backup_key.is_file():
        raise HTTPException(400, "Invalid backup: the MFA encryption key is invalid")
    file_key = None
    if key_path.is_file():
        try:
            file_key = read_fernet_key_file(key_path).encode("ascii")
        except ValueError as error:
            if key_path == backup_key:
                raise HTTPException(400, "Invalid backup: the MFA encryption key is invalid") from error
    key = file_key if key_source == "file" else env_key.encode() if env_key else None
    try:
        cipher = Fernet(key) if key is not None else None
    except ValueError:
        cipher = None

    with closing(sqlite3.connect(database)) as source, source:
        fernet_pattern = (_FERNET_PREFIX + "%",)
        encrypted_columns = (
            (
                "oidc_providers",
                "client_secret",
                "SELECT client_secret FROM oidc_providers WHERE client_secret LIKE ?",
                fernet_pattern,
            ),
            ("user_totp", "secret", "SELECT secret FROM user_totp WHERE secret LIKE ?", fernet_pattern),
            (
                "moonraker_printer_configs",
                "api_key_ciphertext",
                "SELECT api_key_ciphertext FROM moonraker_printer_configs WHERE api_key_ciphertext IS NOT NULL",
                (),
            ),
            (
                "moonraker_printer_configs",
                "authorization_ciphertext",
                "SELECT authorization_ciphertext FROM moonraker_printer_configs WHERE authorization_ciphertext IS NOT NULL",
                (),
            ),
        )
        for table, column, query, parameters in encrypted_columns:
            if column not in source_columns(source, table):
                continue
            for (value,) in source.execute(query, parameters):
                try:
                    if cipher is None or not isinstance(value, str) or not value.startswith(_FERNET_PREFIX):
                        raise ValueError
                    cipher.decrypt(value.removeprefix(_FERNET_PREFIX).encode())
                except (InvalidToken, ValueError):
                    raise HTTPException(400, "Invalid backup: encrypted settings cannot be opened with the restore key")

        if cipher is not None:
            legacy_columns = (
                (
                    "oidc_providers",
                    "client_secret",
                    "SELECT id, client_secret FROM oidc_providers WHERE client_secret <> '' AND client_secret NOT LIKE ?",
                    "UPDATE oidc_providers SET client_secret = ? WHERE id = ?",
                ),
                (
                    "user_totp",
                    "secret",
                    "SELECT id, secret FROM user_totp WHERE secret <> '' AND secret NOT LIKE ?",
                    "UPDATE user_totp SET secret = ? WHERE id = ?",
                ),
            )
            for table, column, query, update in legacy_columns:
                if {"id", column} <= source_columns(source, table):
                    for row_id, plaintext in source.execute(query, fernet_pattern):
                        encrypted = _FERNET_PREFIX + cipher.encrypt(plaintext.encode()).decode()
                        source.execute(update, (encrypted, row_id))


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
        remaining = []
        blocked: set[Path] = set()
        for source, target in reversed(self._completed_moves):
            if any(
                path.is_relative_to(other) or other.is_relative_to(path)
                for path in (source, target)
                for other in blocked
            ):
                remaining.append((source, target))
                blocked.update((source, target))
                continue
            try:
                os.replace(target, source)
            except OSError:
                remaining.append((source, target))
                blocked.update((source, target))
        self._completed_moves = list(reversed(remaining))
        if remaining:
            raise OSError(f"Could not reverse {len(remaining)} restore file moves")

    def clean_up(self) -> None:
        for working in reversed(self.workspaces):
            try:
                shutil.rmtree(working)
            except OSError:
                logger.exception("Could not remove restore workspace %s", working)
