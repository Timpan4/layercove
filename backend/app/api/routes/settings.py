import asyncio
import logging
import os
import zipfile
from datetime import datetime
from pathlib import Path
from typing import BinaryIO

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.core.auth import RequirePermissionIfAuthEnabled, caller_is_api_key, require_energy_cost_update
from backend.app.core.config import settings as app_settings
from backend.app.core.database import get_db
from backend.app.core.permissions import Permission
from backend.app.core.restore_activity import restore_activity
from backend.app.models.settings import Settings
from backend.app.models.user import User
from backend.app.schemas.settings import AppSettings, AppSettingsUpdate
from backend.app.services.settings_service import (
    DEFAULT_SETTINGS,
    get_app_settings,
    get_homeassistant_settings as _get_homeassistant_settings,
    get_setting,
    save_settings,
    set_setting,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])


def _sqlalchemy_type_to_sqlite_type(type_repr: str) -> str:
    """Map a SQLAlchemy column type's ``str()`` to a SQLite-native column type.

    Used by ``create_backup_zip`` to reconstruct a portable SQLite database
    file from PostgreSQL data. Falling through to TEXT for binary columns
    corrupts non-UTF8 bytes — the BLOB branch is the #1333 regression guard
    for OIDC icon BLOBs.

    Extracted as a pure helper so it can be unit-tested without spinning up
    the full FastAPI app + backup pipeline.
    """
    type_str = type_repr.upper()
    if "INT" in type_str:
        return "INTEGER"
    if "FLOAT" in type_str or "REAL" in type_str or "NUMERIC" in type_str:
        return "REAL"
    if "BOOL" in type_str:
        return "BOOLEAN"
    if "BLOB" in type_str or "BYTEA" in type_str or "BINARY" in type_str:
        # OIDC icon BLOB column (#1333) — without this branch the column
        # was created as TEXT and non-UTF8 bytes were corrupted during the
        # PG→SQLite-ZIP backup round trip.
        return "BLOB"
    return "TEXT"


async def get_external_login_url(db: AsyncSession) -> str:
    """Get the external URL for the login page.

    Uses external_url from settings if available, otherwise falls back to APP_URL env var.

    Args:
        db: Database session

    Returns:
        Full URL to the login page
    """
    import os

    external_url = await get_setting(db, "external_url")
    if external_url:
        external_url = external_url.rstrip("/")
    else:
        external_url = os.environ.get("APP_URL", "http://localhost:5173")
    return external_url + "/login"


async def _build_settings_response(db: AsyncSession, is_api_key: bool = False) -> AppSettings:
    """Build the typed settings response, scrubbing API-key secrets."""
    return await get_app_settings(db, is_api_key=is_api_key)


async def get_homeassistant_settings(db: AsyncSession) -> dict[str, str | bool]:
    """Get Home Assistant settings for legacy callers."""
    return await _get_homeassistant_settings(db, get_setting)


@router.get("", response_model=AppSettings)
@router.get("/", response_model=AppSettings)
async def get_settings(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
    _is_api_key: bool = Depends(caller_is_api_key),
):
    """Get all application settings."""
    return await _build_settings_response(db, is_api_key=_is_api_key)


