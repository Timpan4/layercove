import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [1280, 390]) {
  test(`General settings has no supporter banner at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
      const body = path.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
        : path.endsWith('/settings') ? { check_updates: false, currency: 'USD' }
        : path.endsWith('/system/storage-usage') ? { categories: [], other_breakdown: [], roots: [], total_bytes: 0, total_formatted: '0 B', scan_errors: 0 }
        : [];
      await route.fulfill({ json: body });
    });
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /View supporters/i })).toHaveCount(0);
    await expect(page.getByText('Independent & community-funded', { exact: true })).toHaveCount(0);
  });
}
