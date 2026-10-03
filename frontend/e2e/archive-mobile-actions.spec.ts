import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block', locale: 'en-US', timezoneId: 'Europe/Stockholm' });

const filename = 'fixture-voron-gantry-bracket-revision-03.gcode.3mf';
const printerName = 'Fixture Voron Trident';
const permissions = ['archives:read', 'archives:reprint_all', 'archives:update_all', 'archives:delete_all', 'queue:create'];

async function openArchives(page: Page, width: number, mode: 'grid' | 'list', availability = 'enabled') {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript((view) => {
    localStorage.setItem('archiveViewMode', view);
    localStorage.setItem('auth_token', 'fictional-archive-token');
    localStorage.setItem('bambutrack_language', 'en');
  }, mode);
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
        return route.fulfill({ json: { token: 'fictional-stream-token' } });
      }
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only archive fixture' } });
    }
    const archive = {
      id: 166, filename, print_name: null, printer_id: 166,
      file_path: availability === 'missing-file' ? null : '/fictional/fixture.gcode.3mf',
      file_size: 3145728, status: 'completed', thumbnail_path: null,
      created_at: '2026-10-01T10:00:00Z', created_by_id: 901, created_by_username: 'Fixture Alice',
      tags: null, notes: null, photos: [], duplicate_count: 0, print_count: 0,
      filament_type: 'PLA', sliced_for_model: 'Voron Trident',
      external_url: 'https://example.invalid/fictional-archive',
    };
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: true, requires_setup: false };
    if (path.endsWith('/auth/me')) body = {
      id: 901, username: 'Fixture Alice', groups: [],
      permissions: permissions.filter((permission) =>
        availability === 'no-queue-permission' ? permission !== 'queue:create'
          : availability === 'no-archive-permission' ? permission !== 'archives:reprint_all' : true),
    };
    if (path.endsWith('/settings')) body = { check_updates: false, currency: 'USD' };
    // Inactive fictional printer keeps PrintModal from selecting a target or running material preflight.
    if (path === '/api/v1/printers') body = [{ id: 166, name: printerName, model: 'Voron', provider: 'moonraker', is_active: false }];
    if (path === '/api/v1/archives') body = [archive];
    if (path === '/api/v1/archives/166') body = archive;
    if (path.endsWith('/archives/stats')) body = { total_archives: 1, total_print_time_seconds: 0, total_filament_grams: 0 };
    if (path.endsWith('/plates')) body = { is_multi_plate: false, plates: [] };
    if (path.endsWith('/filament-requirements')) body = { filaments: [] };
    await route.fulfill({ json: body });
  });
  await page.goto('/archives');
  const archive = page.locator('[data-archive-id="166"]');
  await expect(archive).toBeVisible();
  return { archive, writes };
}

for (const width of [390, 1440]) {
  test(`grid Print is named and visible and opens only confirmation at ${width}px`, async ({ page }) => {
    const { archive, writes } = await openArchives(page, width, 'grid');
    const print = archive.getByRole('button', { name: 'Print', exact: true });
    await expect(print).toBeEnabled();
    await expect(print.getByText('Print', { exact: true })).toBeVisible();
    await print.click();
    await expect(page.getByRole('heading', { name: 'Print', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Print', exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  for (const { availability, explanation } of [
    { availability: 'missing-file', explanation: 'No 3MF file available — the file could not be downloaded from the printer when the print was recorded' },
    { availability: 'no-queue-permission', explanation: 'You do not have permission to add to queue' },
    { availability: 'no-archive-permission', explanation: 'You do not have permission to reprint' },
  ]) {
    test(`grid Print retains its ${availability} explanation at ${width}px`, async ({ page }) => {
      const { archive, writes } = await openArchives(page, width, 'grid', availability);
      const print = archive.getByRole('button', { name: 'Print', exact: true });
      await expect(print).toBeDisabled();
      await expect(print).toHaveAttribute('title', explanation);
      await expect(print.getByText('Print', { exact: true })).toBeVisible();
      expect(writes).toEqual([]);
    });
  }
}

test('mobile list keeps the filename and metadata readable with separate reachable actions', async ({ page }) => {
  const { archive, writes } = await openArchives(page, 390, 'list');
  const name = archive.getByText(filename, { exact: true });
  await expect(name).toBeVisible();
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const metadata = [name, archive.getByText(printerName, { exact: true }), archive.getByText('Oct 1, 2026', { exact: true }), archive.getByText(/^3(?:\.0)? MB$/)];
  const actions = ['Print', 'Open in Slicer', 'External Link', 'Download', 'Edit', 'Delete', 'Right-click for more options'];
  const bounds = [];
  const row = await archive.boundingBox();
  expect(row).not.toBeNull();
  for (const control of [...metadata, ...actions.map((title) => archive.getByTitle(title, { exact: true }))]) {
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(row!.x);
    expect(box!.x + box!.width).toBeLessThanOrEqual(row!.x + row!.width);
    bounds.push(box!);
  }
  for (const action of bounds.slice(metadata.length)) {
    for (const text of bounds.slice(0, metadata.length)) {
      expect(action.x >= text.x + text.width || action.x + action.width <= text.x || action.y >= text.y + text.height || action.y + action.height <= text.y).toBe(true);
    }
  }
  const buttons = bounds.slice(metadata.length);
  for (let i = 0; i < buttons.length; i++) {
    for (const other of buttons.slice(i + 1)) {
      const button = buttons[i];
      expect(button.x >= other.x + other.width || button.x + button.width <= other.x || button.y >= other.y + other.height || button.y + button.height <= other.y).toBe(true);
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await archive.getByTitle('Print', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Print', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await archive.getByTitle('Right-click for more options', { exact: true }).click();
  await expect(page.locator('.fixed.z-50').getByRole('button', { name: 'Print', exact: true })).toBeVisible();
  expect(writes).toEqual([]);
});

test('desktop list retains its columns and existing Print confirmation', async ({ page }) => {
  const { archive, writes } = await openArchives(page, 1440, 'list');
  const header = archive.locator('..').getByText('Actions', { exact: true });
  await expect(header).toBeVisible();
  for (const title of ['Name', 'Printer', 'Date', 'Size']) await expect(archive.locator('..').getByText(title, { exact: true })).toBeVisible();
  await expect(archive.getByText(filename, { exact: true })).toBeVisible();
  await expect(archive.getByText(printerName, { exact: true })).toBeVisible();
  await archive.getByTitle('Print', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Print', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes).toEqual([]);
});
