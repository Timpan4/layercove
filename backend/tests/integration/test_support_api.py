"""Integration tests for Support API endpoints.

Tests the full request/response cycle for /api/v1/support/ endpoints.
"""

import io
import tempfile
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import AsyncClient


class TestSupportLogsAPI:
    """Integration tests for /api/v1/support/logs endpoints."""

    # ========================================================================
    # GET /api/v1/support/logs
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_logs_empty_file(self, async_client: AsyncClient):
        """Verify get logs returns empty list when log file doesn't exist."""
        with patch("backend.app.services.log_reader.settings") as mock_settings:
            mock_settings.log_dir = Path("/nonexistent/path")

            response = await async_client.get("/api/v1/support/logs")

        assert response.status_code == 200
        result = response.json()
        assert result["entries"] == []
        assert result["total_in_file"] == 0
        assert result["filtered_count"] == 0

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_logs_with_entries(self, async_client: AsyncClient):
        """Verify get logs returns parsed log entries."""
        log_content = """2024-01-15 10:30:45,123 INFO [backend.app.main] Server started
2024-01-15 10:30:46,456 DEBUG [backend.app.services.printer] Connecting to printer
2024-01-15 10:30:47,789 WARNING [backend.app.services.mqtt] Connection timeout
2024-01-15 10:30:48,012 ERROR [backend.app.services.ftp] Failed to download file
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "bambuddy.log"
            log_file.write_text(log_content)

            with patch("backend.app.services.log_reader.settings") as mock_settings:
                mock_settings.log_dir = Path(tmpdir)

                response = await async_client.get("/api/v1/support/logs")

        assert response.status_code == 200
        result = response.json()
        assert len(result["entries"]) == 4
        assert result["total_in_file"] == 4
        assert result["filtered_count"] == 4

        # Entries are in newest-first order
        assert result["entries"][0]["level"] == "ERROR"
        assert result["entries"][1]["level"] == "WARNING"
        assert result["entries"][2]["level"] == "DEBUG"
        assert result["entries"][3]["level"] == "INFO"

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_logs_scrubs_stored_moonraker_secrets(self, async_client: AsyncClient, db_session):
        from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
        from backend.app.models.printer import Printer

        printer = Printer(name="Klipper", provider="moonraker")
        config = MoonrakerPrinterConfig(base_url="http://klipper.local:7125")
        config.api_key = "moonraker-secret"
        printer.moonraker_config = config
        db_session.add(printer)
        await db_session.commit()

        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "bambuddy.log"
            log_file.write_text(
                "2024-01-15 10:30:45,123 INFO [moonraker] "
                f"X-Api-Key: moonraker-secret ciphertext={config.api_key_ciphertext}\n"
            )
            with patch("backend.app.services.log_reader.settings") as mock_settings:
                mock_settings.log_dir = Path(tmpdir)
                response = await async_client.get("/api/v1/support/logs")

        assert response.status_code == 200
        assert "moonraker-secret" not in response.text
        assert config.api_key_ciphertext not in response.text
        assert "[MOONRAKER_API_KEY]" in response.text

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_logs_scrubs_short_moonraker_secrets_only_at_credential_labels(
        self, async_client: AsyncClient, db_session
    ):
        from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
        from backend.app.models.printer import Printer

        api_config = MoonrakerPrinterConfig(base_url="http://api-printer.local:7125")
        api_config.api_key = "x"
        auth_config = MoonrakerPrinterConfig(base_url="http://auth-printer.local:7125")
        auth_config.authorization = "y"
        db_session.add_all(
            [
                Printer(name="API printer", provider="moonraker", moonraker_config=api_config),
                Printer(name="Auth printer", provider="moonraker", moonraker_config=auth_config),
            ]
        )
        await db_session.commit()

        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "bambuddy.log"
            log_file.write_text(
                "2024-01-15 10:30:45,123 INFO [moonraker] control x y; "
                f"X-Api-Key: x; Authorization: y; ciphertext={api_config.api_key_ciphertext}\n"
            )
            with patch("backend.app.services.log_reader.settings") as mock_settings:
                mock_settings.log_dir = Path(tmpdir)
                response = await async_client.get("/api/v1/support/logs")

        assert response.status_code == 200
        assert "control x y" in response.text
        assert "X-Api-Key: x" not in response.text
        assert "Authorization: y" not in response.text
        assert api_config.api_key_ciphertext not in response.text
        assert "[MOONRAKER_API_KEY]" in response.text
        assert "[MOONRAKER_AUTHORIZATION]" in response.text

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_support_bundle_scrubs_short_moonraker_plaintext_and_ciphertext(
        self, async_client: AsyncClient, db_session
    ):
        from backend.app.api.routes import support
        from backend.app.models.moonraker_printer_config import MoonrakerPrinterConfig
        from backend.app.models.printer import Printer

        config = MoonrakerPrinterConfig(base_url="http://klipper.local:7125")
        config.api_key = "x"
        db_session.add(Printer(name="Klipper", provider="moonraker", moonraker_config=config))
        await db_session.commit()

        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "bambuddy.log"
            log_file.write_text(
                f"2024-01-15 10:30:45,123 INFO [moonraker] X-Api-Key: x ciphertext={config.api_key_ciphertext}\n"
            )

            @asynccontextmanager
            async def test_session():
                yield db_session

            with (
                patch.object(support, "async_session", test_session),
                patch.object(support, "_get_debug_setting", return_value=(True, None)),
                patch.object(support, "_collect_support_info", return_value={}),
                patch.object(support.settings, "log_dir", Path(tmpdir)),
                patch.object(support.printer_manager, "get_all_statuses", return_value={}),
            ):
                response = await async_client.get("/api/v1/support/bundle")

        assert response.status_code == 200
        with zipfile.ZipFile(io.BytesIO(response.content)) as bundle:
            bundled_log = bundle.read("bambuddy.log").decode()
        assert "X-Api-Key: x" not in bundled_log
        assert config.api_key_ciphertext not in bundled_log
        assert "[MOONRAKER_API_KEY]" in bundled_log

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_logs_with_level_filter(self, async_client: AsyncClient):
        """Verify get logs filters by log level."""
        log_content = """2024-01-15 10:30:45,123 INFO [backend.app.main] Server started
