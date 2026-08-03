import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import DateTime, event
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.types import NullType

from backend.app.core.config import settings
from backend.app.core.db_dialect import is_sqlite

logger = logging.getLogger(__name__)


def _set_sqlite_pragmas(dbapi_conn, connection_record):
    """Set SQLite pragmas on each new connection for concurrency and performance."""
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys = ON")
    # WAL mode allows concurrent readers + one writer (vs default DELETE mode which locks entirely)
    cursor.execute("PRAGMA journal_mode = WAL")
    # Wait up to 15 seconds when the database is locked instead of failing immediately
    cursor.execute("PRAGMA busy_timeout = 15000")
    cursor.execute("PRAGMA synchronous = NORMAL")
    cursor.close()


def _normalize_postgres_datetime_params(parameters, context, executemany):
    compiled = getattr(context, "compiled", None)
    if parameters is None or compiled is None:
        return parameters

    binds = getattr(compiled, "binds", {})
    positiontup = getattr(compiled, "positiontup", None)

    def naive_utc(value):
        if isinstance(value, datetime) and value.tzinfo is not None:
            return value.astimezone(timezone.utc).replace(tzinfo=None)
        if isinstance(value, dict):
            return {name: naive_utc(item) for name, item in value.items()}
        if isinstance(value, tuple):
            return tuple(naive_utc(item) for item in value)
        if isinstance(value, list):
            return [naive_utc(item) for item in value]
        return value

    def normalize(value, bind_name):
        bind = binds.get(bind_name)
        if bind is not None and isinstance(bind.type, DateTime) and bind.type.timezone:
            return value
        # Untyped text() binds retain legacy naive-UTC handling. Callers targeting
        # TIMESTAMPTZ must bind DateTime(timezone=True) so their instant is preserved.
        if bind is None or isinstance(bind.type, (DateTime, NullType)):
            return naive_utc(value)
        return value

    def normalize_row(row):
        if isinstance(row, dict):
            return {name: normalize(value, name) for name, value in row.items()}
        if isinstance(row, tuple) and positiontup:
            return tuple(
                normalize(value, positiontup[index]) if index < len(positiontup) else value
                for index, value in enumerate(row)
            )
        if isinstance(row, list) and positiontup:
            return [
                normalize(value, positiontup[index]) if index < len(positiontup) else value
                for index, value in enumerate(row)
            ]
        return row

    if isinstance(parameters, list) and (
        executemany or (parameters and all(isinstance(row, (dict, tuple)) for row in parameters))
    ):
        return [normalize_row(row) for row in parameters]
    return normalize_row(parameters)


def _create_engine():
    """Create the async engine with dialect-appropriate settings."""
    if is_sqlite():
        kwargs = {} if ":memory:" in settings.database_url else {"pool_size": 20, "max_overflow": 200}
    else:
        kwargs = {
            "pool_size": settings.db_pool_size,
            "max_overflow": settings.db_max_overflow,
            "pool_timeout": settings.db_pool_timeout,
        }
    eng = create_async_engine(
        settings.database_url,
        echo=settings.debug,
        **kwargs,
    )
    if is_sqlite():
        event.listen(eng.sync_engine, "connect", _set_sqlite_pragmas)
    else:

        @event.listens_for(eng.sync_engine, "before_cursor_execute", retval=True)
        def _normalize_datetime_params(conn, cursor, statement, parameters, context, executemany):
            return statement, _normalize_postgres_datetime_params(parameters, context, executemany)

    return eng


engine = _create_engine()

