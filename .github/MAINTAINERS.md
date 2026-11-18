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

Independent Ruff checks and frontend lint/typecheck/build steps use GitHub's
[`parallel` groups](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsparallel).
Frontend tests follow the build because brand tests inspect its output. The
production Docker build runs in the background during E2E dependency setup;
an explicit `wait` propagates build failures before image checks and Compose.

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

`publish-container.yml` builds and attests `ghcr.io/timpan4/layercove` for `linux/amd64` and `linux/arm64` after CI passes for the exact commit pushed to `main`. Published images use the `sha-<commit>` tag. The publisher reconciles `latest` to the verified image at the tip of `main` once that image is available.

A `vX.Y.Z` tag requests the `X.Y.Z` image tag for the attested digest of that commit. The `X.Y` alias tracks the newest published patch for that minor version. The release request can build the SHA image if it is missing. To cut a release:

1. Set `APP_VERSION` in `backend/app/core/config.py`. The in-app update check compares this value with GitHub releases.
2. Merge that change through a pull request.
3. Wait for main CI to pass on the merge commit.
4. Tag that commit `vX.Y.Z` and push the tag. If a tag request reached the publisher before main CI passed, rerun Container release request on that tag after CI succeeds.
5. After the version tags are published, publish a GitHub release for the Git tag. The update check reads published releases.

`publish-rust.yml` publishes `ghcr.io/timpan4/layercove-rs` after CI succeeds on a push to `main`; see [rust/README.md](../rust/README.md).

`docker-publish.sh` and the other `docker-publish-*.sh` scripts are inherited from upstream and publish upstream `maziggy/bambuddy` images. Do not use them for LayerCove.

## Database upgrades

LayerCove starts only from its current schema. `run_migrations` in `backend/app/core/database.py` applies runtime invariants; historical schema upgrades are intentionally unsupported. To roll back, restore the backup taken before the update, as described in [UPDATING.md](../UPDATING.md#rollback). Upstream migrations brought in by a sync must follow [docs/upstream-sync.md](../docs/upstream-sync.md#migration-comparison). [ADR 0002](../docs/decisions/0002-python-rust-coexistence.md) keeps database access and schema migrations in Python during the Rust pilot. A future forward-compatible upgrade policy and its owner are undecided; see #105.

## Inherited repository settings

These files still name the upstream maintainer and need a LayerCove decision:

- `.github/CODEOWNERS` assigns every path to `@maziggy`.

The inherited `cleanup-ghcr.yml` and `repo-stats.yml` workflows were removed
(#92). They targeted the old `bambuddy` package and upstream repository stats,
required absent PATs, and repeatedly failed. LayerCove does not schedule package
deletion or collect upstream traffic stats.
