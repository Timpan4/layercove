import { test, expect } from './test';

test.use({ serviceWorkers: 'block', locale: 'en-US', timezoneId: 'Europe/Stockholm' });

for (const width of [1440, 390]) {
  test.describe(`overnight timeline range at ${width}px`, () => {
    let writes: string[];
    test.beforeEach(async ({ page }) => {
      writes = [];
      await page.setViewportSize({ width, height: 844 });
      await page.clock.setFixedTime(new Date('2026-10-01T07:23:00Z'));
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/\/$/, '');
        if (request.method() === 'POST' && (path.endsWith('/auth/ws-token') || path.endsWith('/camera/stream-token'))) {
          return route.fulfill({ json: { token: 'fictional-stream-token' } });
        }
        if (request.method() !== 'GET') {
          writes.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 405, json: { detail: 'Read-only fixture' } });
        }
        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { check_updates: false };
        if (path === '/api/v1/printers') body = [{ id: 170, name: 'Fixture Voron', model: 'Voron', is_active: true }];
        // History keeps the Timeline view available without any printable job.
        if (path === '/api/v1/queue') body = [{
          id: 170, printer_id: 170, archive_id: null, position: 1,
          status: 'completed', created_at: '2026-09-30T10:00:00Z',
        }];
        await route.fulfill({ json: body });
      });
      await page.goto('/queue');
      await page.getByRole('button', { name: 'Timeline', exact: true }).click();
    });

    test.afterEach(() => { expect(writes).toEqual([]); });

    for (const window of [
      { name: 'initial', action: null, text: 'Thu, Oct 1, 09:00 AM → Fri, Oct 2, 09:00 AM' },
      { name: 'back', action: 'Back 12 hours', text: 'Wed, Sep 30, 09:00 PM → Thu, Oct 1, 09:00 PM' },
      { name: 'forward', action: 'Forward 12 hours', text: 'Thu, Oct 1, 09:00 PM → Fri, Oct 2, 09:00 PM' },
    ]) {
      test(`${window.name} window displays both days without clipping its controls`, async ({ page }) => {
        if (window.action) await page.getByTitle(window.action, { exact: true }).click();
        const range = page.getByText(window.text, { exact: true });
        await expect(range).toBeVisible();
        const bounds = await range.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        for (const title of ['Back 12 hours', 'Forward 12 hours']) {
          const button = page.getByTitle(title, { exact: true });
          await expect(button).toBeVisible();
          const box = await button.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        }
        if (window.action) {
          await page.getByRole('button', { name: 'Now', exact: true }).click();
          await expect(page.getByText('Thu, Oct 1, 09:00 AM → Fri, Oct 2, 09:00 AM', { exact: true })).toBeVisible();
        }
      });
    }
  });
}
