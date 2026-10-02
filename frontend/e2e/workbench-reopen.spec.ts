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
async function installFixture(page: import('@playwright/test').Page, options: { mismatch?: boolean; corrupt?: boolean; plate?: 'default' | 'all' } = {}) {
  const { plate: _plate, ...withoutPlate } = snapshot;
  const savedRequest = options.plate === 'default' ? withoutPlate : options.plate === 'all' ? { ...snapshot, plate: 0 } : snapshot;
  let sliceRequests = 0;
  let resliceComplete = false;
  const contract = {
    contract_version: '1', engine: { name: 'OrcaSlicer', version: '2.4.2', commit: 'pinned' },
    image_identity: { digest: `sha256:${'b'.repeat(64)}` }, schema_hash: 'a'.repeat(64),
    capabilities: { process_schema: true, model_state: true, progress: true, cancel: false }, supported_scopes: ['global', 'object'],
    pages: [], options: [], scopes: {}, samples: {},
  };
  const job = {
    job_id: 25, status: 'completed', kind: 'library_file', source_id: options.mismatch ? 99 : 42, source_name: 'cube.3mf',
    schema_hash: contract.schema_hash, request_snapshot: options.corrupt ? null : savedRequest, request_fingerprint: createHash('sha256').update(JSON.stringify(sort(savedRequest))).digest('hex'),
    created_at: '2026-10-01T00:00:00Z', started_at: null, completed_at: '2026-10-01T00:01:00Z', progress: null,
    provenance: { state: 'resolved', printer_revision_id: 11, process_revision_id: 12, filament_revision_ids: [13], selection_evidence: {}, created_at: '2026-10-01T00:00:00Z' },
    result: { library_file_id: 77, name: 'cube.gcode', print_time_seconds: 60, filament_used_g: 1 },
  };
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST' && path.endsWith('/files/42/slice')) {
      sliceRequests++;
      await route.fulfill({ status: 202, json: { job_id: 37, status: 'pending', status_url: '/api/v1/slice-jobs/37' } });
      return;
    }
    if (path.includes('/gcode')) {
      await route.fulfill({ contentType: 'text/plain', body: 'G90\nM82\nG1 Z0.28\nG1 X10 Y10 E0\nG1 X20 Y10 E1\nG1 X20 Y20 E2\n' });
      return;
    }
    const body = path.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
      : path.endsWith('/slice-jobs/25') ? job
      : path.endsWith('/slice-jobs/37') ? { ...job, job_id: 37, status: resliceComplete ? 'completed' : 'running', result: resliceComplete ? job.result : undefined }
      : path.endsWith('/reslice-request') ? { source_kind: 'library_file', source_id: 42, request: savedRequest, tombstoned: false, revision_ids: { printer: 11, process: 12, filaments: [13] } }
      : path.includes('/slicer/') && /capabilities|schema/.test(path) ? contract
      : path.endsWith('/files/42/plates') ? { file_id: 42, filename: 'cube.3mf', is_multi_plate: true, plates: [{ index: 1, objects: [], object_ids: [], filaments: [] }, { index: 2, objects: ['Cube'], object_ids: ['cube'], filaments: [] }] }
      : path.endsWith('/files/42') ? { id: 42, filename: 'cube.3mf' }
      : path.endsWith('/settings') ? { currency: 'USD' }
      : path.includes('/revisions/11') ? { id: 11, profile_id: 1, review_state: 'approved', content_hash: 'bed', content: { printable_area: ['0x0', '300x0', '300x300', '0x300'], printable_height: '300' } }
      : [];
    await route.fulfill({ json: body });
  });
  return { get sliceRequests() { return sliceRequests; }, completeReslice() { resliceComplete = true; } };
}

for (const width of [1280, 390]) {
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

test('a job for another source cannot display or print its artifact here', async ({ page }) => {
  await installFixture(page, { mismatch: true });
  await page.goto('/slicer/workbench?library_file=42&job=25');
  await expect(page.getByText('This slice job belongs to a different source.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print saved result' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Exact historical' })).toHaveCount(0);
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
