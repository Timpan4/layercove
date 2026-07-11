# LayerCove multi-backend architecture audit

**Status:** Phase 1 planning baseline (2026-07-11)

## Scope and repository identity

This audit covers the current checkout of `Timpan4/layercove`, a GitHub fork of
`maziggy/bambuddy`. The default branch is `main`. Local `origin` points to the
LayerCove fork and `upstream` already points to Bambuddy. The checkout uses the
`gitbutler/workspace` branch, so repository writes must use GitButler.

No repository-local `AGENTS.md` or `CLAUDE.md` exists. `CONTRIBUTING.md` is the
local contribution contract. KubeCove's agent guide, development workflow,
issue-tracker rules, triage vocabulary, domain-doc rules, and PR checklist were
read only as process references. LayerCove work stays in this repository.

## Current architecture

### Printer persistence and API

- `backend/app/models/printer.py` models every printer with a required unique
  Bambu serial number, IP address, and access code. It has no provider field.
- `backend/app/schemas/printer.py` repeats those assumptions in create, update,
  response, and validation shapes. Secret omission is already permission-aware.
- `backend/app/core/database.py` performs additive, startup-time SQL migrations
  through guarded `ALTER TABLE` statements rather than Alembic revisions.
- `backend/app/api/routes/printers.py` combines generic CRUD/status routes with
  Bambu-only MQTT logging, AMS, calibration, firmware-derived controls, plate,
  storage, jog, skip-object, and command endpoints.

### Connection and status lifecycle

- `backend/app/services/printer_manager.py` is the process-wide façade used by
  routes, scheduler, WebSockets, metrics, inventory, Spoolman, notifications,
  camera, support bundles, and startup.
- Its `_clients` map is typed and instantiated as `BambuMQTTClient`; connection,
  staleness, state, commands, and event callbacks therefore assume MQTT.
- `backend/app/services/bambu_mqtt.py` contains a large, mature Bambu protocol
  implementation. Its `PrinterState` includes useful common fields but also AMS,
  Bambu stages, firmware, trays, HMS, tool racks, and raw MQTT data.
- `printer_state_to_dict()` in `printer_manager.py` is both a Bambu mapper and
  the WebSocket/REST response builder. It should remain the Bambu adapter's
  serializer during migration, not become the generic domain model.
- `backend/app/core/websocket.py` and `backend/app/api/routes/websocket.py`
  already provide the application-to-frontend event channel. Provider backends
  should feed this path; Moonraker should not create a second frontend socket.

### Upload, start, queue, history, and archive

- `backend/app/services/bambu_ftp.py` owns Bambu FTP/FTPS file operations and
  model-specific TLS behavior.
- `backend/app/services/print_scheduler.py` directly uploads through Bambu FTP,
  starts through `PrinterManager.start_print()`, and passes plate, AMS, Bambu
  calibration, timelapse, and nozzle options unconditionally.
- `backend/app/models/print_queue.py` persists Bambu options on every queue item.
  These columns must remain for compatibility; future generic/provider options
  should not overload them.
- Queue lifecycle, notifications, WebSocket toasts, history, archive promotion,
  retry/watchdog behavior, and cleanup are valuable generic application logic,
  but dispatch and printer-state tests must characterize them before extraction.
- Archive metadata and filename cleanup commonly strip `.3mf` and
  `.gcode.3mf`. Normal `.gcode` must become an explicit supported artifact.

### Slicing and profiles

- `backend/app/services/slicer_api.py` is an HTTP client for the inherited
  slicer sidecar and passes selected printer/process/filament profile JSON.
- `backend/app/services/slice_dispatch.py` manages in-memory slice jobs and is
  destination-agnostic, but generated output naming and surrounding route/UI
  assumptions are Bambu-oriented.
- The sidecar is deployed separately from this repository (`slicer-api/` holds
  Compose/docs only). Its exact output-format contract must be verified before
  coding Klipper slicing.
- Frontend slicing and print modals already provide mobile workflows, profile
  selection, printer selection, plate selection, AMS mapping, and Bambu print
  options. Capability gating should reshape these screens instead of cloning
  them per provider.

### Frontend

- `frontend/src/api/client.ts` is the large typed API boundary. `Printer`,
  `PrinterCreate`, and `PrinterStatus` are Bambu-shaped.
- `frontend/src/pages/PrintersPage.tsx` is an oversized all-in-one printer UI
  with many direct AMS, firmware, plate, temperature, speed, camera, and Bambu
  state assumptions.
- Shared print controls live under `frontend/src/components/PrintModal/`, but
  its data types assume plate and AMS options are universal.
- React Query plus the existing application WebSocket provides state updates.
  No separate frontend store framework is present or needed.
- PWA assets exist under `frontend/public/`; `manifest.json` and
  `frontend/index.html` visibly identify Bambuddy.

### Tests, CI, and deployment

- Backend uses pytest with extensive unit and integration coverage, including
  focused Bambu MQTT, FTP, printer manager, scheduler, archive, slicing,
  filename, safe-path, URL-safety, SSRF, and migration tests.
- Frontend uses Vitest/Testing Library and has printer page, print modal, slice
  modal, WebSocket, PWA-related component, and mobile-hook coverage.
- CI runs Ruff, backend pytest shards, ESLint, TypeScript, Vitest, frontend
  production build, Docker test shards, production image smoke checks, and
  Compose integration tests.
- Docker service, image, container, volumes, data paths, environment examples,
  installers, static bundles, and update tooling retain Bambuddy identifiers.
  Cosmetic identifiers can change later; compatibility identifiers need aliases
  or documented retention.

## Bambu-specific assumption inventory

