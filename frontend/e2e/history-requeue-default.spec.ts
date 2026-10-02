import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const helpQueue = 'Print will be added to the back of the queue.';
const helpAsap = 'Print will be added to the top of the queue and start as soon as an eligible printer is idle.';

for (const width of [1280, 390]) {
  test.describe(`scheduling defaults at ${width}px`, () => {
    let unexpectedWrites: string[];

    test.beforeEach(async ({ page }) => {
      unexpectedWrites = [];
      await page.setViewportSize({ width, height: 844 });
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/\/$/, '');
        if (request.method() === 'POST' && (path.endsWith('/auth/ws-token') || path.endsWith('/camera/stream-token'))) {
          return route.fulfill({ json: { token: 'test-stream-token' } });
        }
        if (request.method() !== 'GET') {
          unexpectedWrites.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 405, json: { detail: 'Read-only test fixture' } });
        }
        let body: unknown = [];
        const file = {
          id: 8, filename: 'completed-cube.gcode', file_type: 'gcode', file_size: 1024,
          folder_id: null, thumbnail_path: null, print_count: 1, duplicate_count: 0,
          created_at: '2026-10-02T07:00:00Z', tags: [],
        };
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { check_updates: false, currency: 'USD' };
        if (path === '/api/v1/queue') body = [{
          id: 1, printer_id: null, archive_id: null, library_file_id: file.id,
          library_file_name: file.filename, position: 1, status: 'completed',
          created_at: file.created_at, completed_at: '2026-10-02T09:00:00Z',
        }];
        if (path.endsWith('/library/files')) body = [file];
        if (path.endsWith('/library/files/8')) body = file;
        if (path.endsWith('/library/stats')) body = { total_files: 1, total_folders: 0, total_size_bytes: 1024 };
        if (path.endsWith('/library/trash')) body = { total: 0, items: [] };
        if (path.endsWith('/plates')) body = { is_multi_plate: false, plates: [] };
        if (path.endsWith('/filament-requirements')) body = { filaments: [] };
        await route.fulfill({ json: body });
      });
    });

    test.afterEach(() => {
      expect(unexpectedWrites).toEqual([]);
    });

    test('History requeue starts at the back of the queue and still offers explicit ASAP', async ({ page }) => {
      await page.goto('/queue');
      await page.getByRole('button', { name: 'History 1', exact: true }).click();
      await page.getByTitle('Re-queue', { exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Queue', exact: true })).toBeVisible();
      await expect(page.locator('form button[type="submit"]')).toHaveText('Queue');
      await expect(page.getByText(helpQueue, { exact: true })).toBeVisible();
      await expect(page.getByLabel('Require manual start', { exact: true })).toBeVisible();
      await expect(page.getByText(helpAsap, { exact: true })).toHaveCount(0);

      await page.getByRole('button', { name: 'ASAP', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Print', exact: true })).toBeVisible();
      await expect(page.locator('form button[type="submit"]')).toHaveText('Print');
      await expect(page.getByText(helpAsap, { exact: true })).toBeVisible();
      await expect(page.getByLabel('Require manual start', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Print', exact: true })).toHaveCount(0);
    });

    test('File Manager Print keeps its ASAP default', async ({ page }) => {
      await page.goto('/files');
      await page.getByRole('button', { name: 'Actions: completed-cube.gcode', exact: true }).click();
      await page.getByRole('button', { name: 'Print', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Print', exact: true })).toBeVisible();
      await expect(page.getByText(helpAsap, { exact: true })).toBeVisible();
      await expect(page.getByLabel('Require manual start', { exact: true })).toHaveCount(0);
      await expect(page.getByText(helpQueue, { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    });
  });
}