async_session = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def run_with_retry(fn, *, max_attempts: int = 3, label: str = ""):
    """Run an async DB operation with retry for SQLite 'database is locked' errors.

    ``fn`` is an async callable that receives an ``AsyncSession`` and performs
    the full query-mutate-commit cycle.  On each retry a fresh session is used
    so there are no stale-object / expired-attribute issues after rollback.

    On PostgreSQL this calls ``fn`` once with no retry (Postgres uses row-level
    locking and doesn't suffer from single-writer contention).
    """
    if not is_sqlite():
        async with async_session() as db:
            return await fn(db)

    last_exc: OperationalError | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            async with async_session() as db:
                return await fn(db)
        except OperationalError as exc:
            last_exc = exc
            if "database is locked" not in str(exc) or attempt == max_attempts:
                raise
            delay = 0.5 * attempt  # 0.5s, 1.0s
            logger.warning(
                "SQLite locked%s (attempt %d/%d), retrying in %.1fs: %s",
                f" ({label})" if label else "",
                attempt,
                max_attempts,
                delay,
                exc,
            )
            await asyncio.sleep(delay)
    raise last_exc  # unreachable, but keeps type checkers happy


async def close_all_connections():
    """Close all database connections for backup/restore operations."""
    global engine
    await engine.dispose()


