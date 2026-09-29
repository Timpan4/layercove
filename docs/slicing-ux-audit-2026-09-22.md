# Slicing UX audit

Date: 2026-09-22. Target: https://layercove.timpan.dev/ (v0.2.4.9). Browser: signed-in Chrome session. Responsive checks used a 390 × 844 CSS-pixel viewport and the normal desktop viewport.

This is a historical audit of the deployment observed on 2026-09-22. Related fixes have since merged in PRs [#148](https://github.com/Timpan4/layercove/pull/148) through [#154](https://github.com/Timpan4/layercove/pull/154), covering print-target compatibility, material confirmation, mobile canvas layout, bed inheritance, binding recovery, printer selection, and filament ordering. This report has not been reverified against current main. The original observations below are preserved.

## Outcome and coverage

I followed an existing STL from File Manager through quick slicing, generated G-code, preview, and the Print dialog. I also opened the STL's 3D Preview, entered the Orca-style workbench, changed a process setting, completed a workbench slice, inspected its preview, reopened the completed job, and checked a four-plate 3MF. Both installed printers, DOGGE'S PRINTER (P1S) and Tim Voron, were tried in the slicing selectors. No physical print was submitted.

The quick-slice test created `Voron_Design_Cube_v8_PLA_24m37s.gcode` in File Manager (library file 22). The workbench created completed job 25. The test G-code remains in the library. A physical phone, native file picker, printer transfer, and actual print were outside this browser test. This list covers reproducible issues in the paths above; it cannot establish that every combination of profile, model, and printer is free of further defects. The earlier broad audit is in [ux-audit-2026-09-20.md](ux-audit-2026-09-20.md).

For the requested OrcaSlicer comparison, its documentation covers [adding objects and plates](https://github.com/OrcaSlicer/OrcaSlicer/wiki/prepare_basic), [moving, rotating, and scaling objects](https://www.orcaslicer.com/wiki/print_prepare/prepare_object_manipulation), and [exporting a sliced plate](https://github.com/OrcaSlicer/OrcaSlicer/wiki/keyboard_shortcuts). LayerCove's missing-bed state prevented a fair test of object transforms, so this report does not mark them as a separate defect.

## Ranked findings

### 1. Critical: Print accepts the wrong printer for generated G-code

**Reproduce:** Slice `Voron_Design_Cube_v8.STL` for Tim Voron. From the resulting `.gcode` file, choose Print. The dialog offers DOGGE'S PRINTER (P1S), allows it to be selected, and enables Print. The workbench job's Print dialog also offered the P1S, although I did not select it there. I stopped before submission.

**Impact:** The UI permits an operator to submit Klipper/Voron output to a Bambu P1S. Server-side rejection was not tested. **Fix:** Bind generated output to the exact compatible printer family/profile, show its target in the dialog, and enforce the same restriction at submission.

### 2. Critical: PLA project slots silently default to a TPU profile

**Reproduce:** In File Manager, choose Slice on `Tapecutter_different_sizes.3mf`, select Plate 1, Tim Voron, then its exact binding. The project displays Filament 1, 2, and 3 as PLA. Each is automatically set to `Inslogic 95A TPU @System`. Readiness says ready and Slice is enabled. The same TPU default appears for the standalone STL.

**Impact:** A material mismatch can reach the slicer without an acknowledgement. The current readiness check appears to use printer/nozzle compatibility while ignoring the project's declared material. **Fix:** Match the source material to a compatible filament or require explicit selection and confirmation for every mismatched slot. A green ready state must cover material type.

### 3. Critical: The mobile workbench has no usable 3D canvas

**Reproduce:** Open `Voron_Design_Cube_v8.STL` in 3D Preview, choose Slice to enter the workbench, and set the viewport to 390 × 844. Settings occupy the visible width; Prepare/Preview collapse into a narrow purple strip in the header. The workbench canvas measured **0 CSS pixels wide** at x=408, beyond the 390-pixel viewport. The completed job's preview is likewise not visible on the phone layout.

**Impact:** Phone users cannot inspect placement or layers in the main slicer. **Fix:** Give Prepare and Preview a full-width phone canvas, put settings in a drawer or separate view, and keep labelled navigation and primary actions tappable.

### 4. High: Slicing and printing remain available without bed geometry

**Reproduce:** In the workbench, select Tim Voron and `Voron 2.4 300 0.4 nozzle - my`. It reports that profile revision 9826 has no `printable_area` or `bed_shape`; the model is shown without a bed and fit is explicitly unverified. Readiness still says ready. Slice plate succeeds, and Print becomes available after completion.

**Impact:** The operator cannot verify printable area or placement before dispatch. **Fix:** Supply the selected revision's bed geometry or make this state an explicit, prominent fit acknowledgement at both slice and print handoff. Do not describe the complete configuration as ready while fit is unknown.

### 5. High: The installed P1S has no usable slicer binding or recovery path

**Reproduce:** Choose DOGGE'S PRINTER in both the quick-slice form and workbench. The required exact-binding selector contains only `Choose exact binding`; Slice stays disabled. The form gives no reason, setup link, or next action. Tim Voron does expose a binding.

**Impact:** This installed P1S cannot be used for a new slice in the tested account. The missing binding may be account configuration, but the dead end is a UX problem. **Fix:** Explain which profile or cloud/local setup is missing and link directly to the relevant binding task.

### 6. High: Printer selection exposes a separate technical binding step

**Reproduce:** Open Slice on `Voron_Design_Cube_v8.STL`. The first selector lists only `DOGGE'S PRINTER` and `Tim Voron`, without model, nozzle, or slicer preset. Selecting Tim Voron loads a second required selector labelled `Exact printer profile, nozzle, and tool`, with `Voron 2.4 300 0.4 nozzle - my · 0.4 mm · tool 0` as its only choice. Until that second selection, there is no process or filament choice. The same two-step selector appears in the workbench.

**Impact:** The user must translate a physical device into an implementation-level profile binding before making the familiar Orca-style printer, process, and filament choices. The first choice does not show enough information to distinguish a configured target, and the second repeats a single available option. **Fix:** Show one printer target row with physical name, model, nozzle, and associated slicer preset. Automatically use a unique verified binding, and offer a clear setup or change action when it is missing or ambiguous.

### 7. High: Filament selection buries material matches in a long compatibility list

**Reproduce:** After selecting Tim Voron and its binding, the `Filament profile` section shows `Inslogic 95A TPU @System` under `Selected printer (1)`. The 28 other profiles, including PLA, start inside collapsed `Unclassified (28)`. Expanding it shows a long radio list mixing PLA, ABS, ASA, PETG, and other materials. Each row repeats `orca_cloud`, `Manual confirmation required`, and `compatibility unknown, nozzle match`. Selecting `Voron Generic PLA - Copy` adds a separate compatibility acknowledgement. The three PLA slots of the tested 3MF each require their own profile choice.

**Impact:** Choosing the correct material takes more work than accepting the wrong TPU default, and the list emphasizes provenance and compatibility metadata over material type and loaded spool. **Fix:** Lead with the source slot's material and a compact selected-filament summary. Group or filter candidates by material and installed printer, show loaded spool matches where known, and expose compatibility reasons in plain language. Keep an explicit way to choose a different material and apply a verified choice across equivalent slots.

### 8. High: Profile search hides active choices while Slice remains ready

**Reproduce:** With the default process and TPU filament selected, type `PLA` into the single `Search catalog profiles` field. It filters both the process and filament sections. Both `Selected printer` counts become zero with `No profiles`, yet readiness remains `ready` and Slice remains enabled. The active process and TPU choices are not shown anywhere in the filtered list. The results also include unrelated ABS, ASA, and PET templates whose names do not contain `PLA`.

**Impact:** A user searching for a replacement filament cannot tell which profiles the enabled Slice action will use. **Fix:** Keep the active printer, process, and filament summaries visible above search results. Scope search to the section being edited, and make search matches explainable from visible profile fields.

### 9. High: The standalone G-code viewer fails to frame the sliced model

**Reproduce:** Open 3D Preview on the new `Voron_Design_Cube_v8_PLA_24m37s.gcode`. At 390 × 844, the viewer shows an empty grid through loading and playback. At desktop width, the toolpath is far to the lower left and partly clipped. The model exists; the default camera framing hides it on mobile.

**Impact:** The quick-slice dialog tells users to check the sliced preview, but its default view provides no usable check on a phone. **Fix:** Fit the generated toolpath to the viewer on load and resize, with an obvious reset-to-model control.

### 10. High: Reopening a completed workbench job loses its configuration

**Reproduce:** In workbench job 25, select Tim Voron, a PLA filament, acknowledge unknown compatibility, set layer height to 0.28 mm, and slice. Navigate away and return to the job URL. The page shows the completed job and pinned revision numbers, but printer returns to `Choose physical printer`, layer height returns to 0.20 mm, Slice again and Print are disabled, and Preview says it is stale. `Exact historical` prompts for a new slice rather than restoring the edited session.

**Impact:** A user cannot reliably inspect or continue the configuration that produced an existing slice after navigation or refresh. **Fix:** Restore the job's pinned printer, process, filament and overrides in the workbench, or show the completed job in a read-only state with its preview and a deliberate edit/reslice action.

### 11. High: The workbench offers no visible way to save its completed output

**Reproduce:** Complete job 25 in the workbench. It offers Slice again and Print, but no Save or Download action. On returning to File Manager, the file count remains seven, the same as before the workbench slice. Quick slicing, by contrast, added a G-code file to the library.

**Impact:** A user can inspect or print the workbench result but cannot visibly export or retain that exact edited slice as a library artifact. **Fix:** Offer Save to library and Download for the completed output, with a filename and estimates. If workbench jobs are intentionally transient, state that before slicing.

### 12. Medium: The quick Slice action hides the full workbench

**Reproduce:** In File Manager, the STL action `Slice` opens a small printer/profile modal. The Orca-style process editor is reached only through the separate `3D Preview` modal's `Slice` button. Neither entry distinguishes quick slice from editable slicing.

**Impact:** Users can generate output without discovering process, support, speed, or placement controls. **Fix:** Offer clear `Quick slice` and `Open in slicer` actions, or route Slice into the workbench with a simple mode.

### 13. Medium: The mobile STL action menu clips its Slice item

**Reproduce:** At 390 × 844 in File Manager, scroll to the last-row STL card and open its three-dot menu. The menu renders Run with pipeline and later items, while Slice is above the visible clipped menu area. The accessibility tree still contains Slice, and automation could invoke it; a touch user cannot see it in that position.

**Fix:** Position or scroll the menu within the viewport and card stacking context. Keep every action visible and reachable by touch.

### 14. Medium: Upload is initially off-screen on mobile

**Reproduce:** Open File Manager at 390 × 844. Its top action strip shows Generate Thumbnails and Link External; Upload lies beyond the right edge, with no visible overflow cue. Invoking Upload through the accessibility tree scrolls that strip to the right.

**Fix:** Keep Upload visible as a primary action and move secondary actions into a labelled overflow menu.

### 15. Medium: The mobile source-model preview starts badly zoomed

**Reproduce:** Open `Voron_Design_Cube_v8.STL` with 3D Preview at 390 × 844. The model fills and is cut off by the preview panel. Reset returns to the same framing. Three Zoom out taps make the model tiny near the panel's bottom.

**Fix:** Fit the source model to the preview panel on open and on resize; make Reset return to that fit.

### 16. Medium: Mobile preset text hides compatibility detail

**Reproduce:** Expand `Unclassified (28)` filament presets in the mobile slice dialog. Long profile labels and `Manual confirmation required · compatibility unknown, nozzle match` run beyond the narrow panel and are visually cut off. Selecting a PLA option adds a separate acknowledgement, but the list does not let the user read the whole classification while comparing options.

**Fix:** Wrap profile names and compatibility reasons, and keep the acknowledgement wording human-readable on narrow screens.

### 17. Low: Multi-plate Slice uses preview wording

**Reproduce:** Choose Slice on `Tapecutter_different_sizes.3mf`. The first dialog says `Select plate to preview` and `Pick one to open in the GCode viewer`, but selecting a plate actually opens the slicing form. The later `Slice all 4 plates` option also appears only after selecting one plate.

**Fix:** Say `Choose plates to slice` and present single-plate/all-plates choice before the slice form.

### 18. Low: The workbench omits slice estimates at completion

**Reproduce:** After job 25 completes, the workbench footer shows `completed` and Preview exposes a layer position, but the visible result provides no time, filament usage, or cost summary. The separate File Manager card for quick-slice output shows a time estimate.

**Fix:** Show duration and material estimates beside the completed workbench preview and in any save/print handoff.

### 19. Low: Undo and Redo stay disabled after a process edit

**Reproduce:** Change workbench Layer height from 0.20 to 0.28 mm. The value updates, but Undo and Redo remain disabled. This test did not establish whether another history mechanism exists.

**Fix:** Make setting edits undoable or remove the inactive controls from this state.

## Verification boundary

The quick slice completed and produced a 3.5 MB, 24-minute Klipper G-code file. Workbench job 25 reached `completed` and its layer slider changed the visible toolpath. Neither output was sent to a printer. The Print button enabling in finding 1 proves a missing UI guard, not that the server or machine would accept the incompatible file. Bed geometry and P1S binding findings apply to the profiles available in this account. Responsive checks used browser viewport emulation, not native touch hardware.
