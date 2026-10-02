import { createHash } from 'node:crypto';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const snapshot = {
  printer_preset: { source: 'local', id: 'Voron 300 0.4' },
  process_preset: { source: 'local', id: 'PLA 0.28' },
  filament_preset: { source: 'local', id: 'PLA' },
  destination_artifact_kind: 'klipper_gcode',
  plate: 2,
  schema_hash: 'a'.repeat(64),
  bed_type: 'Textured PEI Plate',
  process_overrides: { layer_height: 0.28 },
  model_state: {
    objects: [{ id: 'cube', transform: { position: [10, 20, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, overrides: { wall_loops: 3 } }],
    hidden_object_ids: [], lay_flat_object_ids: [], arrange: false,
  },
};
const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : value;
const longFilamentName = 'PLA preset for Voron with a long manufacturer and detailed print-quality description';
const longCompatibilityReason = 'compatibility unknown, nozzle match, ManufacturerSpecificCompatibilityDetailWithoutSpaces';
async function installFixture(page: import('@playwright/test').Page, options: { mismatch?: boolean; corrupt?: boolean; plate?: 'default' | 'all'; archive?: boolean; downloadError?: boolean; pending?: boolean; fresh?: boolean; longFilament?: boolean; processSettings?: boolean } = {}) {
  const { plate: _plate, ...withoutPlate } = snapshot;
  const savedRequest = options.plate === 'default' ? withoutPlate : options.plate === 'all' ? { ...snapshot, plate: 0 } : snapshot;
  let sliceRequests = 0;
  let sliceRequest: unknown;
  let resliceComplete = false;
  let initialComplete = !options.pending;
  const libraryFile = (id: number, filename: string) => ({ id, filename, file_type: filename.endsWith('.gcode') ? 'gcode' : 'stl', file_size: 1024, folder_id: null, thumbnail_path: null, print_name: null, print_count: 0, duplicate_count: 0, created_at: '2026-10-01T00:00:00Z', tags: [] });
  const profile = (id: number, profile_type: string) => ({ profile_id: id, revision_id: 10 + id, source: 'orca_cloud', remote_profile_id: `profile-${id}`, profile_type, display_name: `Cloud ${profile_type}`, content_hash: 'content', sharing_state: 'shared', tombstoned: false, stale: false, compatibility_metadata: {} });
  const unclassified = options.longFilament ? [{ ...profile(4, 'filament'), display_name: longFilamentName,
    classification: { group: 'unclassified', compatibility: 'unknown', readiness: 'acknowledgement_required', reason_codes: ['compatibility_unknown'], reason_details: [longCompatibilityReason], selectable: true, auto_selectable: false, acknowledgement_required: true } }] : [];
  const binding = { id: 5, profile_id: 1, printer_id: 1, printer_name: 'Physical device', profile_name: 'Cloud machine', expected_nozzle_diameter: 0.4, tool_index: 0, default_process_profile_id: 2, default_filament_profile_id: 3, enforcement_state: 'shadow', is_active: true, confirmed_at: null, readiness: { state: 'ready', reason_codes: [] }, nozzle: { status: 'confirmed', diameter: 0.4, tool_index: 0 } };
  const contract = {
    contract_version: '1', engine: { name: 'OrcaSlicer', version: '2.4.2', commit: 'pinned' },
    image_identity: { digest: `sha256:${'b'.repeat(64)}` }, schema_hash: 'a'.repeat(64),
    capabilities: { process_schema: true, model_state: true, progress: true, cancel: false }, supported_scopes: ['global', 'object'],
    pages: options.processSettings ? [{ name: 'Quality', groups: [{ name: 'Layer height', options: ['layer_height'] }] }] : [],
    options: options.processSettings ? [{ key: 'layer_height', label: 'Layer height', type: 'float', default: 0.2, mode: 'simple', min: 0.01, max: 1 }] : [],
    scopes: options.processSettings ? { layer_height: ['global', 'object'] } : {}, samples: options.processSettings ? { layer_height: 0.18 } : {},
  };
  const job = {
    job_id: 25, status: 'completed', kind: options.archive ? 'archive' : 'library_file', source_id: options.mismatch ? 99 : 42, source_name: 'cube.3mf',
    schema_hash: contract.schema_hash, request_snapshot: options.corrupt ? null : savedRequest, request_fingerprint: createHash('sha256').update(JSON.stringify(sort(savedRequest))).digest('hex'),
    created_at: '2026-10-01T00:00:00Z', started_at: null, completed_at: '2026-10-01T00:01:00Z', progress: null,
    provenance: { state: 'resolved', printer_revision_id: 11, process_revision_id: 12, filament_revision_ids: [13], selection_evidence: {}, created_at: '2026-10-01T00:00:00Z' },
    result: { ...(options.archive ? { archive_id: 77 } : { library_file_id: 77 }), name: 'edited-cube.gcode', print_time_seconds: 60, filament_used_g: 1 },
  };
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
    if (path.endsWith('/77/download')) {
      await route.fulfill(options.downloadError
        ? { status: 403, json: { detail: 'You cannot download this slice.' } }
        : { contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="edited-cube.gcode"' }, body: 'G90\n; exact edited job 25\nG1 X10 Y20 E3\n' });
      return;
    }
    if (route.request().method() === 'POST' && path.endsWith('/files/42/slice')) {
      sliceRequests++;
      sliceRequest = route.request().postDataJSON();
      await route.fulfill({ status: 202, json: { job_id: 37, status: 'pending', status_url: '/api/v1/slice-jobs/37' } });
      return;
    }
    if (path.includes('/gcode')) {
      await route.fulfill({ contentType: 'text/plain', body: 'G90\nM82\nG1 Z0.28\nG1 X10 Y10 E0\nG1 X20 Y10 E1\nG1 X20 Y20 E2\n' });
      return;
    }
    const body = path.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
      : path.endsWith('/slice-jobs/25') ? { ...job, status: initialComplete ? 'completed' : 'running', result: initialComplete ? job.result : undefined }
      : path.endsWith('/slice-jobs/37') ? { ...job, job_id: 37, status: resliceComplete ? 'completed' : 'running', result: resliceComplete ? job.result : undefined }
      : path.endsWith('/reslice-request') ? { source_kind: 'library_file', source_id: 42, request: savedRequest, tombstoned: false, revision_ids: { printer: 11, process: 12, filaments: [13] } }
      : path.includes('/slicer/') && /capabilities|schema/.test(path) ? contract
      : path.endsWith('/slicer/catalog/profiles') ? [profile(1, 'printer'), profile(2, 'process'), profile(3, 'filament'), ...unclassified]
      : path.endsWith('/slicer/catalog/bindings') ? [binding]
      : path.endsWith('/classification') ? { selected_printer: ['process', 'filament'].map((type, index) => ({ ...profile(index + 2, type), classification: { group: 'selected_printer', compatibility: 'match', readiness: 'ready', reason_codes: [], reason_details: [], selectable: true, auto_selectable: true, acknowledgement_required: false } })), other_installed_printers: [], unclassified, incompatible: [] }
      : path.endsWith('/slicer/profiles/process') ? { preset_type: 'process', source: 'orca_cloud', id: 'profile-2', values: options.processSettings ? { layer_height: 0.2 } : {} }
      : path.endsWith('/printers') && options.fresh ? [{ id: 1, name: 'Physical device', provider: 'moonraker', is_active: true }]
      : path.endsWith('/library/files') ? [libraryFile(42, 'cube.stl'), ...(initialComplete ? [libraryFile(77, 'edited-cube.gcode')] : [])]
      : path.endsWith('/library/stats') ? { total_files: initialComplete ? 2 : 1, total_folders: 0, total_size_bytes: 2048 }
      : path.endsWith('/library/trash') ? { total: 0, items: [] }
      : /\/(files|archives)\/42\/plates$/.test(path) ? options.longFilament
        ? { file_id: 42, filename: 'cube.stl', is_multi_plate: false, plates: [] }
        : { file_id: 42, filename: 'cube.3mf', is_multi_plate: true, plates: [{ index: 1, objects: [], object_ids: [], filaments: [] }, { index: 2, objects: ['Cube'], object_ids: ['cube'], filaments: [] }] }
      : /\/(files|archives)\/42$/.test(path) ? { id: 42, filename: 'cube.3mf' }
      : path.endsWith('/files/77') ? { id: 77, filename: options.plate === 'all' ? 'cube.gcode.3mf' : 'cube.gcode' }
      : path.endsWith('/files/77/plates') ? { is_multi_plate: options.plate === 'all', plates: options.plate === 'all' ? [
        { index: 1, name: 'First plate', objects: [], filaments: [], has_thumbnail: false, thumbnail_url: null, print_time_seconds: 20, filament_used_grams: 0.3 },
        { index: 2, name: 'Second plate', objects: [], filaments: [], has_thumbnail: false, thumbnail_url: null, print_time_seconds: 40, filament_used_grams: 0.7 },
      ] : [] }
      : path.endsWith('/filament-requirements') ? { filaments: [] }
      : path.endsWith('/settings') ? { currency: 'USD', use_slicer_api: options.longFilament }
      : path.includes('/revisions/11') ? { id: 11, profile_id: 1, review_state: 'approved', content_hash: 'bed', content: { printable_area: ['0x0', '300x0', '300x300', '0x300'], printable_height: '300' } }
      : [];
    await route.fulfill({ json: body });
  });
  return { get sliceRequests() { return sliceRequests; }, get sliceRequest() { return sliceRequest; }, completeReslice() { resliceComplete = true; }, completeInitial() { initialComplete = true; } };
}

for (const width of [1280, 390]) {
  for (const scope of ['global', 'object'] as const) {
    test(`typed decimal process settings retain their value at ${width}px (${scope})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await installFixture(page, { fresh: true, processSettings: true });
      await page.route('**/api/v1/library/files/42/plates', (route) => route.fulfill({ json: {
        file_id: 42, filename: 'cube.3mf', is_multi_plate: false,
        plates: [{ index: 1, objects: ['Cube'], object_ids: ['cube'], filaments: [] }],
      } }));
      await page.goto('/slicer/workbench?library_file=42');
      if (width === 390) await page.getByRole('button', { name: 'settings', exact: true }).click();
      await page.getByRole('combobox', { name: 'Physical printer', exact: true }).selectOption('1');
      await page.getByRole('combobox', { name: 'Exact slicer binding', exact: true }).selectOption('5');
      if (scope === 'object') await page.getByRole('button', { name: 'object', exact: true }).click();
      const height = page.getByRole('spinbutton', { name: 'Layer height', exact: true });
      await expect(height).toHaveValue('0.2');
      await height.press('ControlOrMeta+A');
      await height.pressSequentially('0.28');
      await expect(height).toHaveValue('0.28');
      await height.press('Tab');
      await expect(height).toHaveValue('0.28');
      await height.fill('');
      await expect(height).toHaveValue('');
      await height.press('Tab');
      await expect(height).toHaveValue('0.28');
      if (scope === 'global') {
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(height).toHaveValue('0.2');
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(height).toHaveValue('0.28');
      }
      await page.getByRole('checkbox', { name: /Confirm filament materials/ }).check();
      await page.getByRole('button', { name: 'Slice plate', exact: true }).click();
      expect(fixture.sliceRequests).toBe(1);
      expect(fixture.sliceRequest).toMatchObject(scope === 'global'
        ? { process_overrides: { layer_height: 0.28 } }
        : { model_state: { objects: [{ id: 'cube', overrides: { layer_height: 0.28 } }] } });
    });
  }

  test(`process edits can be undone, redone and replaced at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await installFixture(page, { fresh: true, processSettings: true });
    await page.goto('/slicer/workbench?library_file=42');
    if (width === 390) await page.getByRole('button', { name: 'settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Physical printer', exact: true }).selectOption('1');
    await page.getByRole('combobox', { name: 'Exact slicer binding', exact: true }).selectOption('5');
    const height = page.getByRole('spinbutton', { name: 'Layer height', exact: true });
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    await expect(height).toHaveValue('0.2');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await height.fill('0.2');
    await expect(undo).toBeDisabled();
    await height.fill('0.28');
    await height.fill('0.2');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await height.fill('0.28');
    await expect(height).toHaveValue('0.28');
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await undo.click();
    await expect(height).toHaveValue('0.2');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect(height).toHaveValue('0.28');
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await height.fill('0.2');
    await undo.click();
    await expect(height).toHaveValue('0.28');
    await redo.click();
    await expect(height).toHaveValue('0.2');
    await undo.click();
    await expect(height).toHaveValue('0.28');
    await height.press('Tab');
    await height.press('End');
    await height.press('Backspace');
    await height.pressSequentially('9');
    await height.press('Tab');
    await expect(height).toHaveValue('0.29');
    await undo.click();
    await expect(height).toHaveValue('0.28');
    await redo.click();
    await expect(height).toHaveValue('0.29');
    await undo.click();
    await undo.click();
    await expect(height).toHaveValue('0.2');
    await height.fill('0.24');
    await expect(redo).toBeDisabled();
    await undo.click();
    await expect(height).toHaveValue('0.2');
    await expect(undo).toBeDisabled();
    expect(fixture.sliceRequests).toBe(0);
  });

  test(`quick slicing keeps full filament names and compatibility reasons readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installFixture(page, { fresh: true, longFilament: true });
    await page.goto('/files');
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    const fileRow = page.locator('[class~="grid"][class~="cursor-pointer"]').filter({ has: page.getByText('cube.stl', { exact: true }) });
    await fileRow.getByRole('button', { name: 'Quick slice', exact: true }).click();
    await page.getByRole('combobox', { name: 'Physical printer', exact: true }).selectOption('1');
    await page.getByRole('combobox', { name: 'Exact slicer binding', exact: true }).selectOption('5');
    const filamentGroup = page.getByRole('group', { name: 'Filament profile', exact: true });
    await filamentGroup.getByText('Unclassified (1)', { exact: true }).click();
    const name = filamentGroup.getByText(`${longFilamentName} · orca_cloud`, { exact: true });
    const reason = filamentGroup.getByText(`Manual confirmation required · ${longCompatibilityReason}`, { exact: true });
    for (const text of [name, reason]) {
      await expect(text).toBeVisible();
      const fits = await text.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const textBounds = range.getBoundingClientRect();
        const ownerBounds = element.closest('label')!.getBoundingClientRect();
        return textBounds.left >= ownerBounds.left && textBounds.right <= ownerBounds.right
          && ownerBounds.right <= window.innerWidth;
      });
      expect.soft(fits).toBe(true);
    }
    await name.click();
    const confirmation = page.getByRole('checkbox', { name: /Confirm.*before slicing/ });
    await expect(confirmation).not.toBeChecked();
    await expect(page.getByRole('button', { name: 'Slice', exact: true })).toBeDisabled();
    await confirmation.check();
    await expect(page.getByRole('button', { name: 'Slice', exact: true })).toBeEnabled();
  });

  test(`a fresh workbench result downloads the completed slice after settings change at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await installFixture(page, { fresh: true });
    await page.goto('/slicer/workbench?library_file=42');
    if (width === 390) await page.getByRole('button', { name: 'settings', exact: true }).click();
    await page.getByRole('combobox', { name: 'Physical printer' }).selectOption('1');
    await page.getByRole('combobox', { name: 'Exact slicer binding' }).selectOption('5');
    await page.getByRole('checkbox', { name: /Confirm filament materials/ }).check();
    await page.getByRole('button', { name: 'Slice plate', exact: true }).click();
    fixture.completeReslice();
    await expect(page.getByText('Saved to File Manager', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Arrange on selected printer bed' }).uncheck();
    await expect(page.getByText('This is the previous slice. Slice again to save your changes.', { exact: true })).toBeVisible();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download slice', exact: true }).click();
    expect((await downloading).suggestedFilename()).toBe('edited-cube.gcode');
    expect(fixture.sliceRequests).toBe(1);
  });

  test(`a completed workbench slice visibly stays saved and downloads its exact output at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await installFixture(page);
    await page.goto('/slicer/workbench?library_file=42&job=25');
    await expect(page.getByText('Saved to File Manager', { exact: true })).toBeVisible();
    await expect(page.getByText('edited-cube.gcode', { exact: true })).toBeVisible();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download slice', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('edited-cube.gcode');
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('G90\n; exact edited job 25\nG1 X10 Y20 E3\n');
    await page.reload();
    await expect(page.getByText('Saved to File Manager', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open File Manager', exact: true })).toHaveAttribute('href', '/files');
    expect(fixture.sliceRequests).toBe(0);
  });

  test(`completed slice estimates remain visible in the result and print handoff at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installFixture(page);
    await page.goto('/slicer/workbench?library_file=42&job=25');
    const estimates = page.getByRole('region', { name: 'Slice estimates', exact: true });
    await expect(estimates).toHaveCount(1);
    await expect(estimates.getByText('Estimated time', { exact: true })).toBeVisible();
    await expect(estimates.getByText('1m', { exact: true })).toBeVisible();
    await expect(estimates.getByText('Estimated filament', { exact: true })).toBeVisible();
    await expect(estimates.getByText('1 g', { exact: true })).toBeVisible();
    await page.reload();
    await expect(estimates.getByText('1m', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Print saved result', exact: true }).click();
    await expect(estimates).toHaveCount(2);
    await expect(estimates.last().getByText('1m', { exact: true })).toBeVisible();
    await expect(estimates.last().getByText('1 g', { exact: true })).toBeVisible();
  });

  test(`reopening a saved slice preserves its settings and opens the toolpath at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installFixture(page);
    await page.goto('/slicer/workbench?library_file=42&job=25');
    await expect(page.getByRole('heading', { name: 'Saved slice result' })).toBeVisible();
    await expect(page.getByText('Voron 300 0.4', { exact: true })).toBeVisible();
    await expect(page.getByText('PLA 0.28', { exact: true })).toBeVisible();
    await expect(page.getByText('layer_height: 0.28', { exact: true })).toBeVisible();
    await expect(page.getByText('Position: 10, 20, 0', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Physical printer' })).toHaveCount(0);
    await expect(page.getByText('Preview is stale. Slice again before printing.', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Print saved result' })).toBeEnabled();
    await expect(page.getByRole('slider')).toBeVisible();
    await expect(page.getByRole('slider')).toHaveAttribute('max', '2');
    await page.reload();
    await expect(page.getByText('layer_height: 0.28', { exact: true })).toBeVisible();
    await expect(page.getByRole('slider')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exact historical' })).toBeVisible();
  });
}

test('an archive slice downloads the completed archive artifact and links to Print Archives', async ({ page }) => {
  await installFixture(page, { archive: true });
  await page.goto('/slicer/workbench?archive=42&job=25');
  await expect(page.getByText('Saved to Print Archives', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Print Archives', exact: true })).toHaveAttribute('href', '/archives');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download slice', exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe('edited-cube.gcode');
});

test('returning immediately after completion refreshes the saved file count', async ({ page }) => {
  const fixture = await installFixture(page, { pending: true });
  await page.goto('/slicer/workbench?library_file=42&job=25');
  await expect(page.getByRole('heading', { name: 'Slice in progress' })).toBeVisible();
  await page.getByRole('button', { name: 'Return to source', exact: true }).click();
  const total = page.getByText('Files:', { exact: true }).locator('..');
  await expect(total).toHaveText('Files:1');
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Slice in progress' })).toBeVisible();
  fixture.completeInitial();
  await expect(page.getByRole('heading', { name: 'Saved slice result' })).toBeVisible();
  await page.getByRole('button', { name: 'Return to source', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Actions: edited-cube.gcode', exact: true })).toBeVisible();
  await expect(total).toHaveText('Files:2');
});

test('a rejected slice download explains the failure and allows retry', async ({ page }) => {
  await installFixture(page, { downloadError: true });
  await page.goto('/slicer/workbench?library_file=42&job=25');
  await page.getByRole('button', { name: 'Download slice', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('You cannot download this slice.');
  await expect(page.getByRole('button', { name: 'Download slice', exact: true })).toBeEnabled();
});

test('a job for another source cannot display or print its artifact here', async ({ page }) => {
  await installFixture(page, { mismatch: true });
  await page.goto('/slicer/workbench?library_file=42&job=25');
  await expect(page.getByText('This slice job belongs to a different source.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print saved result' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Exact historical' })).toHaveCount(0);
});

test('print handoff labels complete-slice totals when selecting a plate subset', async ({ page }) => {
  await installFixture(page, { plate: 'all' });
  await page.goto('/slicer/workbench?library_file=42&job=25');
  await page.getByRole('button', { name: 'Print saved result', exact: true }).click();
  await expect(page.getByText('Estimates cover the complete slice. Plate selections below may change the printed time and filament.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Second plate/ }).click();
  await expect(page.getByText('Estimates cover the complete slice. Plate selections below may change the printed time and filament.', { exact: true })).toBeVisible();
  const estimates = page.getByRole('region', { name: 'Slice estimates', exact: true }).last();
  await expect(estimates.getByText('1m', { exact: true })).toBeVisible();
  await expect(estimates.getByText('1 g', { exact: true })).toBeVisible();
});

test('a changed saved request cannot enable printing the old artifact', async ({ page }) => {
  await installFixture(page, { corrupt: true });
  await page.goto('/slicer/workbench?library_file=42&job=25');
  await expect(page.getByRole('heading', { name: 'Saved slice result' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print saved result' })).toBeDisabled();
  await expect(page.getByText('Saved settings could not be verified. Return to the source to make a new slice.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exact historical' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upgrade catalog' })).toHaveCount(0);
});

for (const [plate, label] of [['default', '1'], ['all', 'All plates']] as const) {
  test(`saved ${plate} plate selection is labeled faithfully`, async ({ page }) => {
    await installFixture(page, { plate });
    await page.goto('/slicer/workbench?library_file=42&job=25');
    await expect(page.getByRole('complementary', { name: 'Saved slice settings' }).getByText(label, { exact: true })).toBeVisible();
  });
}

test('historical re-slicing stays read-only while running and requires explicit confirmation', async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto('/slicer/workbench?library_file=42&job=25');
  await page.getByRole('button', { name: 'Exact historical' }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm exact historical re-slice' })).toBeVisible();
  expect(fixture.sliceRequests).toBe(0);
  await page.getByRole('button', { name: 'Confirm re-slice' }).click();
  await expect(page.getByRole('heading', { name: 'Slice in progress' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Physical printer' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Print saved result' })).toBeDisabled();
  fixture.completeReslice();
  await expect(page.getByRole('heading', { name: 'Saved slice result' })).toBeVisible();
  await expect(page.getByText('layer_height: 0.28', { exact: true })).toBeVisible();
  expect(fixture.sliceRequests).toBe(1);
});
