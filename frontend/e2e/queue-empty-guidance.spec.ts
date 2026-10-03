import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [1440, 390]) {
  test.describe(`empty active queue at ${width}px`, () => {
    let writes: string[];
    let preflights: unknown[];
    let queueState: 'empty' | 'history' | 'error' | 'loading';
    let releaseQueue: () => void;
    let queueReady: Promise<void>;

    test.beforeEach(async ({ page }) => {
      writes = [];
      preflights = [];
      queueState = 'empty';
      queueReady = new Promise<void>((resolve) => { releaseQueue = resolve; });
      await page.setViewportSize({ width, height: 844 });
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname.replace(/\/$/, '');
        if (request.method() === 'POST' && (path.endsWith('/auth/ws-token') || path.endsWith('/camera/stream-token'))) {
          return route.fulfill({ json: { token: 'fictional-stream-token' } });
        }
        // Existing PrintModal preflight is read-only, not a queue submission.
        if (request.method() === 'POST' && path === '/api/v1/queue/material-check') {
          preflights.push(request.postDataJSON());
          return route.fulfill({ json: {
            external_spool: true, supports_ams: false, material_unknown: false,
            filaments: [], blocking: [], advisories: [], confirmation_key: null,
          } });
        }
        if (request.method() !== 'GET') {
          writes.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 405, json: { detail: 'Read-only fixture' } });
        }
        let body: unknown = [];
        const archive = {
          id: 174, filename: 'fixture-cube.gcode.3mf', print_name: 'Fixture cube',
          file_path: '/fictional/fixture-cube.gcode.3mf', status: 'completed',
          created_at: '2026-10-01T12:00:00Z', tags: null, photos: [],
          filament_used_grams: 12, print_time_seconds: 600, duplicate_count: 0,
        };
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { check_updates: false, currency: 'USD' };
        if (path === '/api/v1/printers') body = [{ id: 174, name: 'Fixture Voron', model: 'Voron', is_active: true }];
        if (path === '/api/v1/queue') {
          if (queueState === 'loading') await queueReady;
          if (queueState === 'error') return route.fulfill({ status: 503, json: { detail: 'Fixture queue unavailable' } });
          body = queueState === 'history' && !url.searchParams.has('printer_id') ? [{
            id: 174, archive_id: 174, archive_name: 'Fixture cube', printer_id: null,
            status: 'completed', position: 1, created_at: archive.created_at,
          }] : [];
        }
        if (path === '/api/v1/archives') body = [archive];
        if (path === '/api/v1/archives/174') body = archive;
        if (path.endsWith('/plates')) body = { is_multi_plate: false, plates: [] };
        if (path.endsWith('/filament-requirements')) body = { filaments: [] };
        await route.fulfill({ json: body });
      });
    });

    test.afterEach(async ({ page }, testInfo) => {
      releaseQueue();
      expect(writes).toEqual([]);
      await testInfo.attach('read-only-fixture-requests', {
        body: JSON.stringify({ url: page.url(), writes, preflights }), contentType: 'application/json',
      });
    });

    for (const state of ['empty', 'history'] as const) {
      test(`${state} records explain the active queue and lead to the existing Queue form`, async ({ page }) => {
        queueState = state;
        await page.goto('/queue');
        await expect(page.getByRole('heading', { name: 'No prints scheduled', exact: true })).toBeVisible();
        await expect(page.getByText('Open Archives, choose Print for a file, then select Queue.', { exact: true })).toBeVisible();
        await page.getByTitle('Group by Printer', { exact: true }).click();
        await expect(page.getByRole('heading', { name: 'No prints scheduled', exact: true })).toBeVisible();
        const link = page.getByRole('main').getByRole('link', { name: 'Archives', exact: true });
        await expect(link).toHaveAttribute('href', '/archives');
        await link.click();
        await expect(page).toHaveURL(/\/archives$/);
        await expect(page.getByRole('heading', { name: 'Archives', exact: true })).toBeVisible();
        await page.getByTitle('Right-click for more options', { exact: true }).click();
        await page.locator('.fixed.z-50').getByRole('button', { name: 'Print', exact: true }).click();
        await page.getByRole('button', { name: 'Queue', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
        await expect(page.getByText('Print will be added to the back of the queue.', { exact: true })).toBeVisible();
        await expect(page.locator('form button[type="submit"]')).toHaveText('Queue');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      });
    }

    test('a printer filter with no matches can be cleared without adding work', async ({ page }) => {
      queueState = 'history';
      await page.goto('/queue');
      await page.getByRole('combobox').first().selectOption('174');
      await expect(page.getByRole('heading', { name: 'No prints match the current filters', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'No prints scheduled', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await expect(page.getByRole('combobox').first()).toHaveValue('');
      await expect(page.getByRole('heading', { name: 'No prints scheduled', exact: true })).toBeVisible();
    });

    test('a queue request error is shown and a read-only retry can recover', async ({ page }) => {
      queueState = 'error';
      await page.goto('/queue');
      await expect(page.getByRole('alert')).toHaveText('Error loading data');
      await expect(page.getByRole('heading', { name: 'No prints scheduled', exact: true })).toHaveCount(0);
      queueState = 'empty';
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'No prints scheduled', exact: true })).toBeVisible();
    });

    test('pending loading is distinct from a successfully loaded empty queue', async ({ page }) => {
      queueState = 'loading';
      await page.goto('/queue');
      await expect(page.getByRole('main').getByText('Loading...', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'No prints scheduled', exact: true })).toHaveCount(0);
      queueState = 'empty';
      releaseQueue();
      await expect(page.getByRole('heading', { name: 'No prints scheduled', exact: true })).toBeVisible();
    });
  });
}