@router.put("/", response_model=AppSettings)
async def update_settings(
    settings_update: AppSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Update application settings."""
    update_data = settings_update.model_dump(exclude_unset=True)

    # Safety refusals on disabling local login (#1589). Two failure modes
    # would otherwise lock everyone out of the install:
    #   1. No enabled OIDC provider exists — nobody could authenticate.
    #   2. The caller has no UserOIDCLink — they would lock themselves out
    #      even if other admins are linked.
    # Either case returns HTTP 400 instead of silently saving. The
    # ``BAMBUDDY_LOCAL_LOGIN=true`` env-var bypass on /auth/login is a
    # separate recovery path; the refusals here protect the *default*
    # configuration where the env var is absent.
    if update_data.get("local_login_enabled") is False:
        from backend.app.models.oidc_provider import OIDCProvider, UserOIDCLink

        enabled_count = await db.scalar(select(func.count(OIDCProvider.id)).where(OIDCProvider.is_enabled.is_(True)))
        if not enabled_count:
            raise HTTPException(
                status_code=400,
                detail="Cannot disable local login: no OIDC provider is enabled.",
            )
        if current_user is not None:
            caller_links = await db.scalar(
                select(func.count(UserOIDCLink.id)).where(UserOIDCLink.user_id == current_user.id)
            )
            if not caller_links:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot disable local login: your account has no OIDC link, so you would lock yourself out.",
                )

    # Check if any MQTT settings are being updated
    mqtt_keys = {
        "mqtt_enabled",
        "mqtt_broker",
        "mqtt_port",
        "mqtt_username",
        "mqtt_password",
        "mqtt_topic_prefix",
        "mqtt_use_tls",
    }
    mqtt_updated = bool(mqtt_keys & set(update_data))

    await save_settings(db, settings_update)

    await db.commit()
    # Expire all objects to ensure fresh reads after commit
    db.expire_all()

    # Reconfigure MQTT relay if any MQTT settings changed
    if mqtt_updated:
        try:
            from backend.app.services.mqtt_relay import mqtt_relay

            mqtt_settings = {
                "mqtt_enabled": (await get_setting(db, "mqtt_enabled") or "false") == "true",
                "mqtt_broker": await get_setting(db, "mqtt_broker") or "",
                "mqtt_port": int(await get_setting(db, "mqtt_port") or "1883"),
                "mqtt_username": await get_setting(db, "mqtt_username") or "",
                "mqtt_password": await get_setting(db, "mqtt_password") or "",
                "mqtt_topic_prefix": await get_setting(db, "mqtt_topic_prefix") or "bambuddy",
                "mqtt_use_tls": (await get_setting(db, "mqtt_use_tls") or "false") == "true",
            }
            await mqtt_relay.configure(mqtt_settings)
        except Exception:
            pass  # Don't fail the settings update if MQTT reconfiguration fails

    # Return updated settings (never scrub secrets on PUT — caller has SETTINGS_UPDATE permission)
    return await _build_settings_response(db, is_api_key=False)


@router.patch("/", response_model=AppSettings)
@router.patch("", response_model=AppSettings)
async def patch_settings(
    settings_update: AppSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Partially update application settings (same as PUT, for REST compatibility)."""
    return await update_settings(settings_update, db, _)


class ElectricityPriceUpdate(BaseModel):
    """Payload for ``POST /settings/electricity-price`` (#1356).

    Mirrors the field name documented in ``wiki/features/energy.md`` so the
    Home Assistant ``rest_command`` example needs only a URL change, not a
    payload change. Plain non-negative float; tariffs can go as low as 0.0 in
    some markets (e.g. free hours).
    """

    energy_cost_per_kwh: float = Field(ge=0)


@router.post("/electricity-price", response_model=AppSettings)
async def update_electricity_price(
    payload: ElectricityPriceUpdate,
    db: AsyncSession = Depends(get_db),
    _: User | None = Depends(require_energy_cost_update()),
    _is_api_key: bool = Depends(caller_is_api_key),
):
    """Update the per-kWh electricity cost used by the energy-tracking pipeline.

    This is the only settings field writable via API key, gated by the
    ``can_update_energy_cost`` toggle on the key. JWT users still need the
    standard ``SETTINGS_UPDATE`` permission. See #1356 for the rationale —
    the general ``PATCH /settings`` route remains denied for API keys because
    it can rewrite SMTP/LDAP/MQTT credentials, which is a much wider surface
    than the documented dynamic-tariff use case requires.
    """
    await set_setting(db, "energy_cost_per_kwh", str(payload.energy_cost_per_kwh))
    await db.commit()
    db.expire_all()
    return await _build_settings_response(db, is_api_key=_is_api_key)


@router.post("/reset", response_model=AppSettings)
async def reset_settings(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Reset all settings to defaults."""
    # Delete all settings
    result = await db.execute(select(Settings))
    for setting in result.scalars().all():
        await db.delete(setting)

    await db.commit()

    return DEFAULT_SETTINGS


@router.get("/default-sidebar-order")
async def get_default_sidebar_order(
    db: AsyncSession = Depends(get_db),
):
    """Get the admin-set default sidebar order.

    Intentionally unauthenticated: non-admin users need to read this value to apply
    the default sidebar order, but may lack SETTINGS_READ permission.
    The value is non-sensitive (sidebar item IDs only).
    """
    value = await get_setting(db, "default_sidebar_order")
    return {"default_sidebar_order": value or ""}


# Fields exposed via /ui-preferences without SETTINGS_READ. Each entry MUST be
# non-sensitive (no credentials, no PII, no secret tokens) — granting SETTINGS_READ
# also grants visibility of SMTP/LDAP/MQTT passwords and similar, so the goal of
# this endpoint is exactly to NOT require that permission for UI rendering hints.
# When adding a field here, confirm it doesn't carry anything sensitive.
_UI_PREFERENCE_FIELDS: tuple[str, ...] = (
    "require_plate_clear",
    "check_printer_firmware",
    "camera_view_mode",
    "time_format",
    "date_format",
    "drying_presets",
    "ams_humidity_thresholds",
    "ams_humidity_good",
    "ams_humidity_fair",
    "ams_temp_good",
    "ams_temp_fair",
    "bed_cooled_threshold",
    # Temperature / fan-speed presets for the printer-card popovers. Numbers
    # only; no PII / credentials.
    "nozzle_temp_presets",
    "bed_temp_presets",
    "chamber_temp_presets",
    "fan_speed_presets",
)


@router.get("/ui-preferences")
async def get_ui_preferences(db: AsyncSession = Depends(get_db)):
    """Get the curated subset of settings that any page needs to render correctly.

    Intentionally not gated on SETTINGS_READ — every authenticated user (and
    every page that loads for them) needs these fields, but granting SETTINGS_READ
    would also grant visibility of secrets (SMTP/LDAP/MQTT credentials, etc.).
    Same pattern as /default-sidebar-order (#1293).

    Reuses _build_settings_response so the typed values match what /settings
    returns for fields with the same name — bool/int/float/str types stay in
    sync without a separate type-coercion path.
    """
    full = await _build_settings_response(db, is_api_key=False)
    dumped = full.model_dump()
    return {key: dumped[key] for key in _UI_PREFERENCE_FIELDS if key in dumped}


@router.get("/check-ffmpeg")
async def check_ffmpeg(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
):
    """Check if ffmpeg is installed and available.

    Gated on ``SETTINGS_READ`` (audit finding I4 — the binary path was
    leaking the host filesystem layout to unauthenticated callers).
    ``require_permission_if_auth_enabled`` returns ``None`` only when
    auth is disabled (in which case there's no privacy boundary to
    enforce); otherwise it raises 401/403 before we get here.
    """
    from backend.app.services.camera import get_ffmpeg_path

    ffmpeg_path = get_ffmpeg_path()
    return {
        "installed": ffmpeg_path is not None,
        "path": ffmpeg_path,
    }


@router.get("/spoolman")
async def get_spoolman_settings(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
):
    """Get Spoolman integration settings."""
    spoolman_enabled = await get_setting(db, "spoolman_enabled") or "false"
    spoolman_url = await get_setting(db, "spoolman_url") or ""
    spoolman_sync_mode = await get_setting(db, "spoolman_sync_mode") or "auto"
    spoolman_disable_weight_sync = await get_setting(db, "spoolman_disable_weight_sync") or "false"
    spoolman_report_partial_usage = await get_setting(db, "spoolman_report_partial_usage") or "true"
    auto_add_unknown_rfid = await get_setting(db, "auto_add_unknown_rfid") or "true"

    return {
        "spoolman_enabled": spoolman_enabled,
        "spoolman_url": spoolman_url,
        "spoolman_sync_mode": spoolman_sync_mode,
        "spoolman_disable_weight_sync": spoolman_disable_weight_sync,
        "spoolman_report_partial_usage": spoolman_report_partial_usage,
        "auto_add_unknown_rfid": auto_add_unknown_rfid,
    }


@router.put("/spoolman")
async def update_spoolman_settings(
    settings: dict,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Update Spoolman integration settings."""
    if "spoolman_enabled" in settings:
        old_val = await get_setting(db, "spoolman_enabled") or "false"
        new_val = settings["spoolman_enabled"]
        await set_setting(db, "spoolman_enabled", new_val)

        # Switching to Spoolman: clear built-in inventory slot assignments
        if old_val.lower() != "true" and new_val.lower() == "true":
            from backend.app.models.spool_assignment import SpoolAssignment

            result = await db.execute(delete(SpoolAssignment))
            logger.info("Cleared %d spool assignments on switch to Spoolman mode", result.rowcount)
        # Switching back to internal mode: clear Spoolman slot assignments — the
        # symmetric counterpart of the clear above. Without this, stale
        # spoolman_slot_assignments rows linger and would wrongly count as
        # "assigned" in any mode-agnostic check (e.g. the missing-spool-
        # assignment notification, which unions both tables — #1473).
        elif old_val.lower() == "true" and new_val.lower() != "true":
            from backend.app.models.spoolman_slot_assignment import SpoolmanSlotAssignment

            result = await db.execute(delete(SpoolmanSlotAssignment))
            logger.info("Cleared %d Spoolman slot assignments on switch to internal mode", result.rowcount)
    if "spoolman_url" in settings:
        await set_setting(db, "spoolman_url", settings["spoolman_url"])
    if "spoolman_sync_mode" in settings:
        await set_setting(db, "spoolman_sync_mode", settings["spoolman_sync_mode"])
    if "spoolman_disable_weight_sync" in settings:
        await set_setting(db, "spoolman_disable_weight_sync", settings["spoolman_disable_weight_sync"])
    if "spoolman_report_partial_usage" in settings:
        await set_setting(db, "spoolman_report_partial_usage", settings["spoolman_report_partial_usage"])
    if "auto_add_unknown_rfid" in settings:
        await set_setting(db, "auto_add_unknown_rfid", settings["auto_add_unknown_rfid"])

    spoolman_changed = "spoolman_enabled" in settings or "spoolman_url" in settings

    await db.commit()
    db.expire_all()

    if spoolman_changed:
        from backend.app.services.location_service import maybe_sync_spoolman_locations

        if await maybe_sync_spoolman_locations(db):
            await db.commit()

    # Return updated settings
    return await get_spoolman_settings(db)


def _backup_directories() -> list[tuple[str, Path]]:
    base_dir = app_settings.base_dir
    return [
        ("archive", app_settings.archive_dir),
        ("virtual_printer", base_dir / "virtual_printer"),
        ("plate_calibration", app_settings.plate_calibration_dir),
        ("icons", base_dir / "icons"),
        ("projects", base_dir / "projects"),
    ]


async def create_backup_zip(output_path: Path | None = None) -> tuple[Path, str]:
    """Create a complete backup ZIP (database + all data directories).

    If output_path is given, the ZIP is written there.
    Otherwise a temporary file is created (caller must clean up).
    Returns (zip_path, filename).
    """
    async with _backup_restore_lock:
        if restore_activity.paused:
            raise HTTPException(503, "Backup restoration is in progress")
        return await _create_backup_zip(output_path)


async def _create_backup_zip(output_path: Path | None) -> tuple[Path, str]:
    import shutil
    import tempfile

    from backend.app.core.db_dialect import is_sqlite

    filename = f"layercove-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)

        if is_sqlite():
            from starlette.concurrency import run_in_threadpool

            from backend.app.services.backup_restore import copy_sqlite_database

            db_path = Path(app_settings.database_url.replace("sqlite+aiosqlite:///", ""))

            await run_in_threadpool(copy_sqlite_database, db_path, temp_path / "layercove.db")
        else:
            # PostgreSQL: export to a portable SQLite file via SQLAlchemy.
            # This makes backups restorable on both SQLite and Postgres installs.
            import json
            import sqlite3

            from backend.app.core.database import Base, engine

            backup_db_path = temp_path / "layercove.db"
            dst = sqlite3.connect(str(backup_db_path))
            metadata = Base.metadata

            # Create tables in SQLite backup (simplified — just column names and types)
            for table in metadata.sorted_tables:
                cols = []
                pk_cols = [col.name for col in table.columns if col.primary_key]
                for col in table.columns:
                    col_type = _sqlalchemy_type_to_sqlite_type(str(col.type))
                    # Only inline PRIMARY KEY for single-column PKs
                    pk = " PRIMARY KEY" if col.primary_key and len(pk_cols) == 1 else ""
                    cols.append(f"{col.name} {col_type}{pk}")
                # Add composite primary key constraint if needed
                if len(pk_cols) > 1:
                    cols.append(f"PRIMARY KEY ({', '.join(pk_cols)})")
                dst.execute(f"CREATE TABLE IF NOT EXISTS {table.name} ({', '.join(cols)})")  # noqa: S608

            # Export data from Postgres to SQLite
            async with engine.connect() as conn:
                for table in metadata.sorted_tables:
                    result = await conn.execute(table.select())
                    rows = result.fetchall()
                    if not rows:
                        continue
                    columns = list(result.keys())
                    placeholders = ", ".join(["?"] * len(columns))
                    col_list = ", ".join(columns)
                    insert_sql = f"INSERT INTO {table.name} ({col_list}) VALUES ({placeholders})"  # noqa: S608  # nosec B608 — table/column names from ORM metadata, not user input

                    def _serialize_row(row):
                        return tuple(json.dumps(v) if isinstance(v, (list, dict)) else v for v in row)

                    dst.executemany(insert_sql, [_serialize_row(row) for row in rows])

            dst.commit()
            dst.close()
            logger.info("PostgreSQL backup exported to portable SQLite format")

        # Copy data directories (if they exist)
        for name, src_dir in _backup_directories():
            if src_dir.exists() and any(src_dir.iterdir()):
                backup_dir = temp_path / name  # SEC-PATH-OK: _backup_directories supplies fixed names.
                shutil.copytree(src_dir, backup_dir, ignore=shutil.ignore_patterns(".layercove-restore-*"))

        # Include the MFA encryption key as a ZIP top-level entry alongside
        # layercove.db. Without it, encrypted client_secret / TOTP secret rows
        # would be unrecoverable after restore on a host without MFA_ENCRYPTION_KEY set.
        from backend.app.core.paths import resolve_data_dir

        mfa_key_src = resolve_data_dir() / ".mfa_encryption_key"
        if mfa_key_src.exists() and mfa_key_src.is_file():
            try:
                shutil.copy2(mfa_key_src, temp_path / ".mfa_encryption_key")
            except OSError as exc:
                logger.error(
                    "Could not include MFA encryption key in backup (%s). "
                    "The backup ZIP will not contain the key — restore on a "
                    "keyless host will fail for encrypted secrets.",
                    exc,
                )
                raise

        # Create ZIP
        if output_path is not None:
            zip_file = (
                output_path / filename
            )  # SEC-PATH-OK: filename = f"layercove-backup-{datetime.now()...}.zip" generated in create_backup_zip itself
        else:
            fd, tmp = tempfile.mkstemp(suffix=".zip")
            os.close(fd)
            zip_file = Path(tmp)

        with zipfile.ZipFile(zip_file, "w", zipfile.ZIP_DEFLATED) as zf:
            for file_path in temp_path.rglob("*"):
                if file_path.is_file():
                    arcname = file_path.relative_to(temp_path)
                    zf.write(file_path, arcname)

    return zip_file, filename


@router.get("/backup")
async def create_backup(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_BACKUP),
):
    """Create a complete backup (database + all files) as a ZIP download."""
    from starlette.background import BackgroundTask

    try:
        zip_file, filename = await create_backup_zip()
        return FileResponse(
            path=zip_file,
            filename=filename,
            media_type="application/zip",
            background=BackgroundTask(lambda: zip_file.unlink(missing_ok=True)),
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Backup failed: %s", e, exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"success": False, "message": "Backup failed. Check server logs for details."},
        )


def _resume_background_services() -> bool:
    """Restart the schedulers paused for a restore."""
    from backend.app.core.tasks import spawn_background_task
    from backend.app.services.notification_service import notification_service
    from backend.app.services.print_scheduler import scheduler as print_scheduler
    from backend.app.services.smart_plug_manager import smart_plug_manager

    try:
        spawn_background_task(print_scheduler.run(), name="print-scheduler")
        smart_plug_manager.start_scheduler()
        notification_service.start_digest_scheduler()
        logger.info("Resumed background services after restore")
        return True
    except Exception as e:
        logger.warning("Could not resume background services after restore (%s)", type(e).__name__)
        return False


_LEGACY_RESTORE_DROP_TABLES = ("spoolman_slot_assignments", "spoolman_k_profile")


async def _import_sqlite_to_postgres(sqlite_path: Path) -> None:
    """Restore the current PostgreSQL schema and its data in one transaction."""
    import json
    import sqlite3
    from collections import defaultdict
    from contextlib import closing
    from datetime import date, datetime, timezone

    from sqlalchemy import JSON, Boolean, Date, DateTime, MetaData, func, literal_column, select, text
    from sqlalchemy.schema import AddConstraint
    from starlette.concurrency import run_in_threadpool

    from backend.app.core.database import Base, _create_engine
    from backend.app.services.backup_restore import open_source_database, source_columns

    metadata = Base.metadata
    without_foreign_keys = MetaData()
    foreign_keys = []
    for table in metadata.tables.values():
        copied = table.to_metadata(without_foreign_keys)
        for constraint in copied.foreign_key_constraints:
            foreign_keys.append(constraint)
            copied.constraints.remove(constraint)
            for key in constraint.elements:
                copied.foreign_keys.discard(key)
                key.parent.foreign_keys.discard(key)

    def value_for(column, value):
        if isinstance(column.type, Boolean):
            return bool(value)
        if isinstance(column.type, JSON):
            return json.loads(value)
        if isinstance(column.type, DateTime):
            parsed = datetime.fromisoformat(value)
            if column.type.timezone:
                return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
        if isinstance(column.type, Date):
            return date.fromisoformat(value)
        return value

    pg_engine = _create_engine(hide_parameters=True)
    page_size = pg_engine.dialect.insertmanyvalues_page_size

    def read_batch(cursor, columns):
        batches = defaultdict(list)
        for row in cursor.fetchmany(page_size):
            values = {}
            for column in columns:
                value = row[column.name]
                has_default = column.default is not None or column.server_default is not None
                if value is None and not column.nullable and has_default:
                    continue
                values[column.name] = value_for(column, value) if value is not None else None
            batches[tuple(values)].append(values)
        return batches

    try:
        async with pg_engine.begin() as conn:
            # The importer awaits every SQLite call before issuing the next one.
            source_connection = await run_in_threadpool(open_source_database, sqlite_path, check_same_thread=False)
            with closing(source_connection) as source:
                source.row_factory = sqlite3.Row
                await conn.execute(text("SET LOCAL lock_timeout = '10s'"))
                for table_name in [*metadata.tables, *_LEGACY_RESTORE_DROP_TABLES]:
                    await conn.execute(text(f'DROP TABLE IF EXISTS public."{table_name}" CASCADE'))  # noqa: S608
                await conn.run_sync(without_foreign_keys.create_all)

                for table in metadata.sorted_tables:
                    existing = await run_in_threadpool(source_columns, source, table.name)
                    if not existing:
                        continue
                    columns = [column for column in table.columns if column.name in existing]
                    read_rows = select(literal_column("*")).select_from(table)
                    cursor = await run_in_threadpool(source.execute, str(read_rows))
                    imported = False
                    while batches := await run_in_threadpool(read_batch, cursor, columns):
                        imported = True
                        for values in batches.values():
                            await conn.execute(table.insert(), values)

                    if imported and "id" in table.primary_key.columns:
                        sequence = await conn.scalar(select(func.pg_get_serial_sequence(f"public.{table.name}", "id")))
                        if sequence:
                            last_id = await conn.scalar(select(func.max(table.c.id)))
                            if last_id is not None:
                                await conn.execute(select(func.setval(sequence, last_id)))

                for constraint in foreign_keys:
                    await conn.execute(AddConstraint(constraint))
    finally:
        try:
            await pg_engine.dispose()
        except Exception as error:
            logger.warning("Restore database engine cleanup failed (%s)", type(error).__name__)


_restore_lock = asyncio.Lock()
_backup_restore_lock = asyncio.Lock()


@router.post("/restore")
async def restore_backup(
    file: UploadFile = File(...),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_RESTORE),
):
    """Restore a staged backup and preserve the previous state if an operation fails."""
    return await restore_backup_zip(file.file, file.filename)


async def restore_backup_zip(file: BinaryIO, filename: str | None):
    import tempfile

    from anyio import CancelScope
    from starlette.concurrency import run_in_threadpool

    from backend.app.core import database, encryption
    from backend.app.core.db_dialect import is_sqlite
    from backend.app.core.paths import resolve_data_dir
    from backend.app.services.backup_restore import (
        RestoreFiles,
        copy_sqlite_database,
        extract_backup,
        validate_backup_database,
        validate_backup_secrets,
    )
    from backend.app.services.notification_service import notification_service
    from backend.app.services.print_scheduler import scheduler as print_scheduler
    from backend.app.services.printer_manager import init_printer_connections, printer_manager
    from backend.app.services.smart_plug_manager import smart_plug_manager
    from backend.app.services.virtual_printer import virtual_printer_manager

    if not filename or not filename.endswith(".zip"):
        raise HTTPException(400, "Invalid backup file: must be a .zip file")
    if _restore_lock.locked():
        raise HTTPException(409, "A restore is already in progress")

    sqlite_target = is_sqlite()
    postgres_tables = () if sqlite_target else tuple(database.Base.metadata.tables.values())
    files = RestoreFiles()
    services_paused = False
    previous_db = db_path = None
    sqlite_replaced = False
    virtual_printer_enabled = False
    needs_recovery = False
    activity_paused = False
    backup_locked = False
    committed = False
    printers_disconnected = False
    encryption_state = (encryption._fernet_instance, encryption._key_source, encryption._warn_shown)

    async with _restore_lock:
        try:
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as temp_dir:
                extracted = Path(temp_dir).resolve()
                backup_db = await run_in_threadpool(extract_backup, file, extracted)
                await run_in_threadpool(validate_backup_database, backup_db, postgres_tables)
                destination_key = resolve_data_dir() / ".mfa_encryption_key"
                await run_in_threadpool(
                    validate_backup_secrets, backup_db, extracted / destination_key.name, destination_key
                )
                activity_paused = True
                await restore_activity.pause()
                await _backup_restore_lock.acquire()
                backup_locked = True
                await run_in_threadpool(
                    files.stage,
                    extracted,
                    _backup_directories(),
                    destination_key,
                )

                with CancelScope(shield=True):
                    services_paused = True
                    await print_scheduler.pause_for_restore()
                    smart_plug_manager.stop_scheduler()
                    notification_service.stop_digest_scheduler()
                    virtual_printer_enabled = virtual_printer_manager.is_enabled
                    if virtual_printer_enabled:
                        await virtual_printer_manager.stop_all()
                    printers_disconnected = True
                    await printer_manager.disconnect_all_async()
                    await database.close_all_connections()

                    if sqlite_target:
                        db_path = Path(app_settings.database_url.removeprefix("sqlite+aiosqlite:///"))
                        previous_db = files.workspace(db_path.parent) / "previous.db"
                        await run_in_threadpool(copy_sqlite_database, db_path, previous_db)

                    await run_in_threadpool(files.install)
                    encryption._fernet_instance = None
                    encryption._key_source = None
                    encryption._warn_shown = False

                    if sqlite_target:
                        sqlite_replaced = True
                        await run_in_threadpool(copy_sqlite_database, backup_db, db_path)
                        await database.init_db()
                    else:
                        await _import_sqlite_to_postgres(backup_db)
                    committed = True

            message = "Backup restored successfully."
            with CancelScope(shield=True):
                restore_activity.resume()
                activity_paused = False
                print_scheduler.resume_after_restore()
                try:
                    async with database.async_session() as db:
                        await init_printer_connections(db)
                    await virtual_printer_manager.sync_from_db()
                    if _resume_background_services() is False:
                        message = "Backup restored successfully. Restart LayerCove to finish restarting services."
                except Exception as error:
                    logger.error("Could not restart services after restore (%s)", type(error).__name__)
                    message = "Backup restored successfully. Restart LayerCove to finish restarting services."
            return {"success": True, "message": message}
        except BaseException as error:
            if committed:
                raise
            with CancelScope(shield=True):
                if sqlite_replaced:
                    try:
                        await database.close_all_connections()
                        await run_in_threadpool(copy_sqlite_database, previous_db, db_path)
                    except Exception:
                        needs_recovery = True
                        logger.exception("Could not restore the previous SQLite database at %s", previous_db)
                try:
                    await run_in_threadpool(files.rollback)
                except Exception:
                    needs_recovery = True
                    logger.exception("Could not roll back restore files. Recovery directories: %s", files.workspaces)
                encryption._fernet_instance, encryption._key_source, encryption._warn_shown = encryption_state

                if services_paused and not needs_recovery:
                    restore_activity.resume()
                    activity_paused = False
                    print_scheduler.resume_after_restore()
                    try:
                        if printers_disconnected:
                            async with database.async_session() as db:
                                await init_printer_connections(db)
                        if virtual_printer_enabled:
                            await virtual_printer_manager.sync_from_db()
                    except Exception as service_error:
                        logger.error(
                            "Could not restart printer services after restore (%s)", type(service_error).__name__
                        )
                    _resume_background_services()

            if not isinstance(error, Exception) or isinstance(error, HTTPException) and not needs_recovery:
                raise
            driver_error = getattr(error, "orig", None)
            logger.error(
                "Restore failed (%s, SQLSTATE %s)",
                type(error).__name__,
                getattr(driver_error, "sqlstate", None) or "unavailable",
            )
            message = (
                "Restore failed and automatic recovery was incomplete. Recovery files were retained. Check server logs."
                if needs_recovery
                else "Restore failed. The previous data was kept. Check server logs for details."
            )
            return JSONResponse(status_code=500, content={"success": False, "message": message})
        finally:
            if backup_locked:
                _backup_restore_lock.release()
            if not needs_recovery:
                with CancelScope(shield=True):
                    try:
                        await run_in_threadpool(files.clean_up)
                    finally:
                        if activity_paused:
                            restore_activity.resume()


@router.get("/network-interfaces")
async def get_network_interfaces(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
):
    """Get available network interfaces with all IPs (primary + aliases)."""
    from backend.app.services.network_utils import get_all_interface_ips

    interfaces = get_all_interface_ips()
    return {"interfaces": interfaces}


@router.get("/virtual-printer/models")
async def get_virtual_printer_models(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
):
    """Get available virtual printer models."""
    from backend.app.services.virtual_printer import (
        DEFAULT_VIRTUAL_PRINTER_MODEL,
        VIRTUAL_PRINTER_MODELS,
    )

    return {
        "models": VIRTUAL_PRINTER_MODELS,
        "default": DEFAULT_VIRTUAL_PRINTER_MODEL,
    }


@router.get("/virtual-printer")
async def get_virtual_printer_settings(
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
):
    """Get virtual printer settings and status."""
    from backend.app.services.virtual_printer import (
        DEFAULT_VIRTUAL_PRINTER_MODEL,
        virtual_printer_manager,
    )

    enabled = await get_setting(db, "virtual_printer_enabled")
    access_code = await get_setting(db, "virtual_printer_access_code")
    mode = await get_setting(db, "virtual_printer_mode")
    model = await get_setting(db, "virtual_printer_model")
    target_printer_id = await get_setting(db, "virtual_printer_target_printer_id")
    remote_interface_ip = await get_setting(db, "virtual_printer_remote_interface_ip")
    tailscale_disabled_raw = await get_setting(db, "virtual_printer_tailscale_disabled")
    archive_name_source = await get_setting(db, "virtual_printer_archive_name_source")

    from backend.app.models.virtual_printer import VP_MODE_ARCHIVE, normalize_vp_mode

    return {
        "enabled": enabled == "true" if enabled else False,
        "access_code_set": bool(access_code),
        # Normalize on read so older settings rows (with `immediate` /
        # `print_queue`) come out as `archive` / `queue` for the frontend.
        "mode": normalize_vp_mode(mode) or VP_MODE_ARCHIVE,
        "model": model or DEFAULT_VIRTUAL_PRINTER_MODEL,
        "target_printer_id": int(target_printer_id) if target_printer_id else None,
        "remote_interface_ip": remote_interface_ip or "",
        "tailscale_disabled": tailscale_disabled_raw == "true" if tailscale_disabled_raw else True,
        "archive_name_source": archive_name_source if archive_name_source in ("metadata", "filename") else "metadata",
        "status": virtual_printer_manager.get_status(),
    }


@router.put("/virtual-printer")
async def update_virtual_printer_settings(
    enabled: bool = None,
    access_code: str = None,
    mode: str = None,
    model: str = None,
    target_printer_id: int = None,
    remote_interface_ip: str = None,
    tailscale_disabled: bool = None,
    archive_name_source: str = None,
    db: AsyncSession = Depends(get_db),
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_UPDATE),
):
    """Update virtual printer settings and restart services if needed.

    For proxy mode with SSDP proxy (dual-homed setup):
    - remote_interface_ip: IP of interface on slicer's network (LAN B)
    - Local interface is auto-detected based on target printer IP
    """
    from sqlalchemy import select

    from backend.app.models.printer import Printer
    from backend.app.services.virtual_printer import (
        DEFAULT_VIRTUAL_PRINTER_MODEL,
        VIRTUAL_PRINTER_MODELS,
        virtual_printer_manager,
    )

    # Get current values
    current_enabled = await get_setting(db, "virtual_printer_enabled") == "true"
    current_access_code = await get_setting(db, "virtual_printer_access_code") or ""
    # Default to `archive` (the canonical name) but tolerate legacy `immediate`
    # in the stored value — normalized later before validation.
    current_mode = await get_setting(db, "virtual_printer_mode") or "archive"
    current_model = await get_setting(db, "virtual_printer_model") or DEFAULT_VIRTUAL_PRINTER_MODEL
    current_target_id_str = await get_setting(db, "virtual_printer_target_printer_id")
    current_target_id = int(current_target_id_str) if current_target_id_str else None
    current_remote_iface = await get_setting(db, "virtual_printer_remote_interface_ip") or ""
    current_ts_disabled_raw = await get_setting(db, "virtual_printer_tailscale_disabled")
    # Default True (opt-in) when the setting has never been saved — matches the model default.
    current_ts_disabled = current_ts_disabled_raw == "true" if current_ts_disabled_raw else True

    # Apply updates
    new_enabled = enabled if enabled is not None else current_enabled
    new_access_code = access_code if access_code is not None else current_access_code
    new_mode = mode if mode is not None else current_mode
    new_model = model if model is not None else current_model
    new_target_id = target_printer_id if target_printer_id is not None else current_target_id
    new_remote_iface = remote_interface_ip if remote_interface_ip is not None else current_remote_iface
    new_ts_disabled = tailscale_disabled if tailscale_disabled is not None else current_ts_disabled

    # Validate mode. Canonical wire values are `archive` / `review` / `queue`
    # / `proxy`; legacy `immediate` and `print_queue` are accepted as aliases
    # and translated before storage so support bundles stop showing the old
    # confusing pair (#1429 mode-label discrepancy).
    from backend.app.models.virtual_printer import VP_MODE_VALUES, normalize_vp_mode

    canonical_mode = normalize_vp_mode(new_mode)
    if canonical_mode not in VP_MODE_VALUES:
        return JSONResponse(
            status_code=400,
            content={
                "detail": f"Mode must be one of: {', '.join(VP_MODE_VALUES)}",
            },
        )
    new_mode = canonical_mode

    # Validate archive_name_source
    if archive_name_source is not None and archive_name_source not in ("metadata", "filename"):
        return JSONResponse(
            status_code=400,
            content={"detail": "archive_name_source must be 'metadata' or 'filename'"},
        )

    # Validate model
    if model is not None and model not in VIRTUAL_PRINTER_MODELS:
        return JSONResponse(
            status_code=400,
            content={"detail": f"Invalid model. Must be one of: {', '.join(VIRTUAL_PRINTER_MODELS.keys())}"},
        )

    # Mode-specific validation and printer lookup
    target_printer_ip = ""
    target_printer_serial = ""
    if new_mode == "proxy":
        # Proxy mode requires target printer when enabling
        if new_enabled and not new_target_id:
            # If just switching to proxy mode (not explicitly enabling), auto-disable
            if enabled is None:
                new_enabled = False
            else:
                return JSONResponse(
                    status_code=400,
                    content={"detail": "Target printer is required for proxy mode"},
                )

        # Look up printer IP and serial if we have a target
        if new_target_id:
            result = await db.execute(select(Printer).where(Printer.id == new_target_id))
            printer = result.scalar_one_or_none()
            if not printer:
                return JSONResponse(
                    status_code=400,
                    content={"detail": f"Printer with ID {new_target_id} not found"},
                )
            target_printer_ip = printer.ip_address
            target_printer_serial = printer.serial_number
        # Access code not required for proxy mode
    else:
        # Non-proxy modes require access code when enabling
        if new_enabled and not new_access_code:
            # If just switching modes (not explicitly enabling), auto-disable
            if enabled is None:
                new_enabled = False
            else:
                return JSONResponse(
                    status_code=400,
                    content={"detail": "Access code is required when enabling virtual printer"},
                )

        # Validate access code length (Bambu Studio requires exactly 8 characters)
        if access_code is not None and access_code and len(access_code) != 8:
            return JSONResponse(
                status_code=400,
                content={"detail": "Access code must be exactly 8 characters"},
            )

    # Save settings
    await set_setting(db, "virtual_printer_enabled", "true" if new_enabled else "false")
    if access_code is not None:
        await set_setting(db, "virtual_printer_access_code", access_code)
    await set_setting(db, "virtual_printer_mode", new_mode)
    if model is not None:
        await set_setting(db, "virtual_printer_model", model)
    if target_printer_id is not None:
        await set_setting(db, "virtual_printer_target_printer_id", str(target_printer_id))
    if remote_interface_ip is not None:
        await set_setting(db, "virtual_printer_remote_interface_ip", remote_interface_ip)
    if tailscale_disabled is not None:
        await set_setting(db, "virtual_printer_tailscale_disabled", "true" if tailscale_disabled else "false")
    if archive_name_source is not None:
        await set_setting(db, "virtual_printer_archive_name_source", archive_name_source)

    # Propagate tailscale_disabled to the first VirtualPrinter row so sync_from_db() picks it up
    if tailscale_disabled is not None:
        from backend.app.models.virtual_printer import VirtualPrinter as VPModel

        vp_result = await db.execute(select(VPModel).order_by(VPModel.position).limit(1))
        first_vp = vp_result.scalar_one_or_none()
        if first_vp is not None:
            first_vp.tailscale_disabled = new_ts_disabled

    await db.commit()
    db.expire_all()

    # Reconfigure virtual printer
    try:
        await virtual_printer_manager.configure(
            enabled=new_enabled,
            access_code=new_access_code,
            mode=new_mode,
            model=new_model,
            target_printer_ip=target_printer_ip,
            target_printer_serial=target_printer_serial,
            remote_interface_ip=new_remote_iface,
        )
    except ValueError as e:
        logger.warning("Virtual printer configuration validation error: %s", e)
        return JSONResponse(
            status_code=400,
            content={"detail": "Invalid virtual printer configuration. Check the provided values."},
        )
    except Exception as e:
        logger.error("Failed to configure virtual printer: %s", e, exc_info=True)
        return JSONResponse(
            status_code=500,
            content={"detail": "Failed to configure virtual printer. Check server logs for details."},
        )

    return await get_virtual_printer_settings(db)


# =============================================================================
# MQTT Relay Settings
# =============================================================================


@router.get("/mqtt/status")
async def get_mqtt_status(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.SETTINGS_READ),
):
    """Get MQTT relay connection status."""
    from backend.app.services.mqtt_relay import mqtt_relay

    return mqtt_relay.get_status()
