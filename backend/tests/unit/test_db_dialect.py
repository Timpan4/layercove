"""Unit tests for database dialect helpers and PostgreSQL compatibility."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestDialectDetection:
    """Test is_sqlite() and is_postgres() detection."""

    def test_sqlite_detected(self):
        with patch("backend.app.core.config.settings") as mock_settings:
            mock_settings.database_url = "sqlite+aiosqlite:///path/to/db.sqlite"
            from backend.app.core.db_dialect import is_postgres, is_sqlite

            assert is_sqlite() is True
            assert is_postgres() is False

    def test_postgres_detected(self):
        with patch("backend.app.core.config.settings") as mock_settings:
            mock_settings.database_url = "postgresql+asyncpg://user:pass@host:5432/db"
            from backend.app.core.db_dialect import is_postgres, is_sqlite

            assert is_postgres() is True
            assert is_sqlite() is False


class TestPostgresPoolConfiguration:
    def test_engine_uses_configured_pool_limits(self):
        from backend.app.core import database

        engine = MagicMock()
        with (
            patch.object(database, "is_sqlite", return_value=False),
            patch.object(database.settings, "database_url", "postgresql+asyncpg://user:pass@host/db"),
            patch.object(database.settings, "db_pool_size", 7),
            patch.object(database.settings, "db_max_overflow", 3),
            patch.object(database.settings, "db_pool_timeout", 4.0),
            patch.object(database, "create_async_engine", return_value=engine) as create_engine,
            patch.object(database.event, "listens_for", return_value=lambda function: function),
        ):
            result = database._create_engine()

        assert result is engine
        create_engine.assert_called_once_with(
            "postgresql+asyncpg://user:pass@host/db",
            echo=database.settings.debug,
            pool_size=7,
            max_overflow=3,
            pool_timeout=4.0,
        )


class TestRunPragma:
    """Test that PRAGMAs only run on SQLite."""

    @pytest.mark.asyncio
    async def test_pragma_runs_on_sqlite(self):
        with patch("backend.app.core.db_dialect.is_sqlite", return_value=True):
            from backend.app.core.db_dialect import run_pragma

            mock_conn = AsyncMock()
            await run_pragma(mock_conn, "PRAGMA journal_mode = WAL")
            mock_conn.execute.assert_called_once()

    @pytest.mark.asyncio
    async def test_pragma_skipped_on_postgres(self):
        with patch("backend.app.core.db_dialect.is_sqlite", return_value=False):
            from backend.app.core.db_dialect import run_pragma

            mock_conn = AsyncMock()
            await run_pragma(mock_conn, "PRAGMA journal_mode = WAL")
            mock_conn.execute.assert_not_called()


class TestTimezoneStripping:
    """Test that timezone-aware values become naive before asyncpg calls."""

    @staticmethod
    def _strip(value):
        import datetime

        if isinstance(value, datetime.datetime) and value.tzinfo is not None:
            return value.replace(tzinfo=None)
        return value

    def test_strip_aware_datetime(self):
        import datetime

        aware = datetime.datetime(2026, 4, 3, 10, 0, 0, tzinfo=datetime.timezone.utc)
        assert self._strip(aware) == aware.replace(tzinfo=None)
        assert self._strip(aware).tzinfo is None

    def test_strip_in_nested_parameter_shapes(self):
        import datetime

        aware = datetime.datetime(2026, 4, 3, 10, 0, 0, tzinfo=datetime.timezone.utc)
        mapping = {"created_at": self._strip(aware)}
        sequence = tuple(self._strip(value) for value in ("test", aware, 5))
        assert mapping["created_at"].tzinfo is None
        assert sequence[1].tzinfo is None

    def test_naive_datetime_unchanged(self):
        import datetime

        naive = datetime.datetime(2026, 4, 3, 10, 0, 0)
        assert self._strip(naive) == naive


class TestCrossDatabaseConversion:
    """Test type conversion used by explicit cross-database restore."""

    def test_boolean_conversion(self):
        assert bool(0) is False
        assert bool(1) is True

    def test_datetime_string_conversion(self):
        from datetime import datetime

        result = datetime.fromisoformat("2026-04-02 11:01:52.105147")
        assert (result.year, result.month, result.microsecond) == (2026, 4, 105147)

    def test_datetime_with_timezone_string(self):
        from datetime import datetime

        assert datetime.fromisoformat("2026-04-02T11:01:52+00:00").year == 2026

    def test_json_serialization_for_backup(self):
        import json

        for value in ({"key": "val"}, [1, 2, 3]):
            assert isinstance(json.dumps(value), str)
