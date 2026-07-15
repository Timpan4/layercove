from __future__ import annotations

import importlib
import json
import os
import re
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
def test_generated_frontend_identity_matches_sources():
    root = REPOSITORY_ROOT
    source_index = (root / "frontend" / "index.html").read_text(encoding="utf-8")
    generated_index = (root / "static" / "index.html").read_text(encoding="utf-8")
    source_manifest = json.loads((root / "frontend" / "public" / "manifest.json").read_text(encoding="utf-8"))
    generated_manifest = json.loads((root / "static" / "manifest.json").read_text(encoding="utf-8"))

    for tag in ("title", "description", "apple-mobile-web-app-title"):
        pattern = rf"<(?:title|meta)[^>]*(?:name=\"{tag}\"[^>]*content=\"([^\"]+)\"|content=\"([^\"]+)\"[^>]*name=\"{tag}\")[^>]*>|<title>([^<]+)</title>"
        source_match = re.search(pattern, source_index)
        generated_match = re.search(pattern, generated_index)
        assert source_match is not None and generated_match is not None
        assert next(value for value in source_match.groups() if value) == next(
            value for value in generated_match.groups() if value
        )

    for field in ("name", "short_name", "description", "screenshots"):
        assert generated_manifest[field] == source_manifest[field]


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
def test_bambu_storage_and_runtime_compatibility_identifiers_remain():
    import backend.app.core.config as config

    assert Path(config.settings.database_url.removeprefix("sqlite+aiosqlite:///")).name == "bambuddy.db"
    assert config.settings.archive_dir.name == "archive"

    root = REPOSITORY_ROOT
    compose = (root / "docker-compose.yml").read_text(encoding="utf-8")
    assert "  bambuddy:" in compose
    assert "image: ghcr.io/timpan4/layercove:latest" in compose
    assert "container_name: bambuddy" in compose
    assert "bambuddy_data:/app/data" in compose
    assert "bambuddy_logs:/app/logs" in compose


@pytest.mark.unit
def test_optional_bundled_spoolman_is_private_and_does_not_gate_layercove():
    root = REPOSITORY_ROOT
    compose = (root / "docker-compose.yml").read_text(encoding="utf-8")

    assert "  spoolman:" in compose
    assert "image: ghcr.io/donkie/spoolman:0.21.0" in compose
    assert 'profiles: ["spoolman"]' in compose
    assert '"127.0.0.1:7912:8000"' in compose
    assert "spoolman_data:/home/app/.local/share/spoolman" in compose
    assert (
        'test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen(\'http://localhost:8000/api/v1/health\')"]'
        in compose
    )
    assert "    depends_on:" not in compose

    test_dockerfile = (root / "Dockerfile.test").read_text(encoding="utf-8")
    assert "COPY scripts/spoolman_volume.py ./scripts/spoolman_volume.py" in test_dockerfile


@pytest.mark.unit
def test_bundled_spoolman_operations_preserve_external_instances_and_data():
    root = REPOSITORY_ROOT
    updating = (root / "UPDATING.md").read_text(encoding="utf-8")

    assert "does not change existing external Spoolman settings" in updating
    assert "docker compose --profile spoolman up -d" in updating
    assert "mkdir -p scripts" in updating
    assert "https://raw.githubusercontent.com/Timpan4/layercove/main/scripts/spoolman_volume.py" in updating
    assert '--user "$(id -u):1000" --entrypoint python' in updating
    assert updating.count("--user 1000:1000 --entrypoint python") == 1
    assert "docker compose --profile spoolman run --rm --no-deps" in updating
    assert "scripts/spoolman_volume.py backup" in updating
    assert "scripts/spoolman_volume.py restore" in updating
    assert "http://127.0.0.1:7912" in updating
    assert "http://spoolman:8000" in updating
    assert "http://host.docker.internal:7912" not in updating
    assert "spoolman-data-backup.tgz &&" in updating
    assert "leave Spoolman stopped" in updating
    assert "docker compose --profile spoolman config --volumes" not in updating
    assert "restore the pre-upgrade archive first" in updating
    assert "Never use `docker compose down -v`" in updating

    root = REPOSITORY_ROOT
    installers = {
        path: (root / path).read_text(encoding="utf-8")
        for path in (
            "install/install.sh",
            "install/docker-install.sh",
            "install/docker-install.ps1",
        )
    }

    for path, content in installers.items():
        assert "Timpan4/layercove" in content, path
        assert "maziggy/bambuddy" not in content, path

    assert 'DEFAULT_INSTALL_PATH="/opt/layercove"' in installers["install/install.sh"]
    assert 'DEFAULT_INSTALL_PATH="/opt/layercove"' in installers["install/docker-install.sh"]
    assert "Join-Path $env:USERPROFILE 'layercove'" in installers["install/docker-install.ps1"]
    assert 'SERVICE_USER="bambuddy"' in installers["install/install.sh"]
    assert "/etc/systemd/system/bambuddy.service" in installers["install/install.sh"]

    for path in ("install/update.sh", "install/update_macos.sh"):
        content = (root / path).read_text(encoding="utf-8")
        assert 'DEFAULT_INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"' in content


@pytest.mark.unit
def test_container_publish_workflow_matches_documented_image():
    root = REPOSITORY_ROOT
    workflow = (root / ".github" / "workflows" / "publish-container.yml").read_text(encoding="utf-8")

    assert "packages: write" in workflow
    assert "ghcr.io/${{ github.repository_owner }}/layercove" in workflow
    assert "linux/amd64,linux/arm64" in workflow


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
