import logging
import os
import re as _re
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings

# Application version - single source of truth
APP_VERSION = "0.2.4.9"
GITHUB_REPO = "Timpan4/layercove"
BUG_REPORT_RELAY_URL = os.environ.get("BUG_REPORT_RELAY_URL", "")


def get_compat_env(suffix: str, default: str = "") -> str:
    """Read a LayerCove setting with its inherited Bambuddy fallback."""
    layercove_key = f"LAYERCOVE_{suffix}"
    if layercove_key in os.environ:
        return os.environ[layercove_key]
    return os.environ.get(f"BAMBUDDY_{suffix}", default)


# App directory - where the application is installed (for static files)
_app_dir = Path(__file__).resolve().parent.parent.parent.parent

# Data directory - for persistent data (database, archives)
# Use DATA_DIR env var if set (Docker), otherwise use project root (local dev)
_data_dir_env = os.environ.get("DATA_DIR")
_data_dir = Path(_data_dir_env) if _data_dir_env else _app_dir

# Plate calibration directory - special handling to maintain backwards compatibility
# Docker: DATA_DIR/plate_calibration (e.g., /data/plate_calibration)
# Local dev: project_root/data/plate_calibration (original location)
_plate_cal_dir = Path(_data_dir_env) / "plate_calibration" if _data_dir_env else _app_dir / "data" / "plate_calibration"

# Log directory - use LOG_DIR env var if set, otherwise use app_dir/logs
_log_dir_env = os.environ.get("LOG_DIR")
_log_dir = Path(_log_dir_env) if _log_dir_env else _app_dir / "logs"


# External DATABASE_URL takes priority (PostgreSQL support).
_external_db_url = os.environ.get("DATABASE_URL")

# Fresh LayerCove installs use this SQLite database. Legacy Bambuddy and
# BambuTrack databases are never renamed, overwritten, or opened implicitly.
_db_path = _data_dir / "layercove.db"
_default_db_url = f"sqlite+aiosqlite:///{_db_path}"
if not _external_db_url:
    legacy_databases = [path for path in (_data_dir / "bambutrack.db", _data_dir / "bambuddy.db") if path.exists()]
    if legacy_databases:
        names = ", ".join(str(path) for path in legacy_databases)
        raise RuntimeError(
            f"Legacy database found: {names}. LayerCove will not modify it. "
            "Back up or export it, then configure DATABASE_URL for a new database or remove the legacy file."
        )


class Settings(BaseSettings):
    app_name: str = "LayerCove"
    debug: bool = False  # Default to production mode

    # Paths
    base_dir: Path = _data_dir  # For backwards compatibility
    # `app_dir` is where the source code is checked out. It matches `base_dir`
    # unless DATA_DIR points at persistent container storage.
    app_dir: Path = _app_dir
    archive_dir: Path = _data_dir / "archive"
    plate_calibration_dir: Path = _plate_cal_dir  # Plate detection references
    static_dir: Path = _app_dir / "static"  # Static files are part of app, not data
    log_dir: Path = _log_dir
    database_url: str = _external_db_url or _default_db_url
    db_pool_size: int = Field(default=10, ge=1)
    db_max_overflow: int = Field(default=2, ge=0)
    db_pool_timeout: float = Field(default=5.0, gt=0)

    @field_validator("database_url", mode="before")
    @classmethod
    def default_empty_database_url(cls, value):
        return value or _default_db_url

    # Logging
    log_level: str = "INFO"  # Override with LOG_LEVEL env var or DEBUG=true
    log_to_file: bool = True  # Set to false to disable file logging

    # API
    api_prefix: str = "/api/v1"

    # Slicer API sidecars. Defaults match the docker-compose.yml ports in the
    # orca-slicer-api fork (https://github.com/maziggy/orca-slicer-api):
    #   OrcaSlicer  → port 3003 (default profile)
    #   BambuStudio → port 3001 (built locally via Dockerfile.bambu-studio)
    # The slice route picks which one based on the user's preferred_slicer
    # setting.
    slicer_api_url: str = "http://localhost:3003"
    bambu_studio_api_url: str = "http://localhost:3001"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        # Don't reject unknown env vars — MFA_ENCRYPTION_KEY (#1219) and other
        # operational env vars are read directly by their owning modules and
        # never declared as Settings fields.
        extra = "ignore"


settings = Settings()

# Warn on unknown MFA_*/LAYERCOVE_*/BAMBUDDY_* env vars so typos are not
# silently swallowed by ``extra = "ignore"``. Existing BAMBUDDY_* names remain
# accepted compatibility aliases.
_INTENTIONAL_UNSETTINGS = {
    "MFA_ENCRYPTION_KEY",  # encryption.py reads this directly
    "DATA_DIR",  # paths.py / config.py
    "DATABASE_URL",  # config.py (above)
    "LOG_DIR",  # config.py (above)
    "LOG_LEVEL",  # main.py logging setup
    "BUG_REPORT_RELAY_URL",  # config.py (above)
}

_COMPAT_ENV_SUFFIXES = {
    "EXTERNAL_ROOTS",
    "LOCAL_LOGIN",
    "VP_DUMP_WIRE",
}

_known_settings_fields = {f.upper() for f in settings.model_fields}

for _env_key in os.environ:
    if _re.match(r"^(MFA_|LAYERCOVE_|BAMBUDDY_)", _env_key, _re.IGNORECASE):
        _norm = _env_key.upper()
        _compat_suffix = _norm.removeprefix("LAYERCOVE_").removeprefix("BAMBUDDY_")
        if (
            _norm not in _known_settings_fields
            and _norm not in _INTENTIONAL_UNSETTINGS
            and _compat_suffix not in _COMPAT_ENV_SUFFIXES
        ):
            logging.info(
                "Unknown env var %r — not a declared Settings field. Possible typo? Recognised operational vars: %s",
                _env_key,
                sorted(_INTENTIONAL_UNSETTINGS),
            )

# Ensure directories exist
settings.archive_dir.mkdir(parents=True, exist_ok=True)
settings.plate_calibration_dir.mkdir(parents=True, exist_ok=True)
settings.static_dir.mkdir(exist_ok=True)
if settings.log_to_file:
    settings.log_dir.mkdir(exist_ok=True)
