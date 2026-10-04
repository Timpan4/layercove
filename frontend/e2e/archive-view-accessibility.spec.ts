import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const wsOrigin = new URL(appOrigin);
wsOrigin.protocol = wsOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
const startupTokenPaths = new Set([
  '/api/v1/auth/ws-token',
  '/api/v1/printers/camera/stream-token',
]);

const archives = [
  { id: 2491, filename: 'fictional-pla.gcode', print_name: 'Fictional PLA archive', filament_type: 'PLA', day: 21 },
  { id: 2492, filename: 'fictional-petg.gcode', print_name: 'Fictional PETG archive', filament_type: 'PETG', day: 22 },
].map(({ day, ...archive }) => ({
  ...archive,
  printer_id: 1,
  status: 'completed',
  created_at: `2026-09-${day}T12:00:00Z`,
  completed_at: `2026-09-${day}T12:30:00Z`,
  file_size: 1024,
  duplicate_count: 0,
  duplicate_sequence: 0,
}));

const logEntries = [
  { id: 2531, status: 'completed', created_by_username: 'Fictional Alice', day: 21 },
  { id: 2532, status: 'completed', created_by_username: 'Fictional Bob', day: 22 },
  { id: 2533, status: 'failed', created_by_username: 'Fictional Alice', day: 23 },
  { id: 2534, status: 'cancelled', created_by_username: 'Fictional Bob', day: 24 },
].map(({ day, ...entry }) => ({
  ...entry,
  archive_id: null,
  print_name: `Fictional log ${entry.id}`,
  printer_id: 1,
  printer_name: 'Tim Voron',
  started_at: `2026-09-${day}T12:00:00Z`,
  completed_at: `2026-09-${day}T12:30:00Z`,
  created_at: `2026-09-${day}T12:00:00Z`,
  duration_seconds: 1800,
  filament_type: 'PLA',
  filament_color: null,
  filament_used_grams: 10,
  cost: null,
  energy_kwh: null,
  energy_cost: null,
  failure_reason: null,
  thumbnail_path: null,
  created_by_id: null,
}));

async function withArchives(page: Page, run: () => Promise<void>) {
  const blockedWrites: string[] = [];
  const externalRequests: string[] = [];

  await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('bambutrack_language', 'en');
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('archive') || key.startsWith('logFilter') || key === 'logOffset' || key === 'logPageSize') {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem('archiveViewMode', 'calendar');
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
        return route.fulfill({ json: { token: 'fictional-archive-view-token' } });
      }
      blockedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only Archives fixture' } });
    }
    if (!path.startsWith('/api/')) return route.continue();

    let body: unknown = [];
    if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
    if (path === '/api/v1/settings') body = { language: 'en', check_updates: false };
    if (path === '/api/v1/printers') {
      body = [{ id: 1, name: 'Tim Voron', provider: 'moonraker', model: 'Voron 2.4', is_active: true }];
    }
    if (path === '/api/v1/users') {
      body = [{ id: 1, username: 'Fictional Alice' }, { id: 2, username: 'Fictional Bob' }];
    }
    if (path === '/api/v1/archives') {
      const printer = url.searchParams.get('printer_id');
      body = archives.filter((archive) => !printer || String(archive.printer_id) === printer);
    }
    if (path === '/api/v1/archives/no-3mf-warning') body = { has_fallback: false };
    if (path === '/api/v1/print-log') {
      const params = url.searchParams;
      const filtered = logEntries.filter((entry) =>
        (!params.get('printer_id') || String(entry.printer_id) === params.get('printer_id')) &&
        (!params.get('created_by_username') || entry.created_by_username === params.get('created_by_username')) &&
        (!params.get('status') || entry.status === params.get('status')) &&
        (!params.get('date_from') || entry.started_at.slice(0, 10) >= params.get('date_from')!) &&
        (!params.get('date_to') || entry.started_at.slice(0, 10) <= params.get('date_to')!) &&
        (!params.get('search') || entry.print_name.toLowerCase().includes(params.get('search')!.toLowerCase())),
      );
      const offset = Number(params.get('offset') || 0);
      const limit = Number(params.get('limit') || 25);
      body = { items: filtered.slice(offset, offset + limit), total: filtered.length };
    }
    return route.fulfill({ json: body });
  });

  try {
    await page.goto('/archives', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'September 2026', exact: true })).toBeVisible();
    await run();
  } finally {
    expect(blockedWrites, 'Block and detect every non-startup write').toEqual([]);
    expect(externalRequests, 'Do not contact external services').toEqual([]);
  }
}

