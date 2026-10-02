# Contributing to LayerCove

Read the [Code of Conduct](CODE_OF_CONDUCT.md) before taking part. Report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Start with an issue

1. Open an issue, or comment on an existing one, describing the change.
2. Agree on scope and approach with a maintainer.
3. Wait to be assigned, then open a pull request for that issue.

Pull requests without an assigned issue will be closed.

## Development setup

The supported development environment is Linux or macOS. On Windows, use WSL.

Prerequisites:

- Python 3.10 or later (CI uses 3.11) and [uv](https://docs.astral.sh/uv/)
- Bun 1.3.14 (pinned by `packageManager` in `frontend/package.json`)
- Docker with Compose v2 for image and integration checks

Start the backend and frontend together:

```bash
bash scripts/dev.sh
```

Open `http://localhost:5173`. Vite proxies API and WebSocket traffic to the backend on `http://localhost:8000`. Set `BACKEND_PORT` to use another backend port. `Ctrl+C` stops both servers.

To run them separately:

```bash
# Backend. --loop asyncio matches production and avoids a uvloop TLS bug
# that can truncate virtual-printer FTP uploads.
DEBUG=true uv run --with-requirements requirements.txt --with-requirements requirements-dev.txt \
  uvicorn backend.app.main:app --reload --host 0.0.0.0 --port 8000 --loop asyncio

# Frontend
cd frontend
bun install --frozen-lockfile
bun run dev
```

Pre-commit hooks run Ruff, whitespace and YAML/JSON checks, private-key detection, an import-shadowing test, and a TypeScript check. Install them with `uvx pre-commit install`. The last two hooks call `python -m pytest` and `npx tsc` from your shell, so commit from an environment that has the backend dependencies and frontend `node_modules` installed.

## Checks

### Backend

```bash
uv run --with-requirements requirements-dev.txt ruff check backend/
uv run --with-requirements requirements-dev.txt ruff format --check backend/
uv run --with-requirements requirements.txt --with-requirements requirements-dev.txt pytest backend/tests/
```

Tests live in `backend/tests/unit/` and `backend/tests/integration/`. Pass a path to run a subset.

### Frontend

```bash
cd frontend
bun run lint          # Oxlint
bun x tsc --noEmit    # type check
bun run test:run      # Vitest, i18n parity, and brand-asset checks
bun run build         # production build
```

Browser E2E tests in `frontend/e2e/` use Playwright against a running server:

```bash
cd frontend
LAYERCOVE_URL=http://localhost:8001 bun run test:e2e
```

If you change backend API schemas, run `bun run check:api` to confirm `src/api/generated.ts` is current.

### Rust service

See [rust/README.md](rust/README.md).

### Docker

```bash
docker compose -f docker-compose.test.yml run --rm backend-test
docker compose -f docker-compose.test.yml run --rm frontend-test
```

### Test policy

[AGENTS.md](AGENTS.md) holds the repository test policy. In short:

- Prefer E2E tests.
- Every bug fix includes a regression test that fails before the fix and passes after it.
- Do not add tests that only restate the implementation, such as asserting mock calls or source text.

## CI

`.github/workflows/ci.yml` runs on pull requests to `main` and pushes to `main`:

| Job | Checks |
|---|---|
| Backend Lint | `ruff check` and `ruff format --check` |
| Backend Tests | pytest in four shards |
| PostgreSQL Camera Token Expiry | camera token expiry against a PostgreSQL clock |
| Frontend Checks | CI workflow regression test, Oxlint, TypeScript, build, Vitest |
| Docker Backend Tests | pytest in the test image, four shards |
| Docker Build | production image, health/API/static smoke tests, Playwright E2E |
| Rust service | `cargo fmt`, `clippy`, and tests |

CodeQL (`codeql.yml`) and the security audit (`security.yml`) run as separate workflows.

## Code style

- Python: Ruff, configured in `pyproject.toml`.
- TypeScript/React: Oxlint and `tsc`.
- Keep printer-specific behavior behind the provider contracts in [ADR 0001](docs/decisions/0001-multi-backend-printer-architecture.md).
- Do not rename retained Bambuddy identifiers without a tested migration; see [docs/rebranding.md](docs/rebranding.md).

## Internationalization

All user-visible frontend text goes through [react-i18next](https://react.i18next.com/). Do not hardcode strings.

Locale files live in `frontend/src/i18n/locales/`: `en.ts` (primary), `de.ts`, `es.ts`, `fr.ts`, `it.ts`, `ja.ts`, `ko.ts`, `pt-BR.ts`, `tr.ts`, `zh-CN.ts`, and `zh-TW.ts`.

```tsx
import { useTranslation } from 'react-i18next';

function MyComponent() {
  const { t } = useTranslation();
  return <span>{t('section.myNewKey')}</span>;
}
```

Add each new key to every locale with the same key path, grouped by feature (`spoolman.`, `nav.`, `common.`). `bun run check:i18n`, which `bun run test:run` includes, fails on missing keys, mismatched plural forms, or untranslated English copies.

## Authentication and permissions

Authentication is optional. When it is off, endpoints are open. When it is on, endpoints check a JWT or API key against granular permissions.

Protect a route with `RequirePermissionIfAuthEnabled`:

```python
from backend.app.core.auth import RequirePermissionIfAuthEnabled
from backend.app.core.permissions import Permission

@router.get("/my-resource")
async def get_my_resource(
    _: User | None = RequirePermissionIfAuthEnabled(Permission.RESOURCE_READ),
):
    ...
```

Permissions use `resource:action` names such as `filaments:read` and `printers:control`. Standard actions are `read`, `create`, `update`, and `delete`. Some resources have more, for example `printers:files`, `queue:create`, `library:upload`, and `archives:reprint_own`/`archives:reprint_all`. Archive reprint also needs `queue:create`.

To add a permission:

1. Add it to the `Permission` enum in `backend/app/core/permissions.py`.
2. Add it to a category in `PERMISSION_CATEGORIES`.
3. Add it to the right entries in `DEFAULT_GROUPS`. Administrators get every permission.
4. Classify it for API keys in `_APIKEY_SCOPE_BY_PERMISSION` or `_APIKEY_DENIED_PERMISSIONS` in `backend/app/core/auth.py`. CI fails on unclassified permissions.
5. Add negative-path tests. See the rules in [SECURITY.md](SECURITY.md#security-rules-for-contributors).

| Default group | Access |
|---|---|
| Administrators | All permissions |
| Operators | Printer control, own archive and queue items, read-only settings |
| Viewers | Read-only access |

## Documentation

Update the matching documentation in this repository with any change to user-visible behavior, settings, ports, URLs, API endpoints, or install and upgrade steps. That covers the README, `docs/`, `UPDATING.md`, `install/README.md`, and `docker-compose.yml` comments. Bug fixes with no visible change, internal refactors, and test-only changes need no documentation; say so in the pull request.

## Pull requests

1. Branch from `main` with a prefix: `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `perf/`, or `chore/`.
2. Keep each pull request to one feature or fix.
3. Target `main` and fill in the pull request template.
4. Link the issue the pull request resolves.
5. Include before and after screenshots for any UI change.
6. Make sure CI passes.

## Reporting bugs and requesting features

Use the [bug report](https://github.com/Timpan4/layercove/issues/new?template=bug_report.yml) or [feature request](https://github.com/Timpan4/layercove/issues/new?template=feature_request.yml) template. For bugs, include reproduction steps, expected and actual behavior, your LayerCove version, deployment method, printer model and firmware, and relevant logs or a support package.
