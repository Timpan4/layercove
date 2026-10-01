import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

test('Add Spool is reachable from the mobile inventory header', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
      : path.replace(/\/$/, '').endsWith('/local-presets') ? { filament: [], printer: [], process: [] }
      : [];
    await route.fulfill({ json: body });
  });
  await page.goto('/inventory');
  const add = page.getByRole('button', { name: 'Add Spool', exact: true }).first();
  await expect(add).toBeVisible();
  const box = await add.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await add.click();
  await expect(page.getByRole('heading', { name: 'Add Spool', exact: true })).toBeVisible();
});
