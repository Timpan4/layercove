# Guided filament calibration

Open Profiles, then Calibration. Select a printer, an active filament revision, and the installed nozzle diameter. Results follow temperature, flow rate, pressure advance, retraction, then volumetric flow. Advanced values stay visible and editable. Results are chosen manually, including when using a saved camera capture or uploaded photo. There are no AI suggestions.

Sessions retain their original filament revision, test ranges, setting limits, results, generation jobs, print queue items, and evidence. Changing a result clears later results and invalidates dependent artifacts. Changing a test range retires that step's artifact. Concurrent edits return 409. Saving creates an active calibrated filament copy through the existing catalog copy transaction. It preserves the original and its revision provenance.

The configured Rust Orca sidecar must support calibration protocol 1 and the pinned filament schema. It generates test geometry and slices with the checksum-pinned prebuilt Orca binary. Do not compile Orca from source. The printer/process/filament selection uses the existing catalog binding and compatibility checks. Unsupported extrusion templates fail with an error.

Temperature sections run hottest at the bottom and are `25 × nozzle diameter` mm tall. Flow tiles carry sample numbers from 1. Pressure advance and volumetric flow use 1 mm bands. Retraction uses 1 mm bands above a 0.4 mm base. The UI explains the value-to-height mapping. The step size must reach the highest sample. Whole-degree temperature, source setting bounds, material maximum temperature, reported nozzle limits, printable height, and volumetric XY speed limits are checked where available. Missing source maxima are not replaced with guessed physical limits.

Printing requires a current generated artifact, current printer telemetry, a confirmed matching nozzle, an idle printer, an empty queue, and plate/filament confirmation. AMS requires a Bambu printer and a single currently loaded slot matching the pinned filament type. A new plate confirmation is required for the next test. The normal queue controls cancellation and printing status.

Sessions and photos are private to their user. Printer-scoped API keys cannot access private calibration sessions. JPEG, PNG, and WebP uploads use the existing 10 MiB image limit before multipart spooling, Pillow's decoded-pixel protection, and PNG normalization that removes source metadata. Normalized files are also bounded and served with private, no-store caching.

## Verification without printing

Backend HTTP tests cover manual results, resume, copy preservation, invalidation, permissions, bounded evidence, generated artifacts, and dispatch to a fake Moonraker printer. The sidecar release gate slices all five tests into Bambu 3MF and Klipper G-code. It checks package integrity/checksums and temperature, pressure advance, paired retraction, and volumetric feedrate changes. Artifact checks do not prove physical print quality or a safe final material limit. Real printing and human inspection remain required to calibrate hardware.

For isolated browser verification, start the backend on port 8001 with `DATA_DIR=/tmp/layercove-calibration-preview-...` and the local sidecar URL, then run `CALIBRATION_PREVIEW_SEED=1 uv run --with-requirements requirements.txt python -m backend.tests._fixtures.seed_calibration_preview`. The seed rejects other data directories and creates an inactive printer. Point Vite at that backend on port 5174. From `frontend`, run `CALIBRATION_E2E=1 LAYERCOVE_URL=http://localhost:5174 bun run test:e2e calibration.spec.ts`. Never run this workflow against a printer installation.
