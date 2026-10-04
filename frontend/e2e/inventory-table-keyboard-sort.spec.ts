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
  { id: 1, material: 'PETG', brand: 'Fictional Brand', subtype: 'PETG sample', color_name: 'Fictional teal', rgba: '336699FF' },
  { id: 2, material: 'ABS', brand: 'Fictional Brand', subtype: 'ABS sample', color_name: 'Fictional amber', rgba: 'CC8833FF' },
  { id: 3, material: 'PLA', brand: 'Fictional Brand', subtype: 'PLA sample', color_name: 'Fictional violet', rgba: '7755AAFF' },
].map((spool) => ({
  ...spool,
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
  test(`Inventory table sorting works from the keyboard at ${width}px`, async ({ page }) => {
    const blockedWrites: string[] = [];
    const externalRequests: string[] = [];

    await page.setViewportSize({ width, height });
    await page.addInitScript(() => {
      localStorage.setItem('bambutrack_language', 'en');
      localStorage.setItem('auth_token', 'fictional-inventory-sort-token');
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
          return route.fulfill({ json: { token: 'fictional-inventory-sort-startup-token' } });
        }
        blockedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only inventory sorting fixture' } });
      }

      if (!path.startsWith('/api/')) return route.continue();

      let body: unknown = [];
      if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
      if (path === '/api/v1/settings') body = { language: 'en', check_updates: false, currency: 'USD' };
      if (path === '/api/v1/settings/spoolman') body = { spoolman_enabled: 'false', spoolman_url: '' };
      if (path === '/api/v1/local-presets') body = { filament: [], printer: [], process: [] };
      if (path === '/api/v1/inventory/spools') body = spools;
      if (path === '/api/v1/inventory/locations') body = [{ id: 1, name: 'Fictional shelf' }];
      if (path === '/api/v1/inventory/catalog') body = [{ id: 1, name: 'Fictional spool core', weight: 200 }];
      return route.fulfill({ json: body });
    });

    try {
      await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
      const table = page.getByRole('table');
      await expect(page.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true');
      const materialHeader = table.getByRole('columnheader', { name: 'Material', exact: true });
      await expect(table).toBeVisible();
      await expect(materialHeader).toBeVisible();
      expect([null, 'none']).toContain(await materialHeader.getAttribute('aria-sort'));

      const materialColumnIndex = await materialHeader.evaluate((header) =>
        Array.from(header.parentElement!.children).indexOf(header),
      );
      const materialValues = () => table.locator('tbody tr').evaluateAll(
        (rows, columnIndex) => rows.map((row) => row.children[columnIndex]?.textContent?.trim() ?? ''),
        materialColumnIndex,
      );
      const sortAction = materialHeader.getByRole('button');
      await expect(sortAction).toHaveCount(1);
      await expect(sortAction).toHaveAccessibleName(/Material/);
      await expect(table.getByRole('columnheader', { name: 'Actions', exact: true }).getByRole('button')).toHaveCount(0);
      await expect(materialValues()).resolves.toEqual(['PETG', 'ABS', 'PLA']);

      await sortAction.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(sortAction).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(materialHeader).toHaveAttribute('aria-sort', 'ascending');
      await expect(materialValues()).resolves.toEqual(['ABS', 'PETG', 'PLA']);

      await page.keyboard.press('Space');
      await expect(materialHeader).toHaveAttribute('aria-sort', 'descending');
      await expect(materialValues()).resolves.toEqual(['PLA', 'PETG', 'ABS']);

      await page.keyboard.press('Enter');
      expect([null, 'none']).toContain(await materialHeader.getAttribute('aria-sort'));
      await expect(materialValues()).resolves.toEqual(['PETG', 'ABS', 'PLA']);
    } finally {
      expect(blockedWrites, 'The fixture must block and detect every non-startup write').toEqual([]);
      expect(externalRequests, 'The fixture must not contact external origins').toEqual([]);
    }
  });
}
