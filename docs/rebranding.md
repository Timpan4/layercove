# LayerCove identity and compatibility policy

LayerCove is an independent modified fork of [Bambuddy](https://github.com/maziggy/bambuddy). It is not affiliated with or endorsed by Bambuddy's maintainer, Bambu Lab, Klipper, Moonraker, or OrcaSlicer. Upstream copyright, source history, and AGPL-3.0-or-later obligations remain intact.

## Product identity

User-facing application, API, browser/PWA, repository, support, and documentation text uses **LayerCove**. Source and image references use `Timpan4/layercove` and `ghcr.io/timpan4/layercove`. Replacing the original logo and icons is tracked separately because it needs visual approval, so some inherited asset filenames remain while their accessible name is LayerCove.

## Deployment names

Fresh deployments use LayerCove names:

- SQLite database `layercove.db` in `DATA_DIR`;
- Compose service and container `layercove`;
- volumes `layercove_data` and `layercove_logs`;
- backup archives `layercove-backup-<timestamp>.zip`.

LayerCove never opens, renames, or migrates a Bambuddy or BambuTrack database. If `bambuddy.db` or `bambutrack.db` exists in `DATA_DIR` and `DATABASE_URL` is unset, LayerCove refuses to start. Backup restore rejects archives that contain either file.

## Environment aliases

For renamed project-specific settings, LayerCove reads `LAYERCOVE_<SUFFIX>` first and falls back to `BAMBUDDY_<SUFFIX>`. If both are set, the LayerCove value wins, including an explicitly empty value.

| Preferred name | Compatibility fallback |
|---|---|
| `LAYERCOVE_LOCAL_LOGIN` | `BAMBUDDY_LOCAL_LOGIN` |
| `LAYERCOVE_EXTERNAL_ROOTS` | `BAMBUDDY_EXTERNAL_ROOTS` |
| `LAYERCOVE_VP_DUMP_WIRE` | `BAMBUDDY_VP_DUMP_WIRE` |

The fallback names are supported interfaces, not deprecated typos. Generic variables such as `DATABASE_URL`, `DATA_DIR`, `LOG_DIR`, `PORT`, and `MFA_ENCRYPTION_KEY` are unchanged.

## Retained Bambuddy identifiers

These names stay because changing them would break stored data, integrations, or protocol compatibility:

- Python package and import paths, database table names, and source identifiers.
- Frontend storage keys, custom DOM event names, API paths, and MQTT topic defaults.
- Bambu MQTT client IDs, virtual-printer certificates, discovery names, and other on-wire identifiers, unless protocol tests prove a change safe.
- Option names in inherited tools, such as the SpoolBuddy installer's `--bambuddy-url`.
- Historical changelog entries, source comments about inherited behavior, upstream-sync commands, license and source references, press coverage, and attribution links.
- `SpoolBuddy`, a distinct inherited subsystem rather than a stale spelling of LayerCove.

Renaming a retained identifier requires an explicit compatibility migration, a rollback path, and regression tests.

## External destinations

Release checks target `Timpan4/layercove`. The inherited Bambuddy bug-report relay is disabled by default; operators may set `BUG_REPORT_RELAY_URL` explicitly. This keeps LayerCove diagnostics from going to an unrelated upstream service.

## Verification

Identity changes must keep:

- old-only, new-only, and both-set environment tests;
- Bambu configuration and dispatch regression coverage;
- a passing frontend production build with valid manifest assets;
- Compose parsing with the current volume names;
- a classified, non-zero set of legacy `Bambuddy` strings rather than a global replacement.

Name, package, domain, and trademark availability need separate legal and registry review. This policy makes no uniqueness claim.