async def reinitialize_database():
    """Reinitialize database connection after restore."""
    global engine, async_session
    engine = _create_engine()
    async_session = async_sessionmaker(
        engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            # Catch BaseException (not just Exception) so CancelledError —
            # raised when Starlette's BaseHTTPMiddleware cancels the inner
            # task scope on client disconnect — also triggers rollback.
            # `asyncio.shield` keeps the rollback running to completion
            # even when the await itself gets cancelled, so the SQLite
            # write lock is released promptly instead of being held until
            # the connection is GC'd ages later (which was producing the
            # "database is locked" cascade in #1112's support package).
            try:
                await asyncio.shield(session.rollback())
            except BaseException:  # noqa: BLE001 — rollback failure must not mask the original
                pass
            raise
        finally:
            try:
                await asyncio.shield(session.close())
            except BaseException:  # noqa: BLE001 — close failure must not mask the original
                pass


async def init_db():
    # Import models to register them with SQLAlchemy
    from backend.app.models import (  # noqa: F401
        active_print_spoolman,
        ams_history,
        ams_label,
        api_key,
        archive,
        auth_ephemeral,
        bug_report,
        color_catalog,
        external_link,
        filament,
        filament_sku_settings,
        github_backup,
        group,
        kprofile_note,
        library,
        local_preset,
        location,
        long_lived_token,
        maintenance,
        moonraker_printer_config,
        network_site,
        notification,
        notification_template,
        oidc_provider,
        orca_base_cache,
        pending_upload,
        pipeline_run,
        print_batch,
        print_log,
        print_queue,
        printer,
        printer_camera,
        printer_sensor_history,
        project,
        project_bom,
        settings,
        shopping_list,
        slicer_pipeline,
        slot_preset,
        smart_plug,
        smart_plug_energy_snapshot,
        sponsor_toast_state,
        spool,
        spool_assignment,
        spool_catalog,
        spool_k_profile,
        spool_usage_history,
        spoolbuddy_device,
        spoolman_k_profile,
        spoolman_slot_assignment,
        user,
        user_email_pref,
        user_otp_code,
        user_totp,
        virtual_printer,
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # Run migrations for new columns (SQLite doesn't auto-add columns)
        await run_migrations(conn)

    # Re-encrypt any legacy plaintext OIDC client_secret / TOTP secret rows
    # that exist from before the encryption key was configured.
    # Runs on a fresh AsyncSession (NOT the run_migrations() connection) so it
    # doesn't share a transaction with the schema-DDL block above — required to
    # avoid SQLite "database is locked" contention on the WAL writer.
    await _migrate_encrypt_legacy_secrets()

    # Seed default notification templates
    await seed_notification_templates()

    # Seed default groups and migrate existing users
    await seed_default_groups()

    # Seed default catalog entries
    await seed_spool_catalog()
    await seed_color_catalog()


# B2: Module-level counter exposing the number of rows skipped during the last
# _migrate_encrypt_legacy_secrets() invocation. Surfaced via /encryption-status
# (migration_error_count) so operators can spot poison rows that need attention.
_migration_error_count: int = 0


def get_migration_error_count() -> int:
    """Return the number of rows that failed to re-encrypt during the last
    _migrate_encrypt_legacy_secrets() run."""
    return _migration_error_count


async def _migrate_encrypt_legacy_secrets() -> None:
    """Re-encrypt OIDC ``client_secret`` and TOTP ``secret`` rows that are still
    stored as plaintext (no ``fernet:`` prefix).

    Called from :func:`init_db` after :func:`run_migrations` finishes. No-ops
    when no encryption key is configured (so plaintext storage stays the
    legacy behaviour for installs without a key).

    B2: per-row strategy — each row is committed in its own AsyncSession so a
    single corrupt row does NOT block other successful re-encryptions on every
    startup forever. The skipped-row count is exposed via
    :func:`get_migration_error_count` and surfaced on /encryption-status.

    B3: unexpected (non-row) failures during the read phase are re-raised so
    operators see the problem instead of silent data corruption — startup
    fails loudly rather than running with half-migrated rows.

    Idempotent: rows that already start with ``fernet:`` are skipped, and the
    write-phase re-checks the prefix before encrypting (guards against double
    encryption from concurrent workers).
    """
    from sqlalchemy import not_, select

    from backend.app.core.encryption import is_encryption_active
    from backend.app.models.oidc_provider import OIDCProvider
    from backend.app.models.user_totp import UserTOTP

    global _migration_error_count

    if not is_encryption_active():
        # Reset stale counter from a previous active-key run — we no longer
        # have any rows to migrate, so the count must not leak across runs.
        _migration_error_count = 0
        return

    # Phase 1 (read): collect (id, stored_value) tuples for plaintext rows.
    # Read phase failures are startup-fatal — re-raise (B3).
    try:
        async with async_session() as ro:
            oidc_rows = await ro.execute(
                select(OIDCProvider.id, OIDCProvider._client_secret_enc).where(
                    not_(OIDCProvider._client_secret_enc.like("fernet:%"))
                )
            )
            oidc_candidates = [(r[0], r[1]) for r in oidc_rows.all()]
            totp_rows = await ro.execute(
                select(UserTOTP.id, UserTOTP._secret_enc).where(not_(UserTOTP._secret_enc.like("fernet:%")))
            )
            totp_candidates = [(r[0], r[1]) for r in totp_rows.all()]
    except Exception:
        logger.error("_migrate_encrypt_legacy_secrets: phase 1 read failed", exc_info=True)
        raise  # B3

    oidc_count = totp_count = error_count = 0

    # Phase 2 (write): each row in its own AsyncSession + transaction.
    # Failure of one row does NOT block the others.
    for oidc_id, stored in oidc_candidates:
        if not stored:
            continue  # defensive: skip empty strings
        try:
            async with async_session() as wr:
                provider = await wr.get(OIDCProvider, oidc_id)
                if provider is None:
                    continue  # row deleted between phase 1 and phase 2
                # Idempotent guard: re-check inside the write session in case a
                # concurrent worker beat us to it.
                if not provider._client_secret_enc.startswith("fernet:"):
                    provider.client_secret = stored  # setter -> mfa_encrypt
                    await wr.commit()
                    oidc_count += 1
        except Exception:
            logger.error(
                "Failed to re-encrypt OIDCProvider id=%s — skipping",
                oidc_id,
                exc_info=True,
            )
            error_count += 1

    for totp_id, stored in totp_candidates:
        if not stored:
            continue
        try:
            async with async_session() as wr:
                totp = await wr.get(UserTOTP, totp_id)
                if totp is None:
                    continue
                if not totp._secret_enc.startswith("fernet:"):
                    totp.secret = stored
                    await wr.commit()
                    totp_count += 1
        except Exception:
            logger.error(
                "Failed to re-encrypt UserTOTP id=%s — skipping",
                totp_id,
                exc_info=True,
            )
            error_count += 1

    _migration_error_count = error_count
    if oidc_count or totp_count:
        logger.info(
            "Re-encrypted legacy plaintext secrets: %d OIDC client_secret(s), %d TOTP secret(s)",
            oidc_count,
            totp_count,
        )
    elif error_count == 0:
        logger.debug("_migrate_encrypt_legacy_secrets: no rows needed re-encryption")
    if error_count:
        logger.error(
            "_migrate_encrypt_legacy_secrets: %d row(s) skipped due to errors. "
            "See /api/v1/auth/encryption-status (migration_error_count).",
            error_count,
        )


async def run_migrations(conn):
    """Apply current runtime invariants absent from ORM metadata.

    LayerCove starts only from its current schema. Historical schema upgrades
    are intentionally unsupported; ``Base.metadata.create_all`` owns tables,
    columns, constraints, and modeled indexes.
    """
    from sqlalchemy import text

    if is_sqlite():
        await conn.execute(
            text(
                "CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5("
                "print_name, filename, tags, notes, designer, filament_type, "
                "content='print_archives', content_rowid='id')"
            )
        )
        for name, event, body in (
            (
                "archive_fts_insert",
                "INSERT",
                "INSERT INTO archive_fts(rowid, print_name, filename, tags, notes, designer, filament_type) VALUES (new.id, new.print_name, new.filename, new.tags, new.notes, new.designer, new.filament_type);",
            ),
            (
                "archive_fts_delete",
                "DELETE",
                "INSERT INTO archive_fts(archive_fts, rowid, print_name, filename, tags, notes, designer, filament_type) VALUES ('delete', old.id, old.print_name, old.filename, old.tags, old.notes, old.designer, old.filament_type);",
            ),
            (
                "archive_fts_update",
                "UPDATE",
                "INSERT INTO archive_fts(archive_fts, rowid, print_name, filename, tags, notes, designer, filament_type) VALUES ('delete', old.id, old.print_name, old.filename, old.tags, old.notes, old.designer, old.filament_type); INSERT INTO archive_fts(rowid, print_name, filename, tags, notes, designer, filament_type) VALUES (new.id, new.print_name, new.filename, new.tags, new.notes, new.designer, new.filament_type);",
            ),
        ):
            await conn.execute(
                text(f"CREATE TRIGGER IF NOT EXISTS {name} AFTER {event} ON print_archives BEGIN {body} END")
            )

    async with conn.begin_nested():
        for table in ("user_oidc_links", "user_totp", "user_otp_codes", "long_lived_tokens"):
            await conn.execute(text(f"DELETE FROM {table} WHERE user_id NOT IN (SELECT id FROM users)"))

        await conn.execute(
            text(
                "UPDATE print_queue "
                "SET status = 'pending', error_message = NULL, completed_at = NULL "
                "WHERE status = 'skipped' "
                "  AND error_message = 'Previous print failed or was aborted' "
                "  AND completed_at IS NOT NULL "
                "  AND ("
                "    SELECT prev.status FROM print_queue prev "
                "    WHERE prev.printer_id = print_queue.printer_id "
                "      AND prev.id != print_queue.id "
                "      AND prev.status IN ('completed', 'failed', 'cancelled', 'aborted') "
                "      AND prev.completed_at IS NOT NULL "
                "      AND prev.completed_at < print_queue.completed_at "
                "    ORDER BY prev.completed_at DESC LIMIT 1"
                "  ) = 'cancelled'"
            )
        )

        await conn.execute(
            text(
                "UPDATE print_log_entries "
                "SET archive_id = ("
                "  SELECT a.id FROM print_archives a "
                "  WHERE a.print_name = print_log_entries.print_name "
                "    AND (a.printer_id = print_log_entries.printer_id "
                "      OR (a.printer_id IS NULL AND print_log_entries.printer_id IS NULL)) "
                "  ORDER BY a.id DESC LIMIT 1"
                ") WHERE archive_id IS NULL AND print_name IS NOT NULL"
            )
        )
        await conn.execute(
            text(
                "UPDATE print_log_entries "
                "SET cost = (SELECT cost FROM print_archives WHERE id = print_log_entries.archive_id), "
                "    energy_kwh = (SELECT energy_kwh FROM print_archives WHERE id = print_log_entries.archive_id), "
                "    energy_cost = (SELECT energy_cost FROM print_archives WHERE id = print_log_entries.archive_id) "
                "WHERE id IN ("
                "  SELECT MAX(id) FROM print_log_entries "
                "  WHERE archive_id IS NOT NULL GROUP BY archive_id "
                "  HAVING SUM(CASE WHEN cost IS NOT NULL THEN 1 ELSE 0 END) = 0"
                ")"
            )
        )

        await conn.execute(text("UPDATE print_queue SET status = 'cancelled' WHERE status = 'aborted'"))


async def seed_notification_templates():
    """Seed default notification templates if they don't exist."""
    from sqlalchemy import select

    from backend.app.models.notification_template import DEFAULT_TEMPLATES, NotificationTemplate

    async with async_session() as session:
        # Get existing template event types
        result = await session.execute(select(NotificationTemplate.event_type))
        existing_types = {row[0] for row in result.fetchall()}

        if not existing_types:
            # No templates exist - insert all defaults
            for template_data in DEFAULT_TEMPLATES:
                template = NotificationTemplate(
                    event_type=template_data["event_type"],
                    name=template_data["name"],
                    title_template=template_data["title_template"],
                    body_template=template_data["body_template"],
                    is_default=True,
                )
                session.add(template)
        else:
            # Templates exist - only add missing ones
            for template_data in DEFAULT_TEMPLATES:
                if template_data["event_type"] not in existing_types:
                    template = NotificationTemplate(
                        event_type=template_data["event_type"],
                        name=template_data["name"],
                        title_template=template_data["title_template"],
                        body_template=template_data["body_template"],
                        is_default=True,
                    )
                    session.add(template)

        await session.commit()


async def seed_default_groups():
    """Seed default groups and migrate existing users to appropriate groups.

    Creates the default system groups (Administrators, Operators, Viewers) if they
    don't exist, then migrates existing users:
    - Users with role='admin' -> Administrators group
    - Users with role='user' -> Operators group

    Also migrates old permissions to new ownership-based permissions (Issue #205).
    """
    import logging

    from sqlalchemy import select

    from backend.app.core.permissions import ALL_PERMISSIONS, DEFAULT_GROUPS
    from backend.app.models.group import Group
    from backend.app.models.user import User

    logger = logging.getLogger(__name__)

    # Map old permissions to new ones for migration
    # Administrators get *_all permissions, Operators get *_own permissions.
    #
    # NOTE on the read-flag asymmetry: write permissions (`update`, `delete`,
    # `reprint`) are removed from the legacy flag and remapped to the OWN/ALL
    # split — the legacy flag is dead on the API side. Read permissions are
    # different: the frontend still gates UI actions (download buttons in
    # ArchivesPage, preview button in FileManagerPage) on the LEGACY
    # `archives:read` / `library:read` / `queue:read` strings. For admin we
    # therefore keep the legacy flag (the `*_all` companion gets added via the
    # backfill block below). For non-admin roles the legacy IS renamed to
    # `_own` — that closes the IDOR (operators with a custom `archives:read`
    # row can no longer read cross-user data) and the UI gates degrade to
    # disabled-button state until the frontend is migrated to also accept
    # `_own` (separate change). See maziggy/bambuddy-security #2.
    PERMISSION_MIGRATION_ALL = {
        "queue:update": "queue:update_all",
        "queue:delete": "queue:delete_all",
        "archives:update": "archives:update_all",
        "archives:delete": "archives:delete_all",
        "archives:reprint": "archives:reprint_all",
        "library:update": "library:update_all",
        "library:delete": "library:delete_all",
    }

    PERMISSION_MIGRATION_OWN = {
        "queue:update": "queue:update_own",
        "queue:delete": "queue:delete_own",
        # Read permissions: any role NOT flagged as Administrator gets
        # ownership-scoped reads. Pre-existing custom roles with the legacy
        # `*:read` flag silently saw every user's items; the OWN variant
        # closes that IDOR. Roles that genuinely need cross-user visibility
        # must be re-granted `*:read_all` explicitly by an administrator
        # after upgrade — fail-closed by default (per CWE-636).
        "queue:read": "queue:read_own",
        "archives:update": "archives:update_own",
        "archives:delete": "archives:delete_own",
        "archives:reprint": "archives:reprint_own",
        "archives:read": "archives:read_own",
        "library:update": "library:update_own",
        "library:delete": "library:delete_own",
        "library:read": "library:read_own",
    }

    async with async_session() as session:
        # Get existing groups
        result = await session.execute(select(Group))
        existing_groups = {group.name: group for group in result.scalars().all()}

        # Create default groups if they don't exist
        groups_created = []
        for group_name, group_config in DEFAULT_GROUPS.items():
            if group_name not in existing_groups:
                group = Group(
                    name=group_name,
                    description=group_config["description"],
                    permissions=group_config["permissions"],
                    is_system=group_config["is_system"],
                )
                session.add(group)
                groups_created.append(group_name)
                logger.info("Created default group: %s", group_name)
            else:
                # Migrate existing group's permissions from old to new format
                group = existing_groups[group_name]
                if group.permissions:
                    updated = False
                    new_permissions = list(group.permissions)

                    # Determine which migration map to use based on group
                    migration_map = (
                        PERMISSION_MIGRATION_ALL if group_name == "Administrators" else PERMISSION_MIGRATION_OWN
                    )

                    for old_perm, new_perm in migration_map.items():
                        if old_perm in new_permissions:
                            new_permissions.remove(old_perm)
                            if new_perm not in new_permissions:
                                new_permissions.append(new_perm)
                            updated = True
                            logger.info(
                                "Migrated permission '%s' to '%s' in group '%s'", old_perm, new_perm, group_name
                            )

                    # For Administrators, also ensure they get *_all permissions if they have any new *_own
                    if group_name == "Administrators":
                        for _own_perm, all_perm in [
                            ("queue:update_own", "queue:update_all"),
                            ("queue:delete_own", "queue:delete_all"),
                            ("queue:read_own", "queue:read_all"),
                            ("archives:update_own", "archives:update_all"),
                            ("archives:delete_own", "archives:delete_all"),
                            ("archives:reprint_own", "archives:reprint_all"),
                            ("archives:read_own", "archives:read_all"),
                            ("library:update_own", "library:update_all"),
                            ("library:delete_own", "library:delete_all"),
                            ("library:read_own", "library:read_all"),
                        ]:
                            # Add *_all if not present
                            if all_perm not in new_permissions:
                                new_permissions.append(all_perm)
                                updated = True

                    if updated:
                        group.permissions = new_permissions

        await session.commit()

        # Migrate new permissions: grant printers:clear_plate to all groups with printers:control
        result = await session.execute(select(Group))
        all_groups = result.scalars().all()
        for group in all_groups:
            if (
                group.permissions
                and "printers:control" in group.permissions
                and "printers:clear_plate" not in group.permissions
            ):
                group.permissions = [*group.permissions, "printers:clear_plate"]
                logger.info("Added printers:clear_plate to group '%s' (has printers:control)", group.name)
        await session.commit()

        # Migrate new permissions for MakerWorld integration: groups that
        # already have library:upload (i.e. can write to the library) are
        # the correct audience for makerworld:view + makerworld:import, and
        # groups that only have library:read get makerworld:view (browse
        # only). Matches the intent of DEFAULT_GROUPS without clobbering
        # any user-customised permission lists.
        result = await session.execute(select(Group))
        for group in result.scalars().all():
            if not group.permissions:
                continue
            perms = list(group.permissions)
            changed = False
            if "library:upload" in perms:
                for new_perm in ("makerworld:view", "makerworld:import"):
                    if new_perm not in perms:
                        perms.append(new_perm)
                        changed = True
                        logger.info("Added %s to group '%s' (has library:upload)", new_perm, group.name)
            elif "library:read" in perms and "makerworld:view" not in perms:
                perms.append("makerworld:view")
                changed = True
                logger.info("Added makerworld:view to group '%s' (has library:read)", group.name)
            if changed:
                group.permissions = perms
        await session.commit()

        # Backfill: sync the Administrators system group to ALL_PERMISSIONS.
        # Administrators' contract is full access to every feature — fresh
        # installs get that via DEFAULT_GROUPS["Administrators"]["permissions"]
        # = ALL_PERMISSIONS. Upgrading installs would otherwise stay frozen at
        # whatever permission set existed when they were first seeded, so a
        # newly-added Permission enum member silently leaves admins gated out
        # of the feature it controls.
        #
        # Generalises the previous one-off admin backfills (library:purge,
        # archives:purge, the OWN/ALL read-flag set + legacy read flags,
        # orca_cloud:auth, printer_sensor_history:read, …): every current
        # Permission enum value is appended to the admin group if missing.
        # Additive only — never removes a permission an operator added by
        # hand. Run AFTER the legacy-rename migration above so the renamed
        # OWN/ALL variants land in the group before the sync sees them.
        result = await session.execute(select(Group).where(Group.name == "Administrators"))
        admin_group = result.scalar_one_or_none()
        if admin_group and admin_group.permissions is not None:
            perms = list(admin_group.permissions)
            added = False
            for new_perm in ALL_PERMISSIONS:
                if new_perm not in perms:
                    perms.append(new_perm)
                    added = True
                    logger.info("Added %s to Administrators group (ALL_PERMISSIONS sync)", new_perm)
            if added:
                admin_group.permissions = perms
        await session.commit()

        # Same OWN-tier backfill for non-admin system groups. Operators and
        # Viewers are seeded with _own on fresh installs (see DEFAULT_GROUPS),
        # but the legacy-rename migration above won't run on a role that
        # didn't carry the legacy `archives:read` flag. Without this block,
        # an existing Operators row whose permissions list lacks the legacy
        # flag would never get archives:read_own and operators would lose
        # read access after upgrade. Re-check by group name so customised
        # rows still get the correct OWN tier on next startup.
        #
        # Operators also get orca_cloud:auth backfilled — fresh installs now
        # include it in the DEFAULT_GROUPS bootstrap, so this keeps upgrades
        # consistent. Viewers do NOT get orca_cloud:auth (read-only role,
        # not expected to author slicer presets / sync to Orca Cloud).
        for non_admin_group_name in ("Operators", "Viewers"):
            grp = (await session.execute(select(Group).where(Group.name == non_admin_group_name))).scalar_one_or_none()
            if grp is None or grp.permissions is None:
                continue
            perms = list(grp.permissions)
            changed = False
            for own_perm in ("archives:read_own", "library:read_own", "queue:read_own"):
                if own_perm not in perms:
                    perms.append(own_perm)
                    changed = True
                    logger.info("Added %s to %s group (backfill)", own_perm, non_admin_group_name)
            if non_admin_group_name == "Operators" and "orca_cloud:auth" not in perms:
                perms.append("orca_cloud:auth")
                changed = True
                logger.info("Added orca_cloud:auth to Operators group (backfill)")
            if changed:
                grp.permissions = perms
        await session.commit()

        # Backfill inventory forecast permissions for existing groups.
        # inventory:forecast_read was added after initial seeding, so groups
        # that already have inventory:read (or inventory:update) need it added.
        # inventory:forecast_write goes to any group with inventory:update.
        result = await session.execute(select(Group))
        for group in result.scalars().all():
            if not group.permissions:
                continue
            perms = list(group.permissions)
            changed = False
            if "inventory:read" in perms and "inventory:forecast_read" not in perms:
                perms.append("inventory:forecast_read")
                changed = True
                logger.info("Added inventory:forecast_read to group '%s' (backfill)", group.name)
            if "inventory:update" in perms and "inventory:forecast_write" not in perms:
                perms.append("inventory:forecast_write")
                changed = True
                logger.info("Added inventory:forecast_write to group '%s' (backfill)", group.name)
            if changed:
                group.permissions = perms
        await session.commit()

        # Backfill pipeline permissions (#1425) for non-admin groups.
        # Administrators is handled by the ALL_PERMISSIONS sync above.
        #   - Operators: all three (matches fresh-install DEFAULT_GROUPS)
        #   - Any other group with library:read_own or settings:read:
        #     pipelines:read only
        result = await session.execute(select(Group))
        for group in result.scalars().all():
            if not group.permissions or group.name == "Administrators":
                continue
            perms = list(group.permissions)
            changed = False
            if group.name == "Operators":
                for new_perm in ("pipelines:read", "pipelines:write", "pipelines:run"):
                    if new_perm not in perms:
                        perms.append(new_perm)
                        changed = True
                        logger.info("Added %s to Operators group (backfill)", new_perm)
            elif "pipelines:read" not in perms and ("library:read_own" in perms or "settings:read" in perms):
                perms.append("pipelines:read")
                changed = True
                logger.info("Added pipelines:read to group '%s' (backfill)", group.name)
            if changed:
                group.permissions = perms
        await session.commit()

        # Migrate existing users to groups if they're not already in any group
        if groups_created:
            # Refresh to get newly created groups
            admin_result = await session.execute(select(Group).where(Group.name == "Administrators"))
            admin_group = admin_result.scalar_one_or_none()

            operators_result = await session.execute(select(Group).where(Group.name == "Operators"))
            operators_group = operators_result.scalar_one_or_none()

            # Get all users
            users_result = await session.execute(select(User))
            users = users_result.scalars().all()

            for user in users:
                # Skip if user already has groups
                if user.groups:
                    continue

                if user.role == "admin" and admin_group:
                    user.groups.append(admin_group)
                    logger.info("Migrated admin user '%s' to Administrators group", user.username)
                elif operators_group:
                    user.groups.append(operators_group)
                    logger.info("Migrated user '%s' to Operators group", user.username)

            await session.commit()


async def seed_spool_catalog():
    """Seed the spool catalog with default entries if empty."""
    import logging

    from sqlalchemy import func, select

    from backend.app.core.catalog_defaults import DEFAULT_SPOOL_CATALOG
    from backend.app.models.spool_catalog import SpoolCatalogEntry

    logger = logging.getLogger(__name__)

    async with async_session() as session:
        result = await session.execute(select(func.count()).select_from(SpoolCatalogEntry))
        count = result.scalar() or 0
        if count > 0:
            return  # Already seeded

        for name, weight in DEFAULT_SPOOL_CATALOG:
            session.add(SpoolCatalogEntry(name=name, weight=weight, is_default=True))
        await session.commit()
        logger.info("Seeded %d default spool catalog entries", len(DEFAULT_SPOOL_CATALOG))


async def seed_color_catalog():
    """Seed the color catalog with default entries if empty."""
    import logging

    from sqlalchemy import func, select

    from backend.app.core.catalog_defaults import DEFAULT_COLOR_CATALOG
    from backend.app.models.color_catalog import ColorCatalogEntry

    logger = logging.getLogger(__name__)

    async with async_session() as session:
        result = await session.execute(select(func.count()).select_from(ColorCatalogEntry))
        count = result.scalar() or 0
        if count > 0:
            return  # Already seeded

        for manufacturer, color_name, hex_color, material in DEFAULT_COLOR_CATALOG:
            session.add(
                ColorCatalogEntry(
                    manufacturer=manufacturer,
                    color_name=color_name,
                    hex_color=hex_color,
                    material=material,
                    is_default=True,
                )
            )
        await session.commit()
        logger.info("Seeded %d default color catalog entries", len(DEFAULT_COLOR_CATALOG))
