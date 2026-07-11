# Synchronizing LayerCove with upstream Bambuddy

**Status:** Initial Phase 1 strategy

The local `upstream` remote should point to `maziggy/bambuddy`. Verify before
fetching; do not overwrite another valid configuration silently.

```sh
git remote -v
git fetch upstream
```

This checkout uses GitButler. On `gitbutler/workspace`, use GitButler for all
write operations and never run raw `git switch`, `rebase`, `merge`, `commit`,
`push`, or `stash`. Create/update the integration stack with `but` commands
appropriate to the installed CLI. Use `but diff --no-tui` for review.

For a normal non-GitButler clone, synchronize a private integration branch:

```sh
git switch main
git pull --ff-only origin main
git switch -c chore/sync-upstream-main
git rebase upstream/main
```

Never rewrite a shared branch without explicit coordination. A merge may be
safer when a published LayerCove branch has multiple consumers or when preserving
reviewed topology matters more than linear history.

## Expected conflict hotspots

- printer model/schema, `PrinterManager`, printer routes, scheduler, and main
  lifecycle callbacks;
- large frontend API client, printer page, print/slice modals, and locale files;
- README, manifest, browser metadata, Compose/install/update docs, and generated
  static assets;
- startup database migrations and CI/Docker definitions.

Resolve branding conflicts by keeping upstream functional changes and then
reapplying only user-facing LayerCove identity. Preserve upstream attribution,
historical migrations, internal paths, and compatibility aliases.

## Migration review

Before resolving database conflicts, compare new upstream startup migrations,
column names, defaults, nullability, dialect branches, and tests against all
LayerCove provider migrations. Never renumber or delete historical migrations.
Test a representative old Bambu database and a current LayerCove database.

## Verification after every sync

```sh
ruff check backend/
ruff format --check backend/
cd backend && python -m pytest tests/
cd ../frontend && npm ci && npm run lint && npx tsc --noEmit && npm run test:run && npm run build
cd .. && docker compose config
docker compose -f docker-compose.test.yml run --rm backend-test
docker compose -f docker-compose.test.yml run --rm frontend-test
git diff --check
```

Also run focused Bambu manager/MQTT/FTP/scheduler/archive tests, Moonraker client
and fake-server tests once present, migration tests, slicer tests, and a
production Docker build. Regenerate `static/` only through the normal frontend
build. Record every skipped check and reason.

## Abort and recovery

In a normal Git clone, `git rebase --abort` returns to the pre-rebase state.
Record the current commit and keep pushed/shared work reachable before starting.
If resolution becomes unsafe, abort, inspect upstream changes, and retry with a
smaller integration branch or merge. In GitButler mode, use GitButler's own
abort/recovery workflow; do not mix raw Git writes into its workspace.

After synchronization, validate the exact production branch/stack, inspect its
diff against both parents, rebuild deployment artifacts, and perform real Bambu
and Moonraker smoke tests when protocol or dispatch paths changed.
