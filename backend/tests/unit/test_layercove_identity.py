from __future__ import annotations

import importlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from backend.app.core.config import get_compat_env

REPOSITORY_ROOT = Path(os.environ.get("TEST_REPOSITORY_ROOT", Path(__file__).resolve().parents[3]))


@pytest.mark.unit
@pytest.mark.parametrize(
    ("suffix", "legacy_value"),
    [
        ("LOCAL_LOGIN", "true"),
        ("EXTERNAL_ROOTS", "/legacy"),
        ("VP_DUMP_WIRE", "1"),
    ],
)
def test_compat_env_uses_bambuddy_fallback(monkeypatch, suffix, legacy_value):
    monkeypatch.delenv(f"LAYERCOVE_{suffix}", raising=False)
    monkeypatch.setenv(f"BAMBUDDY_{suffix}", legacy_value)

    assert get_compat_env(suffix) == legacy_value


@pytest.mark.unit
@pytest.mark.parametrize("suffix", ["LOCAL_LOGIN", "EXTERNAL_ROOTS", "VP_DUMP_WIRE"])
def test_compat_env_prefers_layercove_even_when_empty(monkeypatch, suffix):
    monkeypatch.setenv(f"BAMBUDDY_{suffix}", "legacy")
    monkeypatch.setenv(f"LAYERCOVE_{suffix}", "")

    assert get_compat_env(suffix) == ""


@pytest.mark.unit
def test_layercove_metadata_is_active_product_identity():
    import backend.app.core.config as config
    from backend.app.main import app

    importlib.reload(config)

    assert config.settings.app_name == "LayerCove"
    assert config.GITHUB_REPO == "Timpan4/layercove"
    assert config.BUG_REPORT_RELAY_URL == ""
    assert app.title == "LayerCove"
    assert "Klipper" in app.description

    root = REPOSITORY_ROOT
    index = (root / "frontend" / "index.html").read_text(encoding="utf-8")
    manifest = json.loads((root / "frontend" / "public" / "manifest.json").read_text(encoding="utf-8"))
    assert "<title>LayerCove</title>" in index
    assert manifest["name"] == manifest["short_name"] == "LayerCove"
    assert all(icon["src"].startswith("/img/") for icon in manifest["icons"])
    assert all((root / "frontend" / "public" / icon["src"].removeprefix("/")).is_file() for icon in manifest["icons"])


@pytest.mark.unit
def test_readme_local_links_and_assets_resolve():
    root = REPOSITORY_ROOT
    readme = (root / "README.md").read_text(encoding="utf-8")
    targets = re.findall(r"(?:\[[^]]*\]\(([^)]+)\)|(?:src|href)=\"([^\"]+)\")", readme)
    local_targets = {
        next(value for value in match if value).split("#", 1)[0]
        for match in targets
        if next(value for value in match if value)
        and not re.match(r"^(?:https?:|mailto:|#)", next(value for value in match if value))
    }

    missing = sorted(target for target in local_targets if not (root / target).exists())
    assert missing == []


@pytest.mark.unit
def test_container_identity_is_layercove():
    import backend.app.core.config as config

    assert config.settings.database_url == "sqlite+aiosqlite:///:memory:"
    assert config.settings.archive_dir.name == "archive"

    root = REPOSITORY_ROOT
    compose = (root / "docker-compose.yml").read_text(encoding="utf-8")
    assert "  layercove:" in compose
    assert "image: ghcr.io/timpan4/layercove:latest" in compose
    assert "container_name: layercove" in compose
    assert "layercove_data:/app/data" in compose
    assert "layercove_logs:/app/logs" in compose


