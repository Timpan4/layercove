import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

// Layout regressions use the real app with a deterministic, read-only library.
// No request from these tests reaches a printer or the production backend.
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false, use_slicer_api: true };
    if (path.endsWith('/slicer/capabilities')) body = { capabilities: { process_schema: false } };
    if (path.endsWith('/library/files')) body = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1, filename: `cube-${i + 1}.stl`, file_type: 'stl', file_size: 1024,
      folder_id: null, thumbnail_path: null, print_name: null, print_count: 0,
      duplicate_count: 0, created_at: '2026-10-01T00:00:00Z', tags: [],
    }));
    if (path.endsWith('/library/stats')) body = { total_files: 8, total_folders: 0, total_size_bytes: 8192 };
    if (path.endsWith('/library/trash')) body = { total: 0, items: [] };
    await route.fulfill({ json: body });
  });
  await page.goto('/files');
  await expect(page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true })).toBeVisible();
});

test('Upload stays inside the mobile viewport', async ({ page }) => {
  const upload = page.getByRole('button', { name: 'Upload', exact: true });
  const box = await upload.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await upload.click();
  await expect(page.getByRole('heading', { name: 'Upload Files', exact: true })).toBeVisible();
});

test('the last file action stays tappable at the bottom of the page', async ({ page }) => {
  const actions = page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true });
  await actions.evaluate((button) => {
    for (let parent = button.parentElement; parent; parent = parent.parentElement) {
      parent.scrollTop = parent.scrollHeight;
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const box = await actions.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByRole('button', { name: 'Quick slice', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Report a Bug', exact: true })).not.toBeVisible();
});

test('Quick slice can be tapped outside the STL card without clipping', async ({ page }) => {
  const actions = page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true });
  await actions.scrollIntoViewIfNeeded();
  // Keyboard opening isolates menu clipping from the floating report button.
  await actions.press('Enter');
  await page.getByRole('button', { name: 'Quick slice', exact: true }).click({ timeout: 3000 });
  await expect(page.getByRole('heading', { name: /Slice/ })).toBeVisible();
});

for (const width of [1280, 390]) {
  for (const scope of ['one', 'all'] as const) {
    test(`multi-plate quick slicing offers its full scope before the form at ${width}px (${scope})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.route((url) => url.pathname.replace(/\/$/, '').endsWith('/library/files'), (route) => route.fulfill({ json: [{
        id: 8, filename: 'project.3mf', file_type: '3mf', file_size: 1024, folder_id: null, thumbnail_path: null,
        print_count: 0, duplicate_count: 0, created_at: '2026-10-01T00:00:00Z', tags: [],
      }] }));
      await page.route('**/api/v1/library/files/8/plates', (route) => route.fulfill({ json: {
        file_id: 8, filename: 'project.3mf', is_multi_plate: true,
        plates: Array.from({ length: 4 }, (_, index) => ({ index: index + 1, objects: [], filaments: [] })),
      } }));
      let enqueueCount = 0;
      page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/slice')) enqueueCount++; });
      await page.reload();
      await page.getByRole('button', { name: 'List view', exact: true }).click();
      await page.getByRole('button', { name: 'Quick slice', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Select plates to slice', exact: true })).toBeVisible();
      await expect(page.getByText('Choose one plate or all plates, then configure the slice.', { exact: true })).toBeVisible();
      await expect(page.getByText(/Pick one to open in the GCode viewer/)).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Physical printer', exact: true })).toHaveCount(0);
      for (let index = 1; index <= 4; index++) await expect(page.getByRole('button', { name: new RegExp(`^Plate ${index} `) })).toBeVisible();
      const allPlates = page.getByRole('button', { name: 'Slice all 4 plates', exact: true });
      await expect(allPlates).toBeVisible();
      await (scope === 'all' ? allPlates : page.getByRole('button', { name: /^Plate 2 / })).click();
      await expect(page.getByRole('heading', { name: 'Slice model', exact: true })).toBeVisible();
      const allToggle = page.getByRole('checkbox', { name: 'Slice all 4 plates', exact: true });
      if (scope === 'all') await expect(allToggle).toBeChecked();
      else {
        await expect(allToggle).not.toBeChecked();
        await expect(page.getByText('project.3mf • Plate 2', { exact: true })).toBeVisible();
      }
      expect(enqueueCount).toBe(0);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    });
  }

  for (const view of ['grid', 'list'] as const) {
    test(`File Manager offers explicit quick and editable slicing in ${view} view at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.route('**/api/v1/slicer/capabilities', (route) => route.fulfill({ json: { capabilities: { process_schema: true } } }));
      await page.reload();
      await page.getByRole('button', { name: view === 'grid' ? 'Grid view' : 'List view', exact: true }).click();
      if (view === 'grid') await page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true }).click();
      const owner = view === 'grid' ? page : page.locator('[class~="grid"][class~="cursor-pointer"]').filter({ has: page.getByText('cube-8.stl', { exact: true }) });
      await expect(owner.getByRole('button', { name: 'Quick slice', exact: true })).toBeVisible();
      await expect(owner.getByRole('button', { name: 'Edit in workbench', exact: true })).toBeVisible();
      await owner.getByRole('button', { name: 'Quick slice', exact: true }).click();
      await expect(page.getByRole('heading', { name: /Slice/ })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      if (view === 'grid') await page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true }).click();
      await owner.getByRole('button', { name: 'Edit in workbench', exact: true }).click();
      await expect(page).toHaveURL(/\/slicer\/workbench\?library_file=8$/);
      await expect(page.getByRole('heading', { name: /3D Preview/ })).toHaveCount(0);
    });
  }
}

