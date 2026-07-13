# Synchronizing LayerCove with upstream Bambuddy

LayerCove keeps `origin` on `Timpan4/layercove` and uses a separate `upstream` remote for `maziggy/bambuddy`. Synchronization happens on a disposable integration branch or GitButler stack, never directly on a shared release branch.

## Verify remotes and scope

Read-only inspection is safe in either workflow:

```bash
git remote -v
git fetch upstream
git log --oneline --left-right origin/main...upstream/main
git diff --stat origin/main...upstream/main
```

If `upstream` is missing, add it only after confirming no existing remote has that role. If it points somewhere else, stop rather than overwriting it silently.

Before integration, record the upstream range, the LayerCove base commit, affected migrations, and whether printer transports, persistence, frontend output, Compose, or install scripts changed. This determines which rows of the verification matrix are mandatory.

## GitButler workflow

On `gitbutler/workspace`, every repository write must use `but`. Raw `git switch`, `checkout`, `merge`, `rebase`, `commit`, `push`, `stash`, and `reset` are prohibited.

1. Ensure the workspace is based on current LayerCove `main`:

   ```bash
   but status -fv
   but pull --check
   but pull
   ```

2. Fetch upstream with read-only Git, inspect the upstream commits, then use GitButler to create/apply a disposable integration branch and pick or move the reviewed upstream commits. Use CLI IDs from `but status`, `but show`, or `but diff`; do not copy IDs from an old workspace snapshot.
3. Resolve conflicted commits with the GitButler resolution flow:

   ```bash
   but status -fv
   but resolve COMMIT_ID
   # edit and remove conflict markers
   but resolve status
   but resolve finish
   ```

4. Review the resulting branch against both `origin/main` and `upstream/main`, run the verification matrix, then create its review with `but pr new BRANCH_ID`. Do not use `gh pr create` for a stacked review.
5. If integration becomes unsafe, use GitButler’s resolution cancel/undo or remove the disposable branch. Do not attempt recovery with raw Git history writes.

The exact `but pick`/`but move` sequence depends on whether upstream commits can be applied independently. Prefer the smallest reviewed range; do not import unrelated upstream release/publishing changes solely to make history look identical.

## Normal Git workflow

Use this only in a regular clone, not `gitbutler/workspace`:

```bash
git switch main
git pull --ff-only origin main
git switch -c chore/sync-upstream-main
git fetch upstream
git rebase upstream/main
```

A rebase is appropriate for an unpublished integration branch because it exposes conflicts commit by commit. Prefer a merge when the LayerCove branch is already shared, preserving reviewed topology matters, or rebasing would rewrite commits other people consume:

```bash
git merge --no-ff upstream/main
```

Never force-push a shared branch without explicit coordination. To abandon a normal-Git attempt, use `git rebase --abort` or `git merge --abort`, verify the recorded base commit is still reachable, and retry on a fresh integration branch with a smaller upstream range.

## Conflict policy

Expected hotspots include:

- printer schema/model, provider contracts, `PrinterManager`, lifecycle callbacks, scheduler, archive, and queue dispatch;
- Bambu MQTT/FTP behavior and Moonraker HTTP/WebSocket behavior;
- startup database migrations and dialect-specific branches;
- frontend API clients, printer cards, print/slice dialogs, locale files, and generated `static/` output;
- README, manifest, Compose, installers/updaters, Docker/CI, and release destinations.

For functional conflicts, preserve upstream fixes and adapt them through LayerCove’s provider boundary rather than restoring Bambu-only assumptions. For identity conflicts, keep user-facing LayerCove names and repository/image/support destinations while retaining the compatibility interfaces classified in [`rebranding.md`](rebranding.md): database and migration identifiers, `bambuddy.db`, service/container/volume names, storage/API/event names, backup formats, virtual-printer certificates/discovery, on-wire identifiers, and upstream attribution.

Do not globally replace “Bambuddy.” Historical changelogs, inherited source comments, citations, license notices, compatibility variables, and upstream links may be correct.