@pytest.mark.unit
def test_fresh_deployment_sources_target_layercove():
    root = REPOSITORY_ROOT
    installers = {
        path: (root / path).read_text(encoding="utf-8")
        for path in (
            "install/docker-install.sh",
            "install/docker-install.ps1",
        )
    }

    for path, content in installers.items():
        assert "Timpan4/layercove" in content, path
        assert "maziggy/bambuddy" not in content, path

    assert 'DEFAULT_INSTALL_PATH="/opt/layercove"' in installers["install/docker-install.sh"]
    assert "Join-Path $env:USERPROFILE 'layercove'" in installers["install/docker-install.ps1"]


@pytest.mark.unit
@pytest.mark.parametrize("legacy_name", ["bambutrack.db", "bambuddy.db"])
def test_legacy_database_refusal_preserves_bytes(tmp_path, legacy_name):
    legacy = tmp_path / legacy_name
    original = b"SQLite format 3\x00legacy-data"
    legacy.write_bytes(original)
    env = os.environ | {"DATA_DIR": str(tmp_path), "DATABASE_URL": "", "LOG_TO_FILE": "false"}

    result = subprocess.run(
        [sys.executable, "-c", "import backend.app.core.config"],
        cwd=REPOSITORY_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "Legacy database found" in result.stderr
    assert legacy.read_bytes() == original
    assert not (tmp_path / "layercove.db").exists()


@pytest.mark.unit
def test_fresh_default_database_is_layercove(tmp_path):
    env = os.environ | {
        "DATA_DIR": str(tmp_path),
        "DATABASE_URL": "",
        "LOG_TO_FILE": "false",
        "STATIC_DIR": str(tmp_path / "static"),
    }

    result = subprocess.run(
        [sys.executable, "-c", "from backend.app.core.config import settings; print(settings.database_url)"],
        cwd=REPOSITORY_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )

    assert result.stdout.strip().endswith("/layercove.db")


@pytest.mark.unit
def test_container_publish_workflow_matches_documented_image():
    root = REPOSITORY_ROOT
    workflow = (root / ".github" / "workflows" / "publish-container.yml").read_text(encoding="utf-8")

    assert "packages: write" in workflow
    assert "id-token: write" in workflow
    assert "attestations: write" in workflow
    assert "ghcr.io/${{ github.repository_owner }}/layercove" in workflow
    assert "linux/amd64,linux/arm64" in workflow
    assert "id: build" in workflow
    assert "sbom: true" in workflow
    assert "provenance: mode=max" in workflow
    assert "uses: actions/attest@v4" in workflow
    assert "subject-name: ${{ steps.meta.outputs.images }}" in workflow
    assert "subject-digest: ${{ steps.build.outputs.digest }}" in workflow
    assert "push-to-registry: true" in workflow
    assert "create-storage-record: false" in workflow


@pytest.mark.unit
def test_production_image_uses_declared_frontend_toolchain():
    root = REPOSITORY_ROOT
    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")

    assert "FROM oven/bun:1.3.14-debian AS frontend-builder" in dockerfile
    assert "COPY frontend/package.json frontend/bun.lock ./" in dockerfile
    assert "RUN bun install --frozen-lockfile" in dockerfile
    assert "RUN bun run build" in dockerfile
    assert "npm ci" not in dockerfile


@pytest.mark.unit
def test_remaining_frontend_bambuddy_strings_are_classified():
    root = REPOSITORY_ROOT
    allowed_fragments = (
        "BAMBUDDY_LOCAL_LOGIN",
        "configureBambuddy:",
        "bambuddySoftware:",
        "bambuddyUrl:",
        'Visible as "Bambuddy"',
        'Visible comme "Bambuddy"',
        "Bambuddy CA",
    )
    unclassified: list[str] = []
    for locale in sorted((root / "frontend" / "src" / "i18n" / "locales").glob("*.ts")):
        for line_number, line in enumerate(locale.read_text(encoding="utf-8").splitlines(), 1):
            if "bambuddy" in line.lower() and not any(fragment in line for fragment in allowed_fragments):
                unclassified.append(f"{locale.name}:{line_number}: {line.strip()}")

    assert unclassified == []
