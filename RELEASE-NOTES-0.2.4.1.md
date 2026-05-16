  **Bambuddy v0.2.4.1**

⚠ **Upgrade Notes — Read Before Updating**

Almost everyone is upgrading from 0.2.4. 0.2.4.1 is a patch release: stability and correctness fixes built on the same code base as 0.2.4, no schema breaks, no Docker entrypoint changes, no Vite/proxy quirks. The in-app Apply Update button in Settings → System → Updates resolves to the latest stable tag and works for all users — no flags needed.

Make a backup before upgrading via Settings → Backup → Create Backup. Native install with update.sh snapshots the database automatically and rolls back on failure. Docker and fully-manual paths don't.

**Docker**

docker compose pull
docker compose up -d

docker-compose.yml doesn't need refreshing — none of the entrypoint, volume, or env-var conventions changed since 0.2.4.

**Native install — recommended path**

sudo BRANCH=main /opt/bambuddy/install/update.sh

**Native install — manual path**

sudo systemctl stop bambuddy
cd /opt/bambuddy
sudo -u bambuddy git fetch origin --tags
sudo -u bambuddy git checkout main
sudo /opt/bambuddy/venv/bin/pip install -r requirements.txt
sudo systemctl start bambuddy

**Behaviour changes to know about**

- Reprint stats are now per-event, not per-archive. Re-printing a file no longer overwrites the source archive's totals; Quick Stats and the per-archive Print Log gain an orange N prints badge with a per-run breakdown (successful + failed). If you already had a reprint that overwrote stats in 0.2.4, the existing archive row keeps its current numbers — but every new print event from 0.2.4.1 onward writes a separate PrintLogEntry, so totals start adding correctly again. (#1378)

