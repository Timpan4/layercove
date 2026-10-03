import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

async function openQueue(page: Page, width: number, count: number, language = 'en') {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript((lng) => {
    localStorage.setItem('bambutrack_language', lng);
    localStorage.setItem('queue.activeTab', 'queue');
    localStorage.setItem('queue.activeLayout', 'position');
  }, language);
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
        return route.fulfill({ json: { token: 'fictional-token' } });
      }
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only queue count fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false, currency: 'USD' };
    if (path === '/api/v1/queue') body = ['pending', 'completed'].flatMap((status, group) =>
      Array.from({ length: count }, (_, index) => ({
        id: group * 100 + index + 1, printer_id: null, target_model: 'Fixture Model',
        archive_id: null, library_file_id: null, filename: `fictional-${status}-${index + 1}.gcode`,
        position: index + 1, status, created_at: '2026-10-02T07:00:00Z',
        completed_at: status === 'completed' ? '2026-10-02T09:00:00Z' : null,
      })));
    await route.fulfill({ json: body });
  });
  await page.goto('/queue');
  return writes;
}

for (const width of [1440, 390]) {
  for (const count of [1, 4]) {
    const text = `${count} ${count === 1 ? 'item' : 'items'}`;
    test(`pending count says ${text} at ${width}px`, async ({ page }) => {
      const writes = await openQueue(page, width, count);
      await expect(page.getByRole('heading', { name: new RegExp(`^Queued \\(${text}\\)`) })).toBeVisible();
      expect(writes).toEqual([]);
    });
    test(`history count says ${text} at ${width}px`, async ({ page }) => {
      const writes = await openQueue(page, width, count);
      await page.getByRole('button', { name: `History ${count}`, exact: true }).click();
      await expect(page.getByRole('heading', { name: `History (${text})`, exact: true })).toBeVisible();
      expect(writes).toEqual([]);
    });
    test(`printer aggregate says ${text} at ${width}px`, async ({ page }) => {
      const writes = await openQueue(page, width, count);
      await page.getByTitle('Group by Printer', { exact: true }).click();
      await expect(page.getByText('Any Fixture Model', { exact: true }).first()).toBeVisible();
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      expect(writes).toEqual([]);
    });
  }
}

for (const { language, width, singular, plural, caption } of [
  { language: 'de', width: 1440, singular: '1 Element', plural: '4 Elemente', caption: 'In Warteschlange' },
  { language: 'ja', width: 390, singular: '1件', plural: '4件', caption: 'キュー中' },
]) {
  test(`pending count follows selected ${language} locale at ${width}px`, async ({ page }) => {
    for (const [count, wording] of [[1, singular], [4, plural]] as const) {
      const writes = await openQueue(page, width, count, language);
      await expect(page.getByRole('heading', { name: new RegExp(`^${caption} \\(${wording}\\)`) })).toBeVisible();
      expect(writes).toEqual([]);
    }
  });
}
