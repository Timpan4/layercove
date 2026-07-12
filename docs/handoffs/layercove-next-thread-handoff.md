# LayerCove integration handoff

Updated: 2026-07-12 (Europe/Stockholm)

## Mission

Continue the LayerCove roadmap autonomously through epic
[#1](https://github.com/Timpan4/layercove/issues/1). Keep the root agent on
GitButler integration, review, CI, and merges. Delegate each implementation,
spec review, risk review, and test gate narrowly. Never claim visual, manual,
or hardware verification without evidence.

## Suggested skills

- `wayfinder` for roadmap and dependency orchestration.
- `ponytail` for the smallest correct implementation.
- `code-review` for independent spec and standards reviews.
- `github:gh-address-comments` for thread-aware PR feedback.
- `github:gh-fix-ci` for failed or cancelled GitHub Actions checks.
- `create-pr` for the GitButler PR, review, quiet-window, and merge loop.

## Repository and Git safety

- Workspace: `/Users/timpan4/dev/layercove`
- Checked-out branch: `gitbutler/workspace`
- GitButler virtual branch: `feat/provider-queue-lifecycle`
- Remote handoff branch:
  `origin/feat/provider-queue-lifecycle`
- Handoff code head before this documentation commit: `37653a9fd`
- Before every git write, run `git branch --show-current`.
- On `gitbutler/workspace`, use `but` for every git write. Never use raw
  `git add`, `commit`, `push`, `checkout`, `rebase`, `merge`, or `stash`.
- Never force-push or bypass force-push protection.
- Preserve unrelated untracked `uv.lock` (GitButler change ID `rw`). Do not
  commit or delete it without user authority.

## Completed roadmap

- #5 merged through PR #23.
- #6 merged through PR #24.
- #7 merged through PR #25.
- #8 merged through PR #26.
- #9 merged through PR #27.
- #10 merged through PR
  [#28](https://github.com/Timpan4/layercove/pull/28), merge commit
  `16218cebd70b67c1ae1d1e1fd07a99cf0b24b4b1`.
- Issues #5-#10 are closed and checked in epic #1.
- The obsolete `check-layercove-pr-23` heartbeat automation was deleted.

## Current issue: #11

Issue: [Integrate provider dispatch with queue, history, and
archives](https://github.com/Timpan4/layercove/issues/11).

The pushed branch contains these implementation and repair commits:

- `8ab68cc5a` — provider-aware queue lifecycle.
- `e18f1e5ad` — durable queued lifecycle transitions.
- `8f67c8919` — queued print notification parity.
- `e52378523` — safe Moonraker reconciliation and cancel intent.
- `37653a9fd` — durable queued-start reconciliation.

The branch implements:

- one provider split before the unchanged Bambu transport path;
- Moonraker upload with `start=false`, queue CAS, then exact returned-path
  start with no Bambu options and no ambiguous command retry;
- durable provider correlation/job identity through additive nullable queue
  fields and startup migrations;
- atomic exact-identity terminal CAS, with archive and history work only for
  the winning transition;
- queue-unique safe upload names in the form
  `queued-<UUID><original-gcode-suffix>`;
- persisted `start_reconcile_after` and scheduler-loop reconciliation that
  survives process restart;
- unavailable/offline/connecting/unknown state retention until authoritative
  connected evidence exists;
- durable pre-active cancel intent and exactly-once cancel dispatch;
- definitive completion preserved during finish-versus-cancel races;
- provider-neutral WebSocket, MQTT relay, notification, user-email, auto-off,
  library-usage, and same-day queue-count effects;
- raw G-code archive metadata preservation;
- Bambu FTP bytes, options, retry, watchdog, and cancel behavior kept on the
  existing path.

## Review history

Independent reviewers previously found and drove fixes for:

- Moonraker normalized state not dispatching;
- Bambu-only AMS/preheat/FTP/options leaking into Moonraker;
- non-atomic terminal finalization and duplicate history;
- delayed job-A events finalizing job B;
- upload failure overwriting concurrent cancellation;
- ambiguous start timeout being recorded as a definite failure;
- restart/bootstrap losing correlation;
- pre-active stop returning an error while a print could start later;
- filename-only recovery binding an unrelated same-name print;
- missing shared archive, notification, and cleanup effects;
- cancel intent rewriting a definitive completion.

The latest review wave requested the final four-file repair now committed as
`37653a9fd`. It still requires fresh independent re-review on that exact head.

## Validation evidence

Before `37653a9fd`:

- Focused: 48 passed.
- Relevant scheduler/manager/queue/lifecycle: 585 passed.
- Full backend: 6,909 passed, 3 skipped.
- Ruff backend, changed-file format check, and diff check passed.
- Only known warnings: 12 pre-existing pyftpdlib teardown warnings.

During the final repair wave:

- Focused: 54 passed.
- Relevant: 591 passed.
- One full `-n 10` run reported one unrelated parallel failure with 6,914
  passed and 3 skipped:
  `backend/tests/integration/test_library_slice_api.py::TestSliceArchiveReslicedBedType::test_bed_type_falls_back_to_source_when_missing_from_output`.
- That unchanged test passed 10/10 in isolation.
- A later validator ran 25 focused provider-dispatch tests successfully. Its
  relevant and full reruns were interrupted by the handoff request.

Do not call the branch merge-ready yet. Obtain a fresh independent relevant
and full gate after this handoff commit.

Relevant command:

```sh
uv run pytest -q \
  backend/tests/unit/test_scheduler_provider_dispatch.py \
  backend/tests/unit/test_scheduler_*.py \
  backend/tests/unit/services/test_printer_manager.py \
  backend/tests/unit/services/test_printer_manager_backends.py \
  backend/tests/unit/services/test_moonraker_backend.py \
  backend/tests/integration/test_print_queue_api.py \
  backend/tests/integration/test_print_lifecycle.py
```

Full gate:

```sh
uv run pytest -q -n 10 backend/tests
uv run ruff check backend
uv run ruff format --check \
  backend/app/api/routes/print_queue.py \
  backend/app/core/database.py \
  backend/app/main.py \
  backend/app/models/print_queue.py \
  backend/app/services/moonraker_backend.py \
  backend/app/services/print_scheduler.py \
  backend/app/services/printer_manager.py \
  backend/tests/unit/services/test_moonraker_backend.py \
  backend/tests/unit/services/test_printer_manager_backends.py \
  backend/tests/unit/test_scheduler_provider_dispatch.py
git diff --check 16218cebd..HEAD
```

The full-repository Ruff format check has one pre-existing unrelated failure
in `backend/tests/unit/test_printer_provider_migration.py`. Issue #11 changed
files formatted cleanly in prior checks.

## Immediate next steps

1. Independently re-review the exact pushed head for spec and
   correctness/concurrency. Verify:
   - restart after queue CAS with the provider idle;
   - offline/unknown first reconciliation, then matching active;
   - eventual connected-idle definitive failure;
   - same original filename cannot bind an unrelated external job;
   - completed-after-cancel stays completed;
   - failed-after-cancel records cancelled exactly once.
2. Run the relevant and full backend gates above. Treat the isolated library
   slice failure as unrelated only if it remains isolation-green and the full
   rerun is otherwise green.
3. Address any actionable review finding with the same narrow worker, commit
   through GitButler, and repeat both reviews.
4. Only when reviews and tests are clean, create a ready PR with
   `but pr new feat/provider-queue-lifecycle` and `Closes #11`.
5. Inspect top-level comments, requested changes, thread-aware unresolved
   reviews, and required checks. Inspect CI logs only for failed/cancelled
   checks.
6. After all required gates are green and five minutes have passed since the
   latest PR activity, merge with the expected head SHA.
7. Verify #11 closed, check #11 in epic #1, run `but pull`, then map #12.

## Human-only #11 gate

Do not claim this gate without evidence. Against fake Moonraker:

1. Queue known raw G-code; pause upload and verify pending state, exact bytes,
   and safe unique basename.
2. Return a different safe remote path; verify exactly one start request uses
   that path.
3. Confirm no Bambu fields, FTP calls, credentials, or raw authorization
   values appear in requests.
4. Exercise completed, failed, cancelled, duplicate, and competing terminal
   events; verify exactly one queue/archive/log result and all shared effects.
5. Restart while the queued job is active; terminal must finalize the exact
   row.
6. Exercise timeouts where start landed and did not land. Disconnected or
   unknown state must not falsely fail.
7. Start an unrelated external job after a timed-out queued start; it must not
   consume the queued binding.
8. Stop immediately after DB claim but before provider active; cancel must
   dispatch once when active and must not leave a print running.
9. Verify plate-clear disabled permits the next job and enabled blocks until
   acknowledgement.
10. Save redacted request logs, API responses, queue/archive/log IDs, and
    screenshots.

No physical-printer verification has been performed. Issue #19 owns the
supervised hardware gate.

## Remaining roadmap

- Agent-executable: #11, #12, #13, #14, #15, #17.
- Human/final evidence: #16 visual and brand sweep, #18 upgrade/deployment
  validation, #19 physical Bambu and Klipper/Voron validation.
- Follow live issue dependency links and epic #1. Do not start a blocked issue
  early.