2024-01-15 10:30:46,456 DEBUG [backend.app.services.printer] Connecting to printer
2024-01-15 10:30:47,789 ERROR [backend.app.services.mqtt] Connection timeout
2024-01-15 10:30:48,012 ERROR [backend.app.services.ftp] Failed to download file
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "bambuddy.log"
            log_file.write_text(log_content)

            with patch("backend.app.services.log_reader.settings") as mock_settings:
                mock_settings.log_dir = Path(tmpdir)

                response = await async_client.get("/api/v1/support/logs?level=ERROR")

        assert response.status_code == 200
        result = response.json()
        assert len(result["entries"]) == 2
        assert result["filtered_count"] == 2
        assert all(e["level"] == "ERROR" for e in result["entries"])

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_logs_with_search_filter(self, async_client: AsyncClient):
        """Verify get logs filters by search query."""
        log_content = """2024-01-15 10:30:45,123 INFO [backend.app.main] Server started
2024-01-15 10:30:46,456 INFO [backend.app.services.printer] Connecting to printer X1C
2024-01-15 10:30:47,789 ERROR [backend.app.services.mqtt] Connection to printer failed
2024-01-15 10:30:48,012 ERROR [backend.app.services.ftp] Failed to download file
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "bambuddy.log"
            log_file.write_text(log_content)

            with patch("backend.app.services.log_reader.settings") as mock_settings:
                mock_settings.log_dir = Path(tmpdir)

                response = await async_client.get("/api/v1/support/logs?search=printer")

        assert response.status_code == 200
        result = response.json()
        assert len(result["entries"]) == 2
        assert result["filtered_count"] == 2

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_logs_with_limit(self, async_client: AsyncClient):
        """Verify get logs respects limit parameter."""
        log_content = """2024-01-15 10:30:45,123 INFO [backend.app.main] Line 1