| Assumption | Important locations | Boundary needed |
| --- | --- | --- |
| Every printer has serial/access code/IP | printer model, schemas, CRUD routes, discovery | provider field plus provider-specific nullable configuration and secret-safe response |
| MQTT is status and command transport | printer manager, Bambu MQTT, routes, scheduler, startup, metrics, integrations | backend lifecycle/status/command contract behind manager |
| FTP/FTPS is file transport | Bambu FTP, printer file routes, scheduler, diagnostics | backend upload/file operations; retain Bambu file browser separately |
| State names are Bambu `RUNNING`, `PAUSE`, `FINISH`, etc. | manager, scheduler, main lifecycle callbacks, frontend | normalized state enum plus preserved provider detail |
| Jobs are `.3mf`/`.gcode.3mf` | slicer client/routes, library, archive, queue, preview, notifications | artifact kind/output format and `.gcode` handling |
| Plate selection applies to start | queue model, scheduler, print modal, plate picker | `plate_selection` capability and Bambu start options |
| AMS/mapping applies to dispatch | queue, scheduler, inventory, Spoolman, print modal, printer page | `ams`/`multi_material` capabilities; Bambu-only mapping data |
| Bambu calibration/timelapse/nozzle options apply | queue, scheduler, MQTT start command, print modal | typed Bambu start options owned by Bambu backend |
| Firmware/HMS/K-profiles/tool racks are universal | routes, API types, printer page, settings | Bambu capability panels/endpoints |
| Archive/plate-clear behavior applies to all | manager, scheduler, main callbacks, archive services | generic lifecycle policy with provider-specific completion mapping |
| Camera comes from Bambu or external camera | camera routes/services, printer model, UI | generic camera capability using configured external/Moonraker URLs |
| Slicer output targets Bambu profiles/packages | slice routes/client/modal and sidecar contract | explicit destination output contract using selected Orca profiles |

## Smallest maintainable seam

Keep `PrinterManager` as the application façade so existing callers and Bambu
behavior do not move. Replace only its stored-client boundary with a narrow
`PrinterBackend` contract and registry. First adapter wraps existing Bambu MQTT
and FTP behavior. Provider-specific routes may still obtain a typed Bambu
adapter; generic routes and scheduler must not obtain raw MQTT clients.

Introduce only capabilities used by the MVP UI/application:

- `upload_gcode`, `upload_3mf`, `start_print`, `pause`, `resume`, `cancel`
- `emergency_stop`, `camera`, `bed_temperature`, `extruder_temperature`
- `chamber_temperature`, `ams`, `plate_selection`, `speed_control`
- `firmware_information`, `object_cancellation`

Add more flags only with a current consumer. Do not model every potential
Klipper or Bambu feature up front.

Use a normalized snapshot with `connected`, normalized `state`, message,
filename, progress, elapsed/remaining seconds, layers, common temperatures,
and opaque provider detail. Preserve `PrinterState` and current response fields
inside the Bambu adapter until consumers move safely.

Split scheduler dispatch at one point:

1. Resolve artifact and provider backend.
2. Validate artifact against capabilities.
3. Upload with provider-owned transport.
4. Start with provider-appropriate options.
5. Rejoin existing queue/history/notification lifecycle.

This avoids scattered `provider == "moonraker"` checks and preserves mature
Bambu code.

## Security boundaries

- Store Moonraker credentials encrypted using the existing application secret
  handling; never return them in default printer responses or support bundles.
- Treat onboarding URLs as administrator configuration, not browser-controlled
  request targets. Reuse and extend existing URL/SSRF guards, pin redirects to
  the approved origin, validate schemes, and bound timeouts/body sizes.
- Keep TLS verification per printer and default it on. Never modify global TLS.
- Sanitize upload basenames with existing filename/safe-path helpers and reject
  path components before calling Moonraker.
- Expose emergency stop as a dedicated guarded action with explicit UI
  confirmation, permission check, audit context, and no generic G-code console.
- Browser connects only to LayerCove. LayerCove connects to Moonraker on trusted
  operator-configured networks; Tailscale/Cloudflare are optional deployment
  choices, not bundled requirements.

## Characterization tests required before adapter work

1. Manager connection/disconnection and callback forwarding around a fake
   `BambuMQTTClient`.
2. Bambu status serialization for active/paused/idle, temperatures, AMS,
   capabilities presently inferred from model, and plate-clear state.
3. Scheduler Bambu FTP upload path, remote filename, cleanup, and
   `start_print()` options.
4. Pause/resume/cancel route-to-MQTT command mapping.
5. Queue transition and watchdog behavior for success, rejected start, and
   mid-dispatch cancellation.
6. Archive/history completion and failure callbacks.
7. Existing printer migration/default behavior and secret omission.
8. Frontend rendering of current Bambu card, AMS controls, plate selector, and
   print options from the eventual capability set.

## Phase plan and gates

1. **Foundation:** migration/provider configuration, normalized models,
   capabilities, registry, Bambu adapter, characterization tests.
2. **Moonraker MVP:** safe HTTP/WebSocket clients, reconnect, status mapping,
   upload/start/pause/resume/cancel/emergency stop, onboarding, fake server.
3. **Product integration:** `.gcode` slicing destination, queue/history/archive,
   capability-driven responsive UI, camera.
4. **Identity:** LayerCove user-facing branding, compatibility aliases, original
   assets, README, rebranding/upstream docs.
5. **Hardware validation:** one Bambu and one Klipper/Voron printer. Hardware
   validation cannot be claimed by CI fixtures.

Do not start Moonraker UI or broad branding edits until the foundation ADR and
Bambu regression baseline are accepted.

Architecture and security review, followed by repository-owner approval,
accepted this foundation on 2026-07-11.
