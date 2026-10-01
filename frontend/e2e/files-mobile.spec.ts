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
  await expect(page.getByRole('button', { name: 'Slice', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Report a Bug', exact: true })).not.toBeVisible();
});

test('Slice can be tapped outside the STL card without clipping', async ({ page }) => {
  const actions = page.getByRole('button', { name: 'Actions: cube-8.stl', exact: true });
  await actions.scrollIntoViewIfNeeded();
  // Keyboard opening isolates menu clipping from the floating report button.
  await actions.press('Enter');
  await page.getByRole('button', { name: 'Slice', exact: true }).click({ timeout: 3000 });
  await expect(page.getByRole('heading', { name: /Slice/ })).toBeVisible();
});
