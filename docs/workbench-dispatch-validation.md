# Workbench and dispatch follow-up

## Completion criteria

The selected machine revision supplies the bed bounds to both viewers. A 300 mm
machine is not displayed against a 256 mm bed. Arrangement reaches the slicer even
when per-object model-state support is unavailable; disabling it preserves saved project
placement. Standalone STL imports are centered by Orca itself. Preview freshness includes arrangement and selected profile revisions.

A user with `settings:update` can edit a selected filament and save/use an active
local copy. Source revisions and previously pinned jobs remain unchanged. Private
source visibility, explicit installation-wide sharing consent, stale-revision
checks and compatibility declarations remain enforced.

Queue submission wakes the singleton scheduler after the transaction commits.
The queue, printer widget and toast distinguish preparation, upload bytes, and
waiting for printer acceptance. Neither reading the last upload byte nor an
HTTP upload response means the print-start command was accepted.

## Placement

The workbench and Slice dialog default to **Arrange on selected printer bed**.
This forwards the existing sidecar `arrange` option separately from advanced
model-state features. Disable it to retain saved project placement; manual object
transforms also disable automatic arrangement. Multi-plate 3MF arrangement uses
independent plate extraction/slicing/merge instead of flattening all plates.

Bed dimensions/origin come from the exact machine revision's `printable_area`
(or `bed_shape`) and `printable_height` (or `max_print_height`). Unknown geometry
is displayed as unavailable, not guessed from printer names. The displayed bed
is its bounding rectangle, not a collision check for irregular bed polygons.
Prepare gives an arrangement preview, but the sliced G-code Preview is authoritative.
Standalone STL imports are centered by Orca even when arrangement is disabled;
Prepare follows that behavior. No generated G-code is translated or rewritten by
the viewer.

Bundled catalog revisions are already resolved. Their retained `inherits` label
is omitted only from the sidecar input, without modifying stored content/hashes.
This avoids a second, potentially ambiguous lookup across vendors' common parents.
Other sources retain their existing inheritance rules.

## Filament edits

Use the edit button beside the selected filament. The editor includes common
printing settings and expandable JSON for the remaining settings. Array values
and untouched tool slots are preserved. Saving requires explicit consent because
local presets are shared across this installation.

The backend creates a distinct local identity and active catalog revision in one
transaction. It approves only that copy, not other pending catalog changes.
Original identity/compatibility fields cannot be edited in this form; known
administrator compatibility mappings are copied unchanged. Editing a temperature
is not evidence of compatibility with another printer.

The new profile is selected after the profile list and classification refresh.
Failure to refresh selection reports that the copy was saved and allows retrying
selection without creating another copy. Existing jobs retain their pinned source
revisions; a newly selected revision makes an old preview stale.

## Queue progress

- **Preparing transfer**: queue claimed for dispatch, including extraction/setup.
- **Uploading to printer**: actual G-code/FTP stream bytes consumed by the transport.
  At 100%, the upload response can still be pending.
- **Waiting for printer confirmation**: upload accepted, print start not confirmed.

The elapsed counter is for the current phase. Live transfer telemetry is a bounded
in-memory cache for the existing singleton architecture, exposed by REST for
polling/reconnecting clients. SQL job state remains authoritative. Restart clears
byte telemetry; durable unacknowledged starts still show the waiting phase from
the existing reconciliation fields. Failure, cancellation and acceptance clear
progress; delayed byte callbacks cannot revive terminal progress.

The 30-second poll remains a recovery fallback, but committed create/start API
requests now signal the running scheduler immediately. This removes an avoidable
polling delay, not network transfer time, firmware parsing, homing or heating.
Do not conclude a reported two-minute wait was all upload time without these
phase measurements and printer-side logs.

## Automated checks

Run the repository's normal backend Ruff/pytest and frontend lint, build,
Vitest, translation-parity and brand checks. Regressions cover HTTP filament-copy
transactions, authorization/visibility, revision pinning, source immutability,
300 mm geometry and source placement, stale previews, real multipart upload
callbacks, scheduler wakeups and failure/reconnect progress.

The catalog pipeline tests exercise library and archive requests through the real
selection, persistence, dispatch, backend and Moonraker HTTP implementation. Only
external slicer responses and printer endpoints are replaced. They check the
edited filament/arrange request fields, exact uploaded G-code bytes, and distinct
upload/start-acceptance states.

## Manual checks after deployment

With no other transfer or print running, choose the actual 300 mm machine and a
small off-origin model. Confirm the bed label, slice with arrangement enabled and
inspect extrusion placement around the bed center. Repeat with a positioned 3MF and arrangement off
for saved project placement; re-slice before printing after changing any selection.

Edit the selected filament, save/use a local copy and confirm its nozzle/bed
settings in the generated G-code. Check the original remains unchanged.

Submit one controlled print per provider. Observe preparation, upload progress,
and printer-confirmation phases, including a browser refresh during a transfer.
Record the elapsed phase and printer logs when investigating delays. Never retry
an uncertain start without checking the physical printer's state/history.
