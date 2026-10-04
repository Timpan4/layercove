import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const wsOrigin = new URL(appOrigin);
wsOrigin.protocol = wsOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
const startupTokenPaths = new Set([
  '/api/v1/auth/ws-token',
  '/api/v1/printers/camera/stream-token',
]);

const spools = [
  { id: 1, material: 'PLA', subtype: 'Fictional PLA', color_name: 'Fictional violet', rgba: '7755AAFF' },
  { id: 2, material: 'PETG', subtype: 'Fictional PETG', color_name: 'Fictional teal', rgba: '336699FF' },
].map((spool) => ({
  ...spool,
  brand: 'Fictional Brand',
  label_weight: 1000,
  core_weight: 200,
  core_weight_catalog_id: 1,
  weight_used: 100,
  category: 'Fictional inventory',
  location_id: 1,
  archived_at: null,
  note: '',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}));

for (const [width, height] of [[390, 844], [1440, 900]] as const) {
  for (const mode of ['Add', 'Edit'] as const) {
    test(`Spool editor contains keyboard focus for ${mode} and restores its trigger at ${width}px`, async ({ page }, testInfo) => {
      const blockedWrites: string[] = [];
      const externalRequests: string[] = [];

      await page.setViewportSize({ width, height });
      await page.addInitScript(() => {
        localStorage.setItem('bambutrack_language', 'en');
        localStorage.setItem('auth_token', 'fictional-spool-editor-token');
        localStorage.removeItem('bambuddy-inventory-sort');
        localStorage.removeItem('bambuddy-inventory-group');
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

        const path = url.pathname.replace(/\/$/, '');
        if (request.method() !== 'GET') {
          if (request.method() === 'POST' && startupTokenPaths.has(path)) {
            return route.fulfill({ json: { token: 'fictional-spool-editor-startup-token' } });
          }
          blockedWrites.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 405, json: { detail: 'Read-only spool editor fixture' } });
        }
        if (!path.startsWith('/api/')) return route.continue();

        let body: unknown = [];
        if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
        if (path === '/api/v1/settings') body = { language: 'en', check_updates: false, currency: 'USD' };
        if (path === '/api/v1/settings/spoolman') body = { spoolman_enabled: 'false', spoolman_url: '' };
        if (path === '/api/v1/cloud/status') body = { is_authenticated: false };
        if (path === '/api/v1/orca-cloud/status') body = { connected: false };
        if (path === '/api/v1/local-presets') body = { filament: [], printer: [], process: [] };
        if (path === '/api/v1/inventory/spools') body = spools;
        if (path === '/api/v1/inventory/locations') body = [{ id: 1, name: 'Fictional shelf' }];
        if (path === '/api/v1/inventory/catalog') body = [{ id: 1, name: 'Fictional spool core', weight: 200 }];
        return route.fulfill({ json: body });
      });

      try {
        await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
        const table = page.getByRole('table');
        await expect(table).toBeVisible();
        const targetRow = table.getByRole('row').filter({
          has: page.getByRole('cell', { name: '2', exact: true }),
        });
        const trigger = mode === 'Add'
          ? page.getByRole('button', { name: 'Add Spool', exact: true })
          : targetRow.getByRole('button', { name: 'Edit', exact: true });
        await expect(trigger).toHaveCount(1);
        const title = mode === 'Add' ? 'Add Spool' : 'Edit Spool #2';

        for (const dismissal of ['Cancel', 'Escape'] as const) {
          await trigger.focus();
          await page.keyboard.press('Enter');
          const dialog = page.getByRole('dialog', { name: title, exact: true });
          await expect(dialog).toBeVisible();
          await expect.poll(() => dialog.evaluate((element) =>
            element.contains(document.activeElement),
          )).toBe(true);
          await expect(dialog).toHaveAttribute('aria-modal', 'true');

          const first = dialog.getByRole('button', { name: 'Close', exact: true });
          const last = dialog.getByRole('button', {
            name: mode === 'Add' ? 'Add Spool' : 'Save',
            exact: true,
          });
          await last.focus();
          await page.keyboard.press('Tab');
          await expect(first).toBeFocused();
          await page.keyboard.press('Shift+Tab');
          await expect(last).toBeFocused();

          await testInfo.attach(`spool-editor-${mode}-${dismissal}-${width}`, {
            body: await page.screenshot(),
            contentType: 'image/png',
          });
          if (dismissal === 'Cancel') {
            await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
            await page.keyboard.press('Enter');
          } else {
            await page.keyboard.press('Escape');
          }
          await expect(dialog).toHaveCount(0);
          await expect(trigger).toBeFocused();
        }
        await expect(targetRow).toBeVisible();
        await expect(targetRow).toContainText('PETG');
      } finally {
        expect(blockedWrites, 'Block and detect every non-startup write').toEqual([]);
        expect(externalRequests, 'Do not contact external origins').toEqual([]);
      }
    });
  }
}