- Pending queue items for soft-deleted archives are now auto-cancelled. Soft-deleting an archive (default delete path) removes its files from disk, which makes any pending queue item pointing at it un-dispatchable. From 0.2.4.1 those items get status=cancelled + waiting_reason="Source archive deleted" so you see why the queue item disappeared from pending instead of finding it silently stuck. (#1348 follow-up)

- i18n parity check now blocks English-leak in non-English locale files. The build's parity step (npm run build) now fails CI when a non-English locale entry equals the English source unless explicitly allow-listed as a cognate. 2,377 accumulated English fallbacks across 7 locales were translated in this cycle as the underlying cleanup. No user-visible change today — just no more "Advanced" buttons in your German UI from new keys going forward.

---

**Highlights**

0.2.4.1 closes correctness gaps that hit power-users running queues, reprints, and Obico fault detection at the same time. The three biggest are: per-event stats aggregation so reprints add to Quick Stats instead of overwriting (#1378), camera stream no longer freezes when Obico polls the same printer (#1348, reported by @SL666), and multi-color archive cost now charges untracked AMS slots at the default rate instead of reporting near-zero (#1344, reported by @nicktags). Around them: AMS slot configuration that survives Reset Slot on A1 Mini BMCU / P1S Standard AMS, MakerWorld URL import, queue/VP-dispatched prints finally getting layer timelapse, plate detection respecting the external camera setting, firmware checks staying alive when bambulab.com Cloudflare-blocks the page, LDAP manual provisioning, and a narrow API-key permission for the Home Assistant dynamic-tariff integration.

Plus a deep i18n debt cleanup — 2,377 strings translated across 7 locales — and mechanical CI enforcement so the debt can't accumulate again.

---

**New Features**

- Manual LDAP user provisioning from the UI (#1298) — Add LDAP users into Bambuddy without waiting for their first login. Pre-create groups, permissions, and inventory ownership before the user even authenticates once.

- Build-plate override in the SliceModal (#1337) — Pick which build plate (Cool / Cool SuperTack / Engineering / High Temp / Textured PEI / Smooth PEI) to slice for, independent of the source 3MF's embedded plate. The slice respects the override end-to-end (sliced output is bound to the chosen plate, archive metadata records it, printer card thumbnail matches).

- API Keys: narrowly-scoped "Update electricity price" toggle (#1356) — New per-key permission flag exposes a single endpoint POST /api/v1/settings/electricity-price that accepts {"energy_cost_per_kwh": <float>}. Closes the gap where the wiki documented a Home Assistant dynamic-tariff rest_command example that was never deliverable (every key with general SETTINGS_UPDATE is hard-denied for security). The new flag does NOT widen general settings-write access — the broader PATCH /settings route remains denied. Wiki updated; existing keys default off.

- Per-archive Print Log view + clickable "N prints" badge (#1378 follow-up) — Every archive card with more than one print event shows an orange N prints badge with a hover-tooltip breakdown (successful vs failed). Click it (or use the context-menu entry) to open a print log dialog showing every print event for that archive — date, status, duration, filament, cost — with failure_reason text under failed runs. Also embedded as a section at the top of the Edit Archive modal so the history is one click away.

---

**Improved**

- Reset Slot on A1 Mini BMCU / P1S Standard AMS no longer deadlocks Assign Spool (#1322, reported by @RosdasHH) — The empty-detection that gated ams_filament_setting was too cautious; now only short-circuits on state ∈ {9, 10} (firmware's explicit "no spool" codes) so the post-Reset-Slot "spool inserted, state=3, tray_type empty" case fires MQTT and configures the slot. Same Reset Slot click that previously sat in pending state forever now lands cleanly.

- Multi-color archive cost now tops up untracked AMS slots at the default rate (#1344, reported by @nicktags) — A 110 g multi-color print with only one of four trays mapped to inventory used to show $0.01 instead of ~$1.10. Untracked slots now charge at the global default filament cost. Fully-tracked prints are unchanged.

- Plate-detection calibration captures from the configured external camera (#1359, reported by @Andlar94) — On printers with an external RTSP / go2rtc camera enabled, calibration was previously sourcing the reference frame from the built-in chamber camera while the runtime check used the external one — guaranteeing a "Build plate not empty" false-positive on every print. Both paths now share the same external-camera default, with a backend-side derivation so future callers can't drift again.

- Layer timelapse now starts for queue / VP-dispatched prints (#1353, reported by @Andlar94) — The timelapse start_session() call was only on the new-archive code paths. Queue dispatches and VP-dispatched reprints landed on the expected-archive branch and silently lost timelapse. The expected-archive branch now mirrors the same gate.

- Firmware update dialog survives Cloudflare-blocked / transient outages on bambulab.com (#1350, reported by @K1ngJony) — Adds honest browser-like Accept / Accept-Language headers alongside the existing Bambuddy/1.0 UA, persists the resolved buildId to disk (so a single bambulab.com 403 doesn't permanently break download-URL resolution for that session), retries once on 404 (Bambu rebuilt the page), and shows an honest error message when the download endpoint truly can't be reached.

- Subtype dropdown on the Add/Edit Spool form offers CF and GF (#1345) — Adding a third-party PETG-CF / PLA-CF spool no longer requires typing the variant by hand.

- Page-header visual style unified across the app (PR #1272 by @EdwardChamberlain) — Every page now uses the same icon-aligned heading shape.

- OIDC provider icons proxied server-side (PR #1342 by @netscout2001) — Icon fetches no longer expose the issuer's URL via browser request logs / DNS.

- Auto-print start G-code now fires after the printer reaches RUNNING, not before (#1304) — The first RUNNING transition after Bambuddy boots no longer fires an unrelated print-start; users with custom G-code injection get their snippets at the actual start of each print, not the boot of the daemon.

- i18n parity gate now enforces real translations in every locale, not English fallbacks — frontend/scripts/check-i18n-parity.mjs gains a new Check 4 that fails CI when a non-English leaf equals its English source unless explicitly allow-listed as a cognate. The 2,377 accumulated English fallbacks across the 7 non-English locales were translated as the underlying cleanup. Going forward, "English fallbacks per project convention" is not a thing — new keys must be translated in every locale or explicitly added to the per-locale IDENTICAL_TO_EN_ALLOWED cognate list.

- Support bundle records more application state — Adds OIDC providers + 2FA / API key / long-lived token counts, library / inventory / queue / maintenance totals, slicer-API CLI versions, GitHub backup status, per-printer Obico flag. Redacts two settings that were previously included in cleartext and fixes a reachability-check architecture bug. Future triage rarely needs a follow-up "can you also send X" round-trip.

---

**Fixed**

**Stats / Archives / Print Log**

- Reprints (including failed and cancelled ones) no longer overwrite the source archive's statistics (#1378, reported by @IndividualGhost1905) — Statistics are now event-based, not file-based. The existing PrintLogEntry table gains six columns (archive_id, cost, energy_kwh, energy_cost, failure_reason, created_by_id); /archives/stats and /metrics sum from it. Each print completion writes a new row with the run's actual filament / time / cost / energy / status. The cost overwrite at
  usage_tracker.py:633 and energy overwrite at main.py:3625 now both preserve the source archive's first-run values on reprints; the run's actuals are stored on the PrintLogEntry row instead.

- Partial prints record accurate run filament (#1378 follow-up) — Failed / cancelled / stopped reprints no longer record the source archive's slicer estimate verbatim. New _compute_run_filament_grams helper prefers sum of tracked spool deltas, then falls back to estimate × progress%, then None — captured in 14 unit tests across every combination of status × inventory-tracked.

- Print log no longer 404-storms thumbnails for entries whose archive was deleted or whose print failed before extraction (#1348 follow-up) — Two-part fix: route self-heals on first 404 (NULL the cached path on the entry so subsequent renders skip the request) + eager NULL at archive-delete time so future deletes don't fire the one-time storm.

- Soft-deleted archive no longer leaves linked queue items silently stuck in pending forever (#1348 follow-up) — Pending queue items pointing at soft-deleted archives are now cancelled at delete time with waiting_reason="Source archive deleted". Queue API also suppresses the cached archive thumbnail / name / metadata when deleted_at is set, and the queue page's /plates query is gated on a new archive_deleted flag — three 404s per orphaned queue row are now zero.

**Camera**

- Camera stream no longer freezes every ~30s when Obico fault detection is enabled on the same printer (#1348, reported by @SL666) — Obico's _capture_frame was reusing the fan-out broadcaster's buffered frame when available, but falling through to a competing RTSP socket in race windows where the buffer was momentarily empty (stream startup, mid-reconnect). On X1-class firmware that allows only one camera connection, that second socket kicked the live viewer. New is_stream_active() helper now gates the fresh-socket fallback independently of the buffer state — when a viewer is connected, Obico never opens a competing socket.

**AMS / Inventory**

- Bare-tray empty-slot signal on P1S / A1 Mini (#1322 follow-up) — Genuinely-empty AMS slots on these printers send {"id": N} only (no state, no tray_type). The AMS parser now promotes this shape to state=9 so the inventory route's state ∈ {9, 10} short-circuit fires and we don't waste an ams_filament_setting publish that firmware would silently drop.

- AMS slot configuration lands cleanly for spools with no k-profile — The "configure" call no longer 422s when the spool's filament has no calibration profile entry. Affects a long tail of third-party / generic-PLA spools.

- AMS slot configuration lands on firmwares that never report state=11 (#1322 follow-up) — Some older firmwares never report the literal state=11 for loaded; the configure path's gate was too strict. Now treats absence of explicit empty (state ∈ {9, 10}) as loaded.

- Spool removal from AMS on X1C firmware that reports power_on_flag=False while idle (#1365, reported by @an3k) — Empty-slot detection now narrows the skip to zero-bits + power_on_flag=False (the shutdown shape from #765) instead of any power_on_flag=False. Spool pulls between prints now register without a manual Reconnect.

- AssignSpoolModal sits above the mobile sidebar drawer (#1336) — z-index fix; clicking Assign on mobile no longer opens the modal behind the drawer.

- Catalog color's gradient + effect now applied, not just hex (#1340) — Picking a Bambu Lab gradient or sparkle entry from the colour picker now copies all three colour properties.

- Storage location persists for internal spools (#1291) — Local-mode inventory now writes the storage_location field on save (was Spoolman-only).

**Spoolman**

- AMS-HT range allowed in slot-assignment table (#1274) — The ams_id upper bound was hardcoded at 4; AMS-HT extends the range. Now matches the parser's range.

- External-spool ams_filament_setting uses global tray_id (#1279) — Was sending the local slot ID for external spools; firmware rejects.

- Persist color_name edits without round-tripping the subtype synth fallback (#1319) — Editing the colour name on a Spoolman spool no longer reverts after the next AMS push.

- Restore Spoolman spool ID search + Unassign button (#1336) — Two regressions from the Spoolman inventory UI work that landed in 0.2.4.

- Resolve -1 in ams_mapping to external spool (#1276) — Bambu's multi-color slicer convention; the queue dispatcher now interprets it correctly.

- Per-print 3MF tracking is the only weight writer (#1119) — Removes a competing path that double-wrote weights in Spoolman mode.

- External library lookup filtered by Bambu Lab manufacturer (PR #1330 by @ojimpo) — Stops cross-manufacturer matches polluting the Bambu library picker.

**Virtual Printer / Slicer**

- VP cache preserves AMS / vt_tray / net.info across incremental push_status updates (#1371, reported by @Andlar94) — Slicer no longer needs a printer power-cycle to see AMS info on a queue-mode VP. The bridge's _latest_print_state cache now preserves a small set of sticky keys (ams, vt_tray, ams_extruder_map, mapping, net, ipcam, lights_report) when an incremental push omits them — mirrors what Bambuddy already does for its own internal state.raw_data.

- VP emits FINISH after FTP upload so Print-flow slicers un-wedge (#1280) — BambuStudio's Print-flow path waits for FINISH before clearing its upload progress UI.

- VP broadcasts archive_created so Archives page refreshes live (#1282) — Slicing through the VP now updates the open Archives page without a manual refresh.

- VP queue-mode honours workflow default print options (#1235) — VP-dispatched prints now pick up the user's "Auto-Print start gcode" / "Auto-Off" / etc. defaults consistently.

- Slicer bundle import logs the sidecar's reject reason (#1312 follow-up) — Failed .bbscfg imports now show the upstream error in the Bambuddy log so users can diagnose without curling the sidecar.

**Scheduler / Dispatch**

- Watchdogs no longer falsely treat FINISH → IDLE as "print landed" (#1370, reported by @Martinnygaard) — Queue items dispatched onto a printer that was in FINISH (un-dismissed "Print complete" prompt from a prior job) used to stay stuck at printing forever. The post-dispatch verifier now narrows the "command landed" check to an allow-list of active-print states (PREPARE / SLICING / RUNNING / PAUSE).

- First RUNNING after Bambuddy boots no longer fires a phantom print-start (#1304) — Cold-boot of Bambuddy onto a printer that's mid-print no longer creates a stray archive at the boot moment.

**Camera**

- Plate-detection UI uses the external camera when configured (#1359) — Above under Improved.

- Layer timelapse for queue/VP-dispatched prints (#1353) — Above under Improved.

- Camera fan-out broadcaster buffered frame shared with Obico + /camera/snapshot (#1271) — Reuse path landed in 0.2.4; this cycle's #1348 fix completes the race-free version. Listed for completeness.

**Notifications / Backups**

- Discord webhook accepts legacy discordapp.com URLs (#1363, reported by @mrfoureyed) — Discord's Copy Webhook URL button still emits the legacy hostname; validation now accepts either.

- Backup tab indicator dot for scheduled backups (PR #1338 by @chanakyan-arivumani) — Visual cue when a backup is queued.

**Auth / LDAP / OIDC**

- Manually-assigned groups preserved across LDAP logins (#1292) — LDAP user re-login no longer wipes admin-assigned group memberships.

- Orphan OIDC / MFA rows cleaned up when user is deleted (PR #1295 by @netscout2001) — Deleting a user now cascades to their OIDC binding + TOTP secret rows.

- Password rules shown in user-create form + FE/BE checks aligned (#1303) — Frontend rejected passwords the backend would accept and vice versa; now both apply the same rules and the form shows them.

- External-scan STL thumbnails deferred + Path coerced (#1299) — External library scans no longer block on STL thumbnail rendering; mountpoints expressed as strings work alongside Path objects.

- MakerWorld settings link points to /profiles (#1300) — The "Open Cloud settings" link from the MakerWorld page now goes to the right tab.

**UI / Misc**

- Smart-plug live wattage rounded to whole watts on the printer card (#1266, reported by @Carter3DP) — Plugs reporting fractional watts (ESPHome / HA-bridged) no longer overflow the card.

- Settings UI rendering fields exposed without requiring SETTINGS_READ (#1293) — Non-admin users with narrower scopes can now load the Settings UI; the rendering-only fields (theme, locale) are no longer gated on admin-tier read.

- Bed-jog Z direction inverted on A1 / A1 Mini bed-slingers (#1334) — Up was down on bed-slinger printers; now matches the physical motion.

- Usage tracker: skip remain% fallback for trays not used by the print (#1269, reported by @maugsburger) — Swapping spools in unrelated AMS slots mid-print no longer charges the original spool the full estimate.

- Soft-deleted archives keep their Quick Stats contribution (#1343) — Was already there for archive-level totals; this release locks it in via the new PrintLogEntry event aggregation (#1378) which references log entries by ON DELETE SET NULL, so the contribution survives even a hard delete.

- scan_timelapse picked stale video at false offset (#1278) — Resolved.

---

**Security**

- urllib3 floor raised to 2.7.0 to clear CVE-2026-44431 and CVE-2026-44432. urllib3 is a transitive dependency (none of Bambuddy's top-level deps require >=2.7.0 yet), so the resolver was silently keeping the vulnerable 2.6.x line. requirements.txt now carries an explicit urllib3>=2.7.0 pin.

- Bandit suppression syntax corrected on two verify=False calls in support.py — the two local-sidecar reachability probes used # noqa: S501 (ruff syntax, ignored by bandit) instead of # nosec B501. The probes themselves are unchanged (no payload, no secrets — health-check only) but the local security scan now passes cleanly without false-positive high-severity findings.

---

**Contributors**

Big thanks to everyone who shipped code or filed reproducible bug reports this cycle:

Code: @netscout2001, @EdwardChamberlain, @chanakyan-arivumani, @ojimpo, @maziggy

Reproducible bug reports: @IndividualGhost1905, @SL666, @nicktags, @Andlar94, @RosdasHH, @an3k, @K1ngJony, @Martinnygaard, @Fuechslein, @mrfoureyed, @maugsburger, @Carter3DP

(See CHANGELOG.md for the full per-fix detail.)
