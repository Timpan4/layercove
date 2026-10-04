import { test, expect } from './test';

test.use({ serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const wsOrigin = new URL(appOrigin);
wsOrigin.protocol = wsOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
const startupTokenPaths = new Set([
  '/api/v1/auth/ws-token',
  '/api/v1/printers/camera/stream-token',
]);

const archives = [
  {
    id: 2501,
    printer_id: 1,
    filename: 'fixture-success.gcode',
    print_name: 'Fixture completed print',
    status: 'completed',
    created_at: '2026-09-21T12:00:00Z',
    completed_at: '2026-09-21T12:30:00Z',
  },
  {
    id: 2502,
    printer_id: 1,
    filename: 'fixture-failed.gcode',
    print_name: 'Fixture failed print',
    status: 'failed',
    created_at: '2026-09-23T12:00:00Z',
    completed_at: '2026-09-23T12:30:00Z',
  },
  {
    id: 2503,
    printer_id: 1,
    filename: 'Voron_Design_Cube_v8_PLA_25m0s.gcode',
    print_name: 'Voron_Design_Cube_v8_PLA_25m0s',
    status: 'cancelled',
    created_at: '2026-09-22T12:00:00Z',
    completed_at: '2026-09-22T12:25:00Z',
  },
  {
    id: 2504,
    printer_id: 1,
    filename: 'Voron_Design_Cube_v8.gcode',
    print_name: 'Voron_Design_Cube_v8',
    status: 'cancelled',
    created_at: '2026-09-22T13:00:00Z',
    completed_at: '2026-09-22T13:25:00Z',
  },
];

for (const width of [390, 1440]) {
  test(`Archive Calendar preserves archive outcomes at ${width}px`, async ({ page }) => {
    const blockedWrites: string[] = [];
    const externalRequests: string[] = [];

    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
    await page.addInitScript(() => {
      localStorage.setItem('bambutrack_language', 'en');
      localStorage.removeItem('archiveFilterPrinter');
      localStorage.removeItem('archiveViewMode');
    });

    await page.routeWebSocket(
      (url) => url.origin === wsOrigin.origin && url.pathname.startsWith('/api/'),
      (socket) => socket.close(),
    );
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== appOrigin) {
        externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }

      const path = url.pathname.replace(/\/+$/, '');
      if (request.method() !== 'GET') {
        if (request.method() === 'POST' && startupTokenPaths.has(path)) {
          return route.fulfill({ json: { token: 'fictional-calendar-token' } });
        }
        blockedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only Archive Calendar fixture' } });
      }

      if (!path.startsWith('/api/')) return route.continue();

      let body: unknown = [];
      if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
      if (path === '/api/v1/settings') body = { language: 'en', check_updates: false };
      if (path === '/api/v1/printers') {
        body = [{ id: 1, name: 'Tim Voron', provider: 'moonraker', model: 'Voron 2.4', is_active: true }];
      }
      if (path === '/api/v1/archives') body = archives;
      if (path === '/api/v1/archives/no-3mf-warning') body = { has_fallback: false };
      return route.fulfill({ json: body });
    });

    try {
      await page.goto('/archives');
      const printerFilter = page.getByRole('combobox').filter({ has: page.getByRole('option', { name: 'All Printers', exact: true }) });
      await expect(printerFilter).toBeVisible();
      await printerFilter.selectOption({ label: 'Tim Voron' });
      await page.getByRole('button', { name: 'Calendar view', exact: true }).click();

      const monthHeading = page.getByRole('heading', { name: 'September 2026', exact: true });
      await expect(monthHeading).toBeVisible();
      const month = monthHeading.locator('../../../');
      const completedDay = month.getByRole('button', { name: /^21\s+1$/ });
      const cancelledDay = month.getByRole('button', { name: /^22\s+2$/ });
      const failedDay = month.getByRole('button', { name: /^23\s+1$/ });
      await expect(completedDay).toBeVisible();
      await expect(cancelledDay).toBeVisible();
      await expect(failedDay).toBeVisible();

      await cancelledDay.click();
      const cancelledRows = [
        'Voron_Design_Cube_v8_PLA_25m0s',
        'Voron_Design_Cube_v8',
      ].map((name) => page.getByRole('button').filter({
        has: page.getByText(name, { exact: true }),
      }));
      for (const row of cancelledRows) {
        await expect(row).toHaveCount(1);
        await expect(row).not.toContainText('Completed');
        await expect(row).not.toContainText('Failed');
        const status = row.getByText(/cancel/i);
        await expect(status).toBeVisible();
      }

      const successfulCount = page.getByText('Successful', { exact: true }).locator('..').locator('div').first();
      await expect(successfulCount).toHaveText('1');

      await completedDay.click();
      const completedRow = page.getByRole('button').filter({ hasText: 'Fixture completed print' });
      await expect(completedRow).toContainText('Completed');
      const completedColor = await completedRow.getByText('Completed', { exact: true }).evaluate(
        (element) => getComputedStyle(element).color,
      );

      await failedDay.click();
      const failedRow = page.getByRole('button').filter({ hasText: 'Fixture failed print' });
      await expect(failedRow).toContainText('Failed');
      const failedColor = await failedRow.getByText('Failed', { exact: true }).evaluate(
        (element) => getComputedStyle(element).color,
      );
      expect(failedColor).not.toBe(completedColor);

      await cancelledDay.click();
      for (const row of cancelledRows) {
        const cancellationStatus = row.getByText(/cancel/i);
        await expect(cancellationStatus).toBeVisible();
        const cancellationColor = await cancellationStatus.evaluate(
          (element) => getComputedStyle(element).color,
        );
        expect(cancellationColor).not.toBe(completedColor);
      }
    } finally {
      expect(blockedWrites, 'Archive Calendar browsing must not write archive or printer data').toEqual([]);
      expect(externalRequests, 'The fixture must not contact external services').toEqual([]);
    }
  });
}