2024-01-15 10:30:46,456 INFO [backend.app.main] Line 2
2024-01-15 10:30:47,789 INFO [backend.app.main] Line 3
2024-01-15 10:30:48,012 INFO [backend.app.main] Line 4
2024-01-15 10:30:49,345 INFO [backend.app.main] Line 5
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "bambuddy.log"
            log_file.write_text(log_content)

            with patch("backend.app.services.log_reader.settings") as mock_settings:
                mock_settings.log_dir = Path(tmpdir)

                response = await async_client.get("/api/v1/support/logs?limit=2")

        assert response.status_code == 200
        result = response.json()
        assert len(result["entries"]) == 2
        assert result["filtered_count"] == 2
        # Should get the newest entries (Line 5 and Line 4)
        assert "Line 5" in result["entries"][0]["message"]
        assert "Line 4" in result["entries"][1]["message"]

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_get_logs_multiline_entry(self, async_client: AsyncClient):
        """Verify get logs handles multi-line log entries."""
        log_content = """2024-01-15 10:30:45,123 INFO [backend.app.main] Server started
2024-01-15 10:30:46,456 ERROR [backend.app.services.mqtt] Exception occurred
Traceback (most recent call last):
  File "test.py", line 10, in test
    raise ValueError("test error")
ValueError: test error
2024-01-15 10:30:47,789 INFO [backend.app.main] Recovery complete
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "bambuddy.log"
            log_file.write_text(log_content)

            with patch("backend.app.services.log_reader.settings") as mock_settings:
                mock_settings.log_dir = Path(tmpdir)

                response = await async_client.get("/api/v1/support/logs")

        assert response.status_code == 200
        result = response.json()
        assert len(result["entries"]) == 3

        # Find the error entry
        error_entry = next(e for e in result["entries"] if e["level"] == "ERROR")
        assert "Exception occurred" in error_entry["message"]
        assert "Traceback" in error_entry["message"]
        assert "ValueError" in error_entry["message"]

    # ========================================================================
    # DELETE /api/v1/support/logs
    # ========================================================================

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_clear_logs_success(self, async_client: AsyncClient):
        """Verify clear logs truncates the log file."""
        log_content = """2024-01-15 10:30:45,123 INFO [backend.app.main] Server started
2024-01-15 10:30:46,456 DEBUG [backend.app.services.printer] Some debug info
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "bambuddy.log"
            log_file.write_text(log_content)

            with patch("backend.app.api.routes.support.settings") as mock_settings:
                mock_settings.log_dir = Path(tmpdir)

                response = await async_client.delete("/api/v1/support/logs")

                # Verify file was cleared
                assert log_file.read_text() == ""

        assert response.status_code == 200
        result = response.json()
        assert "cleared" in result["message"].lower()

    @pytest.mark.asyncio
    @pytest.mark.integration
    async def test_clear_logs_no_file(self, async_client: AsyncClient):
        """Verify clear logs handles missing log file gracefully."""
        with patch("backend.app.api.routes.support.settings") as mock_settings:
            mock_settings.log_dir = Path("/nonexistent/path")

            response = await async_client.delete("/api/v1/support/logs")

        assert response.status_code == 200
        result = response.json()
        assert "does not exist" in result["message"].lower()


class TestLogParsingHelpers:
    """Tests for log parsing helper functions."""

    def test_parse_log_line_valid(self):
        """Verify _parse_log_line handles valid log lines."""
        from backend.app.services.log_reader import parse_log_line as _parse_log_line

        line = "2024-01-15 10:30:45,123 INFO [backend.app.main] Server started"
        entry = _parse_log_line(line)

        assert entry is not None
        assert entry.timestamp == "2024-01-15 10:30:45,123"
        assert entry.level == "INFO"
        assert entry.logger_name == "backend.app.main"
        assert entry.message == "Server started"

    def test_parse_log_line_invalid(self):
        """Verify _parse_log_line returns None for invalid lines."""
        from backend.app.services.log_reader import parse_log_line as _parse_log_line

        line = "This is not a valid log line"
        entry = _parse_log_line(line)

        assert entry is None

    def test_parse_log_line_with_brackets_in_message(self):
        """Verify _parse_log_line handles messages with brackets."""
        from backend.app.services.log_reader import parse_log_line as _parse_log_line

        line = "2024-01-15 10:30:45,123 INFO [backend.app.main] Processing [item 1] and [item 2]"
        entry = _parse_log_line(line)

        assert entry is not None
        assert entry.message == "Processing [item 1] and [item 2]"

    def test_parse_log_line_all_levels(self):
        """Verify _parse_log_line handles all log levels."""
        from backend.app.services.log_reader import parse_log_line as _parse_log_line

        levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        for level in levels:
            line = f"2024-01-15 10:30:45,123 {level} [test.module] Test message"
            entry = _parse_log_line(line)
            assert entry is not None
            assert entry.level == level
