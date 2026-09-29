"""Integration tests for read-only application update routes."""

from unittest.mock import patch

import pytest
from httpx import AsyncClient


class _ReleaseResponse:
    status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return [
            {
                "tag_name": "v999.9.9",
                "name": "Far Future Release",
                "body": "",
                "html_url": "https://example.invalid/release",
                "published_at": "2099-01-01T00:00:00Z",
            }
        ]


class _ReleaseClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return None

    async def get(self, *_, **__):
        return _ReleaseResponse()


class TestUpdatesAPI:
    @pytest.mark.asyncio
    async def test_get_version(self, async_client: AsyncClient):
        response = await async_client.get("/api/v1/updates/version")
        assert response.status_code == 200
        assert response.json()["repo"] == "Timpan4/layercove"

    @pytest.mark.asyncio
    async def test_check_returns_docker_update_method(self, async_client: AsyncClient):
        import httpx

        with (
            patch.object(httpx, "AsyncClient", _ReleaseClient),
            patch("backend.app.api.routes.updates._is_ha_addon", return_value=False),
        ):
            response = await async_client.get("/api/v1/updates/check")

        assert response.status_code == 200
        body = response.json()
        assert body["update_available"] is True
        assert body["is_docker"] is True
        assert body["is_ha_addon"] is False
        assert body["update_method"] == "docker"

    @pytest.mark.asyncio
    async def test_check_returns_ha_addon_update_method(self, async_client: AsyncClient):
        import httpx

        with (
            patch.object(httpx, "AsyncClient", _ReleaseClient),
            patch("backend.app.api.routes.updates._is_ha_addon", return_value=True),
        ):
            response = await async_client.get("/api/v1/updates/check")

        body = response.json()
        assert body["is_docker"] is False
        assert body["is_ha_addon"] is True
        assert body["update_method"] == "ha_addon"

    @pytest.mark.asyncio
    async def test_mutating_update_routes_do_not_exist(self, async_client: AsyncClient):
        assert (await async_client.post("/api/v1/updates/apply")).status_code in {404, 405}
        assert (await async_client.get("/api/v1/updates/status")).status_code == 404
        paths = (await async_client.get("/openapi.json")).json()["paths"]
        assert "/api/v1/updates/apply" not in paths
        assert "/api/v1/updates/status" not in paths

    @pytest.mark.asyncio
    async def test_check_backs_off_after_github_rate_limit(self, async_client: AsyncClient):
        import time

        import httpx

        import backend.app.api.routes.updates as updates_module

        updates_module._github_rate_limit_until = 0.0
        future_reset = time.time() + 600

        class RateLimitedResponse:
            status_code = 403
            headers = {
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": str(int(future_reset)),
            }
            text = "API rate limit exceeded"

        calls = 0

        class RateLimitedClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return None

            async def get(self, *_, **__):
                nonlocal calls
                calls += 1
                return RateLimitedResponse()

        try:
            with patch.object(httpx, "AsyncClient", RateLimitedClient):
                first = await async_client.get("/api/v1/updates/check")
                second = await async_client.get("/api/v1/updates/check")
        finally:
            updates_module._github_rate_limit_until = 0.0

        assert calls == 1
        assert "rate limit" in first.json()["error"].lower()
        assert second.json()["retry_after_seconds"] > 0

    def test_version_comparison(self):
        from backend.app.api.routes.updates import is_newer_version, parse_version

        assert parse_version("0.1.5")[:3] == (0, 1, 5)
        assert is_newer_version("0.1.5", "0.1.5b7") is True
