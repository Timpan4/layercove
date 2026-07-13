# LayerCove identity and compatibility policy

LayerCove is an independent modified fork of [Bambuddy](https://github.com/maziggy/bambuddy). It is not affiliated with or endorsed by Bambuddy's maintainer, Bambu Lab, Klipper, Moonraker, or OrcaSlicer. Upstream copyright, source history, and AGPL-3.0-or-later obligations remain intact.

## Active product identity

User-facing application, API, browser/PWA, repository, support, and current documentation text uses **LayerCove**. Fresh source and image examples use `Timpan4/layercove`. Original logo and icon replacement is tracked separately because it requires visual approval; inherited asset filenames may therefore remain while their accessible product name is LayerCove.

## Environment aliases

For renamed project-specific settings, LayerCove reads `LAYERCOVE_<SUFFIX>` first and falls back to `BAMBUDDY_<SUFFIX>`. If both are set, the LayerCove value wins, including an explicitly empty value.

| Preferred name | Compatibility fallback |
|---|---|
| `LAYERCOVE_LOCAL_LOGIN` | `BAMBUDDY_LOCAL_LOGIN` |
| `LAYERCOVE_EXTERNAL_ROOTS` | `BAMBUDDY_EXTERNAL_ROOTS` |
| `LAYERCOVE_VP_DUMP_WIRE` | `BAMBUDDY_VP_DUMP_WIRE` |

The fallback names are supported interfaces, not deprecated typos. Generic variables such as `DATABASE_URL`, `DATA_DIR`, `LOG_DIR`, `PORT`, and `MFA_ENCRYPTION_KEY` are unchanged.

## Intentionally retained Bambuddy identifiers

These names remain because replacing them would break upgrades, stored data, integrations, or protocol compatibility:

- Python package/import paths, database tables, migration files, and historical migration identifiers.
- `bambuddy.db`, existing named volumes, data/log paths, system-service and installer identifiers.
- Frontend storage keys, custom DOM event names, backup/export filenames, API paths, and MQTT topic defaults.
- Bambu MQTT client IDs, virtual-printer certificates, discovery names, and other on-wire identifiers unless protocol tests prove a migration safe.
- Historical changelog entries, source comments describing inherited behavior, upstream-sync commands, license/source references, press coverage, and attribution links.
- `SpoolBuddy`, which is a distinct inherited subsystem rather than a stale spelling of LayerCove.

Fresh deployment naming may improve without migrating existing installations. Any future rename of a retained identifier requires an explicit compatibility migration, rollback path, and regression tests.

## External destinations

LayerCove release checks target `Timpan4/layercove`. The inherited Bambuddy bug-report relay is disabled by default; operators may set `BUG_REPORT_RELAY_URL` explicitly. This prevents LayerCove diagnostics from being submitted to an unrelated upstream service.

## Verification

Identity changes must keep:

- old-only, new-only, and both-set environment tests;
- Bambu configuration and dispatch regression coverage;
- frontend production build and valid manifest assets;
- Compose parsing with existing volume names;
- a classified, non-zero set of legacy `Bambuddy` strings rather than an unsafe global replacement.

Name, package, domain, and trademark availability require separate legal and registry review; this policy makes no uniqueness claim.
