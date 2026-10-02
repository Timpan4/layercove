import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [1440, 390]) {
  test.describe(`Statistics date controls at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.addInitScript(() => {
        localStorage.setItem('auth_token', 'fictional-date-token');
        localStorage.removeItem('bambusy-stats-timeframe');
      });
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/\/$/, '');
        if (request.method() !== 'GET') {
          if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
            return route.fulfill({ json: { token: 'fictional-token' } });
          }
          return route.fulfill({ status: 405, json: { detail: 'Read-only date control fixture' } });
        }
        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: true, requires_setup: false };
        if (path.endsWith('/auth/me')) body = { id: 901, username: 'Fixture Alice', permissions: ['stats:read', 'stats:filter_by_user', 'archives:read_all'], groups: [] };
        if (path.endsWith('/users')) body = [{ id: 901, username: 'Fixture Alice' }, { id: 902, username: 'Fixture Bob' }];
        if (path.endsWith('/settings')) body = { check_updates: false };
        if (path === '/api/v1/archives/stats') body = {
          total_prints: 0, successful_prints: 0, failed_prints: 0, cancelled_prints: 0,
          total_print_time_hours: 0, total_filament_grams: 0, total_cost: 0,
          prints_by_filament_type: {}, prints_by_printer: {}, average_time_accuracy: null,
          time_accuracy_by_printer: null, total_energy_kwh: 0, total_energy_cost: 0,
        };
        if (path.endsWith('/analysis/failures')) body = {
          period_days: 30, total_prints: 0, outcome_prints: 0, failed_prints: 0,
          failure_rate: 0, failures_by_reason: {}, failures_by_filament: {},
          failures_by_printer: {}, failures_by_hour: {}, recent_failures: [], trend: [],
        };
        await route.fulfill({ json: body });
      });
      await page.goto('/stats');
      await expect(page.getByRole('button', { name: 'All Users', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'All Time', exact: true }).click();
    });

    test('presets and custom controls stay inside the viewport', async ({ page }, testInfo) => {
      const presets = page.getByRole('button', { name: 'Today', exact: true }).locator('..');
      const presetBounds = await presets.boundingBox();
      expect(presetBounds).not.toBeNull();
      expect(presetBounds!.x).toBeGreaterThanOrEqual(0);
      expect(presetBounds!.x + presetBounds!.width).toBeLessThanOrEqual(width);
      if (width === 1440) {
        const desktopMenuWidth = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 16);
        expect(presetBounds!.width).toBeCloseTo(desktopMenuWidth, 0);
      }
      await page.getByRole('button', { name: 'Custom Range', exact: true }).click();
      const controls = [...await page.locator('input[type="date"]').all(), page.getByRole('button', { name: 'Apply', exact: true })];
      for (const control of controls) {
        await expect(control).toBeVisible();
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
      await testInfo.attach('custom-date-menu', { body: await page.screenshot(), contentType: 'image/png' });
    });

    test('custom dates have persistent names and apply the entered range', async ({ page }) => {
      await page.getByRole('button', { name: 'Custom Range', exact: true }).click();
      const from = page.getByLabel('From', { exact: true });
      const to = page.getByLabel('To', { exact: true });
      await expect(from).toBeVisible();
      await expect(to).toBeVisible();
      const applied = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/api/v1/archives/stats' && url.searchParams.get('date_from') === '2020-01-05' && url.searchParams.get('date_to') === '2020-01-12';
      });
      await from.fill('2020-01-05');
      await to.fill('2020-01-12');
      await expect(from).toHaveValue('2020-01-05');
      await expect(to).toHaveValue('2020-01-12');
      await expect(from).toHaveAttribute('max', '2020-01-12');
      await expect(to).toHaveAttribute('min', '2020-01-05');
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await applied;
      await expect(from).toHaveCount(0);
    });
  });
}