## Migration comparison

Before resolving any persistence conflict:

1. List new upstream startup migrations and compare their ordering with LayerCove provider migrations.
2. Compare column/table names, defaults, nullability, indexes, dialect branches, and idempotency guards.
3. Never renumber, delete, or repurpose a migration that may have run in an existing installation.
4. Test a copy of an older Bambu database and a current multi-provider LayerCove database. Verify downgrade/rollback expectations explicitly; startup migrations are generally forward-only, so an application rollback may require restoring the pre-upgrade backup.

## Generated frontend and deployment artifacts

Resolve source files first. Rebuild `static/` only through the repository frontend build; do not hand-edit hashed assets. Review manifest/icon references after generation.

Keep fresh deployment destinations on `Timpan4/layercove` and `ghcr.io/timpan4/layercove`. Preserve existing Compose service/container/volume names and native service labels so replacing a Compose file or checkout does not strand operator data. Compare installer URLs, update remotes, image tags, and CI publishing permissions during every sync that touches deployment files.

## Verification matrix

Use repository-declared tooling. On Windows, run Python/frontend tooling through WSL from `/mnt/d/layercove`; use Bun for the frontend.

| Area | Minimum automated check | When mandatory |
|---|---|---|
| Backend style | `uv run --with-requirements requirements-dev.txt ruff check backend/` and `ruff format --check backend/` | Every sync touching Python |
| Backend baseline | `uv run --with-requirements requirements.txt --with-requirements requirements-dev.txt pytest backend/tests/` | Every sync |
| Bambu regression | Focused manager, MQTT, FTP/FTPS, queue/scheduler, archive/history tests | Bambu, shared state, dispatch, migration, or lifecycle changes |
| Moonraker | Client/security/fake-server integration suites | Provider, status, camera, dispatch, queue, or shared state changes |
| Migrations | Existing-database startup/migration tests for SQLite and applicable PostgreSQL paths | Schema, model, config, or startup changes |
| Frontend | `bun install --frozen-lockfile`, lint, TypeScript check, tests, and build | Frontend/API/schema/identity changes |
| Generated output | Compare source and generated manifest/metadata; inspect tracked `static/` diff | Frontend build or identity changes |
| Slicer | Provider-aware slicing tests and `docker compose -f slicer-api/docker-compose.yml config` | Slicer/profile/output changes |
| Compose | `docker compose config` plus compatibility-name assertions | Compose/install/update changes |
| Production image | `docker build`, backend import/static checks, start, `/health`, settings API, frontend HTTP smoke | Docker/dependency/frontend/startup changes |
| Installer syntax | `bash -n install/*.sh` and PowerShell parser check | Install/update changes |
| Whitespace | `git diff --check` | Every sync |
| Hardware | Operator-attended Bambu/Klipper smoke plan | Protocol/dispatch changes before release; may be recorded as skipped in an integration PR, never implied passed |

Run `docker-compose.test.yml` integration tests when Docker is available. Never run cleanup with operator volume names; disposable smoke stacks must use isolated project names/volumes.

Record the exact command, result, environment, and every skip reason in the pull request. A sync is not complete because conflicts are gone; it is complete only when its affected verification rows pass or a remaining limitation is linked.

## Final review and recovery

Review the integration diff against both parents:

```bash
git diff --check
git diff --stat origin/main...HEAD
git diff --stat upstream/main...HEAD
```

In a GitButler workspace use `but diff`/`but show` for the branch review while keeping the read-only parent comparisons above. Confirm attribution remains, no secret entered the diff, release/update URLs target LayerCove, migrations remain monotonic, and skipped hardware validation is clearly open.

After merge, keep the integration evidence and pre-deployment backup until production health, frontend loading, existing printer records, and one representative provider workflow are confirmed. If production validation fails, roll back the image/revision and restore the backup when migrations require it; create a linked bug rather than waiving the result.
