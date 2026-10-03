# Guided filament calibration

## Workflow

Open **Profiles**, then **Calibration**. Select a printer, an active filament revision, and the installed nozzle diameter. The steps run in order: temperature, flow rate, pressure advance, retraction, then volumetric flow. Advanced values stay visible and editable.

You choose each result manually, including when you use a saved camera capture or an uploaded photo. There are no AI suggestions.

## Sessions

A session keeps its original filament revision, test ranges, setting limits, results, generation jobs, print queue items, and evidence.

- Changing a result clears later results and invalidates dependent artifacts.
- Changing a test range retires that step's artifact.
- Concurrent edits return 409.
- Saving creates an active calibrated copy of the filament through the existing catalog copy transaction. The original and its revision provenance are preserved.

## Sidecar requirements

The configured Rust Orca sidecar must support calibration protocol 1 and the pinned filament schema. It generates test geometry and slices with the checksum-pinned prebuilt Orca binary. Do not compile Orca from source. The printer, process, and filament selection uses the existing catalog binding and compatibility checks. Unsupported extrusion templates fail with an error.

## Test geometry and limits

- Temperature sections run hottest at the bottom and are `25 × nozzle diameter` mm tall.
- Flow tiles carry sample numbers starting at 1.
- Pressure advance and volumetric flow use 1 mm bands.
- Retraction uses 1 mm bands above a 0.4 mm base.

The UI explains the value-to-height mapping. The step size must reach the highest sample. Where available, LayerCove checks whole-degree temperatures, source setting bounds, the material's maximum temperature, reported nozzle limits, printable height, and volumetric XY speed limits. Missing source maxima are not replaced with guessed physical limits.

## Printing

Printing a test requires a current generated artifact, current printer telemetry, a confirmed matching nozzle, an idle printer, an empty queue, and plate and filament confirmation. AMS requires a Bambu printer and exactly one selected AMS slot, which must be loaded with the pinned filament type. Each new test needs a fresh plate confirmation. The normal queue handles cancellation and printing status.

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
