# Maintainer guide

## CI

`.github/workflows/ci.yml` runs on pull requests to `main`, pushes to `main`, and manual dispatch. Check names as they appear on a pull request:

| Check | Purpose |
|---|---|
| `Backend Lint` | `ruff check` and `ruff format --check` |
| `Backend Tests (shard N/4)` | pytest, four shards |
| `PostgreSQL Camera Token Expiry` | camera token expiry against PostgreSQL |
| `Frontend Checks` | CI workflow regression test, Oxlint, TypeScript, build, Vitest |
| `Docker Backend Tests (shard N/4)` | pytest in the test image, four shards |
| `Docker Build` | production image, health/API/static smoke tests, Playwright E2E |
| `Rust service` | `cargo fmt`, `clippy`, tests, and image smoke tests |

`codeql.yml` (CodeQL) and `security.yml` (Security Audit) run separately.

### Fixing common failures

```bash
# Backend Lint
uv run --with-requirements requirements-dev.txt ruff check --fix backend/
uv run --with-requirements requirements-dev.txt ruff format backend/

# Frontend Checks
cd frontend
bun run lint
bun x tsc -b
bun run test:run
```

## Branch protection

`main` currently has no branch protection or ruleset. To add one, go to **Settings → Rules → Rulesets → New branch ruleset**:

1. Name it `Protect main`, set enforcement to **Active**, and target `main`.
2. Enable **Restrict deletions** and **Block force pushes**.
3. Enable **Require a pull request before merging**.
4. Enable **Require status checks to pass** and add the CI checks above after they have run once. Sharded jobs report one check per shard.

## Releases

`publish-container.yml` builds `ghcr.io/timpan4/layercove` for `linux/amd64` and `linux/arm64` when a push to `main` changes the backend, frontend, deploy files, `gcode_viewer/`, `spoolbuddy/`, `Dockerfile`, or `requirements.txt`. Pushes to `main` get the `latest` tag.

A `v*` tag publishes semver tags (`X.Y.Z` and `X.Y`). No LayerCove release has been tagged yet. To cut one:

1. Set `APP_VERSION` in `backend/app/core/config.py`. The in-app update check compares this value with GitHub releases.
2. Merge that change through a pull request.
3. Tag the merge commit `vX.Y.Z` and push the tag.
4. Publish a GitHub release for the tag. The update check reads releases, not bare tags.

`publish-rust.yml` publishes `ghcr.io/timpan4/layercove-rs` after CI succeeds on a push to `main`; see [rust/README.md](../rust/README.md).

`docker-publish.sh` and the other `docker-publish-*.sh` scripts are inherited from upstream and publish upstream `maziggy/bambuddy` images. Do not use them for LayerCove.

## Database upgrades

LayerCove starts only from its current schema. `run_migrations` in `backend/app/core/database.py` applies runtime invariants; historical schema upgrades are intentionally unsupported. To roll back, restore the backup taken before the update, as described in [UPDATING.md](../UPDATING.md#rollback). Upstream migrations brought in by a sync must follow [docs/upstream-sync.md](../docs/upstream-sync.md#migration-comparison).

## Inherited repository settings

These files still name the upstream maintainer and need a LayerCove decision:

- `.github/CODEOWNERS` assigns every path to `@maziggy`.
- `cleanup-ghcr.yml` and `repo-stats.yml` target upstream resources (#92).