test('the quick-slice fallback remains available without workbench capability', async ({ page }) => {
  await page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit in workbench', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Quick slice', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Quick slice', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Slice/ })).toBeVisible();
});

test('editable slicing supports model formats and excludes completed toolpaths', async ({ page }) => {
  const models = ['part.3mf', 'part.step', 'part.stp'];
  const outputs = ['part.gcode', 'part.gcode.3mf'];
  await page.route('**/api/v1/slicer/capabilities', (route) => route.fulfill({ json: { capabilities: { process_schema: true } } }));
  await page.route('**/api/v1/library/files?**', (route) => route.fulfill({ json: [...models, ...outputs].map((filename, index) => ({ id: index + 1, filename, file_type: filename.split('.').pop(), file_size: 1024, folder_id: null, thumbnail_path: null, print_count: 0, duplicate_count: 0, created_at: '2026-10-01T00:00:00Z', tags: [] })) }));
  await page.reload();
  for (const filename of [...models, ...outputs]) {
    const actions = page.getByRole('button', { name: `Actions: ${filename}`, exact: true });
    await actions.click();
    const count = models.includes(filename) ? 1 : 0;
    await expect(page.getByRole('button', { name: 'Quick slice', exact: true })).toHaveCount(count);
    await expect(page.getByRole('button', { name: 'Edit in workbench', exact: true })).toHaveCount(count);
    await actions.press('Enter');
  }
});

test('a read-only library user cannot use either slicing action', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('auth_token', 'read-only-test-session'));
  await page.route('**/api/v1/auth/status', (route) => route.fulfill({ json: { auth_enabled: true, requires_setup: false } }));
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: { id: 1, username: 'reader', is_active: true, permissions: ['library:read'], groups: [] } }));
  await page.route('**/api/v1/slicer/capabilities', (route) => route.fulfill({ json: { capabilities: { process_schema: true } } }));
  await page.reload();
  await page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Quick slice', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit in workbench', exact: true })).toBeDisabled();
});

test('disabling the slicer API hides both slicing actions', async ({ page }) => {
  await page.route('**/api/v1/settings/', (route) => route.fulfill({ json: { check_updates: false, use_slicer_api: false } }));
  await page.reload();
  await page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Quick slice', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit in workbench', exact: true })).toHaveCount(0);
});

for (const width of [1280, 390]) {
  for (const workbench of [true, false]) {
    test(`the preview names its actual ${workbench ? 'editable' : 'quick'} slicing action at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.route('**/api/v1/slicer/capabilities', (route) => route.fulfill({ json: { capabilities: { process_schema: workbench } } }));
      await page.reload();
      await page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true }).click();
      await page.getByRole('button', { name: '3D Preview', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'cube-8.stl', exact: true, level: 2 })).toBeVisible();
      const sliceAction = page.getByRole('button', { name: workbench ? 'Edit in workbench' : 'Quick slice', exact: true });
      await expect(sliceAction).toBeVisible();
      await sliceAction.click();
      if (workbench) await expect(page).toHaveURL(/\/slicer\/workbench\?library_file=8$/);
      else await expect(page.getByRole('heading', { name: /Slice/ })).toBeVisible();
    });
  }
}
