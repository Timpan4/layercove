# LayerCove rebranding inventory and compatibility plan

**Status:** Phase 1 inventory; user-facing changes not yet applied

LayerCove is a modified fork of Bambuddy. Rebranding is user-facing and must
preserve upstream copyright, AGPL-3.0-or-later obligations, source history, and
accurate attribution. LayerCove is not an official continuation and is not
affiliated with Bambu Lab, Klipper, Moonraker, OrcaSlicer, or Bambuddy's
maintainer.

## Change in product-identity phase

- README opening, disclaimer, status, deployment examples, security warning,
  contribution/upstream guidance, license, and attribution.
- Browser title and metadata, PWA name/description/screenshot labels, login and
  navigation identity, API/OpenAPI title, support/bug-report identity, and safe
  notification sender text.
- Original isolated LayerCove SVG mark/wordmark and generated favicon/app icons.
- Documentation examples should prefer `ghcr.io/timpan4/layercove`, container
  `layercove`, and `LAYERCOVE_*` configuration aliases.

## Intentionally retain unless a tested migration requires change

- Python package/import paths and database table names.
- Existing migration SQL/history and migration identifiers.
- `bambuddy.db`, persistent volume names, data/log paths, system-service names,
  installer compatibility, frontend storage keys, API paths, and protocol IDs.
- Existing `BAMBUDDY_*` variables. Add `LAYERCOVE_*` aliases with documented
  precedence; do not remove or warn noisily in the initial fork.
- SpoolBuddy names: this is a distinct inherited subsystem/product identity,
  not a stale Bambuddy spelling.
- `maziggy/bambuddy` links in attribution, upstream-sync commands, license/source
  history, and code comments describing inherited behavior.
- Bambu MQTT client IDs or other on-wire compatibility identifiers unless a
  protocol test proves changing them is safe.

## Classification hotspots

- `README.md`, `CONTRIBUTING.md`, install/update docs, Docker docs, and
  `slicer-api/README.md`: mixed public identity and required attribution.
- `frontend/index.html`, `frontend/public/manifest.json`, frontend locale files,
  login/layout/settings pages: user-facing identity.
- `backend/app/core/config.py` and `backend/app/main.py`: mixed API title,
  bug-report destination, filenames, environment compatibility, and comments.
- `docker-compose.yml`, installers, deploy scripts, update services, CI image
  names: mixed examples and compatibility identifiers.
- `static/`: generated frontend output; regenerate through normal frontend build,
  never hand-edit.
- `CHANGELOG.md`: historical identity; retain history and add LayerCove changes
  prospectively.

## Alias policy

For each new `LAYERCOVE_*` setting, prefer it when present and fall back to the
existing `BAMBUDDY_*` name. If both are set, document deterministic LayerCove
precedence. Add focused tests for old-only, new-only, and both-set cases.

Persistent storage remains readable in place. Documentation may show new
LayerCove names for fresh installs but must give explicit upgrade examples that
reuse existing volumes and data directories.

## Verification

- Build frontend and confirm manifest/icon paths resolve.
- Search stale identity strings and classify remaining matches rather than
  demanding zero matches.
- Test environment aliases and current database/storage paths.
- Run Bambu regression checks after cosmetic/config changes.
- Visually inspect logo in light/dark, favicon, 192px, 512px, and phone PWA use.

Name, package, domain, and trademark availability require separate legal and
registry verification; this document makes no uniqueness claim.

