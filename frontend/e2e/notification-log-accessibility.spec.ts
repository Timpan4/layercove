import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [1440, 390]) {
  test(`notification log controls have meaningful accessible names at ${width}px`, async ({ page }) => {
    const blockedWrites: string[] = [];
    await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'en');
      localStorage.setItem('auth_token', 'fictional-notification-token');
    });
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/\/$/, '');
      if (request.method() !== 'GET') {
        blockedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only notification log fixture' } });
      }

      let body: unknown = [];
      if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
      if (path.endsWith('/settings')) body = { check_updates: false, time_format: 'system' };
      if (path === '/api/v1/notifications/logs/stats') {
        body = { total: 0, success_count: 0, failure_count: 0 };
      }
      return route.fulfill({ json: body });
    });

    await page.goto('/settings?tab=notifications');
    await page.getByRole('button', { name: 'Log', exact: true }).click();
    const panel = page.getByRole('heading', { name: 'Notification Log', exact: true })
      .locator('..').locator('..').locator('..');
    const period = panel.getByRole('combobox');
    const close = panel.getByText('×', { exact: true });
    await expect.soft(period).toHaveAccessibleName('Time');
    await expect.soft(close).toHaveAccessibleName('Close');
    await period.selectOption('30');
    await expect(period).toHaveValue('30');
    await expect.soft(period).toHaveAccessibleName('Time');
    expect(blockedWrites.filter((request) => request.includes('/notifications/'))).toEqual([]);
  });
}
