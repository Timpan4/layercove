# Guided filament calibration

## Workflow

Open **Profiles**, then **Calibration**. Select a printer, its slicer printer profile, and a filament. The printer profile sets the nozzle diameter. A printer with only one matching profile has it selected automatically. Printer profiles are set up on the **Printers** page. Without one, you can still record results by hand, but you cannot generate tests.

The filament list starts with spools from the **Filament** inventory whose slicer preset is in the profile catalog. A spool matches a profile by its preset id or name. A built-in base name such as `Bambu PLA Basic` also matches its printer variants, such as `Bambu PLA Basic @BBL P1S`. Spools without a matching catalog profile are listed but cannot be selected. Profiles marked compatible with the chosen printer profile come first.

Calibration can only use active profiles. Local presets become active when they are imported or edited, because changing them already requires `settings:update`, the permission that review needs. Orca Cloud and Bambu Cloud syncs also become active while the account is not shared, because only its owner sees those profiles. Startup syncs local presets, so local revisions left waiting by older versions become active after an upgrade. An incremental Orca pull rebuilds the profiles it did not send from the content Orca last sent for them, so a profile Orca reverted stays reverted. The first Orca sync after upgrading to this version pulls a full snapshot, because older versions did not record that content. A revision someone rejected stays inactive. A rollback holds until the preset or cloud profile gets content that has no revision yet. When an owner without `settings:update` shares a cloud account, its revisions that were activated without review are deactivated and wait for review again.

Syncs of shared cloud accounts and the bundled standard catalog still wait for review. Those profiles are listed under **Waiting for approval** and cannot be selected yet, and a spool that matches only a waiting profile says so. Approve and activate the revision in **Profiles**, **Shared catalog** (`/profiles?tab=catalog`), then return to calibration. `settings:update` lets you review, activate, roll back, retire, freeze and resume profiles in shared accounts and your own. Another user's private account returns 404.

The steps run in order: temperature, flow rate, pressure advance, retraction, then volumetric flow. Advanced values stay visible and editable. When a step cannot generate or print a test, the page says what is missing.

You choose each result manually, including when you use a saved camera capture or an uploaded photo. There are no AI suggestions.

## Sessions

A session keeps its original filament revision, test ranges, setting limits, results, generation jobs, print queue items, and evidence.

- Changing a result clears later results and retires their generated tests.
- Changing a test range or generating a step again retires that step's previous test.
- A retired test is forgotten together with its print, and its library file moves to the library trash unless a pending or printing queue item still uses it. Photos of a retired test stay in the session but no longer show on the step. Photos taken before any test was generated stay on the step.
- Results and ranges cannot change while one of the affected tests is still generating.
- Concurrent edits return 409.
- If the filament profile gets a newer active revision, the session stops generating and saving until you choose **Use current filament version**. That keeps your results and ranges that fit the new limits, recomputes the limits, and retires all generated tests.
- If the filament profile is removed or deactivated, the session can still record results but cannot generate tests or save a calibrated copy.
- Saving creates an active calibrated copy of the filament through the existing catalog copy transaction. The original and its revision provenance are preserved. By default the copy is private: it goes into your own catalog account, and only you can calibrate or slice with it. Choose **Share with everyone on this installation** to save it as a local preset that every user can use instead. Without authentication there is only one user, so copies are always saved as local presets and the page does not offer the choice. Deleting a user deletes their private copies.
- Deleting a session removes its photos and retires its generated tests. Deleting a printer or a user does the same for each of their sessions, and is refused while one of their tests is still generating. Saved profile copies stay, except a deleted user's private copies.
- Photos are removed before the deletion is saved. If they cannot be removed, the request fails and the session stays, so the deletion can be retried.

## Sidecar requirements

The configured Rust Orca sidecar must support calibration protocol 1 and the pinned filament schema. It generates test geometry and slices with the checksum-pinned prebuilt Orca binary. Do not compile Orca from source. The printer, process, and filament selection uses the existing catalog binding and compatibility checks. Unsupported extrusion templates fail with an error.

## Test geometry and limits

- Temperature sections run hottest at the bottom and are `25 × nozzle diameter` mm tall.
- Flow tiles carry sample numbers starting at 1.
- Pressure advance and volumetric flow use 1 mm bands.
- Retraction uses 1 mm bands above a 0.4 mm base.

The UI explains the value-to-height mapping. The step size must reach the highest sample. Where available, LayerCove checks whole-degree temperatures, source setting bounds, the material's maximum temperature, reported nozzle limits, printable height, and volumetric XY speed limits. Missing source maxima are not replaced with guessed physical limits.

- Material maximum: a filament revision without `nozzle_temperature_range_high` uses the schema default only when it has no `inherits` parent. An inheriting profile gets its value from the parent, so the session applies no material cap and keeps the printer's reported nozzle limit.
- Printable height: before generating, LayerCove compares the band heights above with the printer profile's `printable_height`. This is a lower bound, because the sidecar may add a base or margins. A profile without a usable height leaves the check to the sidecar.

## Printing

Printing a test requires a current generated artifact, current printer telemetry, a confirmed matching nozzle, an idle printer, an empty queue, and plate and filament confirmation. AMS requires a Bambu printer and exactly one selected AMS slot, which must be loaded with the pinned filament type. Each new test needs a fresh plate confirmation. That confirmation also covers the queue's filament and nozzle check, so the print starts without a second confirmation on the queue page. If the queue's material check finds a blocking problem, printing fails with its reasons. The normal queue handles cancellation and printing status.

## Privacy and uploads

Sessions and photos are private to their user. Printer-scoped API keys cannot access private calibration sessions.

JPEG, PNG, and WebP uploads use the existing 10 MiB image limit before multipart spooling, Pillow's decoded-pixel protection, and PNG normalization that removes source metadata. Normalized files are also size-bounded and served with private, no-store caching.

## Verification without printing

Backend HTTP tests cover manual results, resume, copy preservation, invalidation, permissions, bounded evidence, generated artifacts, and dispatch to a fake Moonraker printer. The sidecar release gate slices all five tests into Bambu 3MF and Klipper G-code, and checks package integrity, checksums, and the temperature, pressure advance, paired retraction, and volumetric feedrate changes.

Artifact checks do not prove physical print quality or a safe final material limit. Calibrating hardware still needs a real print and human inspection.

For isolated browser verification:

1. Export `DATA_DIR=/tmp/layercove-calibration-preview-...` and the local sidecar URL in your shell, then start the backend on port 8001. The seed command below must see the same `DATA_DIR`.
2. Seed it:

   ```bash
   CALIBRATION_PREVIEW_SEED=1 uv run --with-requirements requirements.txt python -m backend.tests._fixtures.seed_calibration_preview
   ```

   The seed rejects other data directories and creates an inactive printer.
3. Point Vite at that backend on port 5174.
4. From `frontend`, run:

   ```bash
   CALIBRATION_E2E=1 LAYERCOVE_URL=http://localhost:5174 bun run test:e2e calibration.spec.ts
   ```

Never run this workflow against a real printer installation.
