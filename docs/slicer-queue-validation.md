# Slicer and queue dispatch validation

## Completion contract

A complete explicit printer/process/filament selection is evaluated independently
of optional binding defaults. Confirmed nozzle/tool and declared machine-nozzle
mismatches still block it. Missing compatibility metadata remains unclassified
and requires acknowledgement, not automatic compatibility. Canonical machine
names and compatibility declarations in resolved content remain authoritative
when display labels or older denormalized metadata differ.

Pinned Bambu and Orca cloud revisions must be materialized into CLI
machine/process/filament profiles without changing the stored revision. A slice
worker must own its pending-to-running transition before invoking the sidecar.

The existing single-process scheduler must dispatch both providers, isolate
per-job database failures, serialize overlapping queue passes, preserve
cancellation races, and avoid automatic replay of uncertain physical operations.
Fresh Moonraker `standby`, `complete`, and `cancelled` states can accept a new
print. Paused, error, stale and unknown states cannot.

## Execution paths and findings

Profile adapters ingest immutable catalog revisions, resolve inheritance, and
activate approved revisions. Physical bindings identify an exact profile,
nozzle and tool. Classification and transactional slice selection now use the
same canonical-content helpers. Explicit selection readiness is separate from
the binding's fallback-default readiness. The UI refreshes nozzle/classification
evidence and invalidates acknowledgement when that evidence changes.

Previously, unclassified candidates reused the binding's missing-default error,
while matched candidates correctly excluded defaults from candidate readiness.
Local imports could also discard compatibility declared only in their JSON.
Pinned Bambu cloud profiles bypassed the legacy path's `printer` to `machine`
and `from: system` normalization, producing invalid CLI input.

Both printer providers use `PrintScheduler.check_queue`. One uncaught item
exception aborted the whole pass. Shared-session rollback could also expire
unrelated pending ORM rows. Each candidate now gets a fresh session, failures
are persisted with safe context, and processing continues for other printers.

Moonraker uses the existing separate upload and start flow: upload to `gcodes`,
retain the returned safe relative path, persist the claim, and call
`/printer/print/start`. The HTTP result must be `{"result":"ok"}`. Unexpected
responses or transport failures are uncertain outcomes, not successful starts;
reconciliation never resends the command. An unresolved start expires after
five minutes, including during disconnects.

Bambu retains the existing FTP plus MQTT `project_file` flow and print options.
Paho publish results are checked. `MQTT_ERR_NO_CONN` can still leave a QoS 1
message buffered, so that case is reconciled rather than treated as proof that
nothing was sent. The durable queue claim records the remote filename, submitted
subtask ID and acknowledgement deadline. An active matching subtask confirms
acceptance. Started notifications follow that confirmation, not local publish.

The watchdog retains the 90-second initial wait and up to 180 additional seconds
for slow firmware parsing. It now fails with an inspect-before-retry error rather
than returning the job to pending forever. Persisted deadlines recover lost
watchdogs after restart. Confirmation and timeout updates compare the dispatch
subtask identity, so an older watchdog cannot change a newer attempt or fail a
confirmed print. Confirmed modern claims are not treated as legacy work while
terminal lifecycle callbacks are pending. Older unmarked Bambu claims are recovered only with
fresh non-active telemetry after the grace period; an offline long-running print
is not declared failed just because its connection is down.

## Automated coverage

`backend/tests/unit/test_dispatch_pipeline_regressions.py` exercises real SQLite
persistence, `PrintScheduler`, `PrinterManager`, `BambuBackend`, `BambuMQTTClient`,
and `MoonrakerBackend`. Only printer network boundaries and external notification
effects are replaced. The QoS disconnect case uses real Paho without a socket.
Coverage includes both providers, terminal Klipper states, poison-job isolation,
overlapping queue passes, stale telemetry, publish failure, delayed acknowledgement,
restart recovery, timeout failure, and slice-worker claim loss/database failure.

Existing cancellation, SJF, plate-clear, transient-library, provider lifecycle,
watchdog, profile ownership, inheritance, revision-pinning and endpoint security
tests remain part of the complete suite. Profile tests cover missing defaults,
unknown compatibility, canonical names, tool/nozzle mismatches and both cloud
materialization paths. HTTP tests reject malformed successful-status responses.
Frontend tests exercise production readiness and acknowledgement invalidation.

Run the repository's standard checks (see `.github/workflows/ci.yml`):

```sh
ruff check backend/
ruff format --check backend/
python -m pytest backend/tests/ --tb=short --timeout=60 --timeout-method=thread -n auto
cd frontend
bun install --frozen-lockfile
bun run lint
bun x tsc --noEmit
bun run build
bun run test:run
```

CI also runs the Python suite in the deployment container, PostgreSQL camera-token
coverage, the production Docker build, imports, health/API smoke tests and static
asset serving. The PR records the actual run results, not assumed pass counts.

## Hardware verification

Use one small known-safe model and clear the bed before each test. Do not run
unattended. Retrying a job whose acknowledgement timed out requires inspecting
the printer and its history first.

1. On the configured 0.4 mm printer binding, select compatible process and
   filament profiles with defaults unset. Confirm Ready, successful slicing and
   retained nozzle/tool checks. Repeat with Bambu cloud and imported profiles.
   A genuine 0.6/0.4 mismatch must remain blocked. Unknown metadata must request
   acknowledgement and must not be auto-selected.
2. Submit to Klipper after a completed print, then after a cancelled print. Check
   the uploaded path, Moonraker acknowledgement and actual start. Recheck normal
   completion, cancellation and the existing plate-clear/manual-start settings.
3. Submit to Bambu. Check FTP transfer, the matching MQTT subtask entering an
   active state, and one started notification. Check the configured AMS, plate,
   calibration and timelapse choices were preserved.
4. Interrupt LayerCove after command submission and restart it. A matching active
   print must be adopted without another upload/start. An unconfirmed command
   must become a visible failure by the persisted deadline, never auto-replay.
5. Exercise unavailable credentials/connection and interrupted transfer. Confirm
   an actionable queue error without credentials in UI/logs, and verify another
   printer's queued job can still dispatch.

## Boundaries

No printer configuration, credentials, catalog migrations, new printer protocol,
or distributed worker architecture is introduced. Intentional pending conditions
(manual start, future schedule, offline printer, filament/plate-clear requirements)
remain pending. Existing legacy/shadow catalog rollout behavior is preserved;
enforced selections still receive server-side compatibility validation.

A claim marked `printing` is the durable reservation used to prevent duplicate
commands, not proof of physical motion. The dispatch acknowledgement event and
started notification indicate provider acceptance. Ambiguous physical outcomes
are never automatically retried. Live firmware, printer authentication, AMS and
actual mechanical printing still require the hardware checks above.