for (const [width, height] of [[390, 844], [1440, 1000]] as const) {
  for (const filter of [
    { purpose: 'Period', name: /period|collection/i, value: 'this-month' },
    { purpose: 'Printer', name: /printer/i, value: '1' },
    { purpose: 'Material', name: /material/i, value: 'PETG' },
    { purpose: 'File type', name: /file.*type/i, value: 'gcode' },
    { purpose: 'Sort', name: /sort/i, value: 'date-asc' },
  ]) {
    test(`Archive ${filter.purpose} filter has a usable purpose name at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await withArchives(page, async () => {
        const control = page.getByRole('combobox', { name: filter.name });
        await expect(control).toHaveCount(1);
        await expect(control).toBeVisible();
        await control.selectOption(filter.value);
        await expect(control).toHaveValue(filter.value);
        const day = filter.purpose === 'Material' ? 22 : 21;
        await page.getByRole('button', { name: new RegExp('^' + day + '\\s+1$') }).click();
        const archiveName = filter.purpose === 'Material' ? 'Fictional PETG archive' : 'Fictional PLA archive';
        await expect(page.getByRole('button').filter({ hasText: archiveName })).toBeVisible();
        if (filter.purpose === 'Material') {
          await expect(page.getByRole('button').filter({ hasText: 'Fictional PLA archive' })).toHaveCount(0);
        }
        await testInfo.attach(`archive-${filter.purpose}-${width}`, {
          body: await page.screenshot(), contentType: 'image/png',
        });
      });
    });
  }

  for (const direction of [
    { purpose: 'Previous', name: /prev(?:ious)? month/i, month: 'August 2026' },
    { purpose: 'Next', name: /next month/i, month: 'October 2026' },
  ]) {
    test(`Calendar ${direction.purpose} month action has a usable purpose name at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await withArchives(page, async () => {
        const control = page.getByRole('button', { name: direction.name });
        await expect(control).toHaveCount(1);
        await control.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('heading', { name: direction.month, exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Today', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'September 2026', exact: true })).toBeVisible();
        await page.getByRole('button', { name: /^22\s+1$/ }).click();
        await expect(page.getByRole('button').filter({ hasText: 'Fictional PETG archive' })).toBeVisible();
        await testInfo.attach(`calendar-${direction.purpose}-${width}`, {
          body: await page.screenshot(), contentType: 'image/png',
        });
      });
    });
  }

  for (const field of [
    { purpose: 'Printer', name: /printer/i, value: '1', date: false, ids: [2531, 2532, 2533, 2534] },
    { purpose: 'User', name: /user/i, value: 'Fictional Alice', date: false, ids: [2531, 2533] },
    { purpose: 'Status', name: /status/i, value: 'completed', date: false, ids: [2531, 2532] },
    { purpose: 'Rows', name: /rows/i, value: '10', date: false, ids: [2531, 2532, 2533, 2534] },
    { purpose: 'From', name: /^From$/, value: '2026-09-22', date: true, ids: [2532, 2533, 2534] },
    { purpose: 'To', name: /^To$/, value: '2026-09-23', date: true, ids: [2531, 2532, 2533] },
  ]) {
    test(`Print Log ${field.purpose} field has a usable purpose name at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await withArchives(page, async () => {
        await page.getByRole('button', { name: 'Print Log', exact: true }).click();
        const control = field.date
          ? page.getByLabel(field.purpose, { exact: true })
          : page.getByRole('combobox', { name: field.name });
        await expect(control).toHaveCount(1);
        await expect(control).toBeVisible();
        if (field.date) await control.fill(field.value);
        else await control.selectOption(field.value);
        await expect(control).toHaveValue(field.value);
        const table = page.getByRole('table');
        await expect(table.getByRole('row')).toHaveCount(field.ids.length + 1);
        for (const entry of logEntries) {
          const name = table.getByText(entry.print_name, { exact: true });
          if (field.ids.includes(entry.id)) await expect(name).toBeVisible();
          else await expect(name).toHaveCount(0);
        }
        await expect(page.getByText(`Showing ${field.ids.length} of ${field.ids.length} entries`, { exact: true })).toBeVisible();
        await testInfo.attach(`print-log-${field.purpose}-${width}`, {
          body: await page.screenshot(), contentType: 'image/png',
        });
      });
    });
  }

  test(`Archives summary distinguishes Print Log records at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await withArchives(page, async () => {
      const summary = page.getByRole('heading', { level: 1 }).locator('..').getByRole('paragraph');
      await expect(summary).toHaveText(/.*\b2\b.*(?:prints?|archives?)/i);
      await page.getByRole('button', { name: 'Print Log', exact: true }).click();
      // Option locators keep this regression independent of issue249's naming fix.
      const printer = page.getByRole('combobox').filter({
        has: page.getByRole('option', { name: 'All Printers', exact: true }),
      });
      await printer.selectOption({ label: 'Tim Voron' });
      const table = page.getByRole('table');
      await expect(table.getByRole('row')).toHaveCount(5);
      await expect(page.getByText('Showing 4 of 4 entries', { exact: true })).toBeVisible();
      // The original issue allows either the log total or a clearly labelled archive total.
      await expect(summary).toHaveText(/(?:.*\b4\b.*(?:entr(?:y|ies)|log)|.*\b2\b.*archives?)/i);
      const archivePeriod = page.getByRole('combobox').filter({
        has: page.getByRole('option', { name: 'All Archives', exact: true }),
      });
      if (await archivePeriod.count()) {
        await expect(archivePeriod).toHaveAccessibleName(/archive.*(?:period|collection)|(?:period|collection).*archive/i);
      }

      const status = page.getByRole('combobox').filter({
        has: page.getByRole('option', { name: 'All Statuses', exact: true }),
      });
      await status.selectOption('completed');
      await expect(table.getByRole('row')).toHaveCount(3);
      await expect(table).toContainText('Fictional log 2531');
      await expect(table).toContainText('Fictional log 2532');
      await expect(summary).toHaveText(/.*\b2\b.*(?:entr(?:y|ies)|log|archives?)/i);
      await testInfo.attach(`print-log-summary-${width}`, {
        body: await page.screenshot(), contentType: 'image/png',
      });

      await page.getByRole('button', { name: 'Calendar view', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'September 2026', exact: true })).toBeVisible();
      await expect(summary).toHaveText(/.*\b2\b.*(?:prints?|archives?)/i);
      await page.getByRole('button', { name: /^21\s+1$/ }).click();
      await expect(page.getByRole('button').filter({ hasText: 'Fictional PLA archive' })).toBeVisible();
      await testInfo.attach(`archive-summary-restored-${width}`, {
        body: await page.screenshot(), contentType: 'image/png',
      });
    });
  });
}
