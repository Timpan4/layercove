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
  test(`Inventory cards expose keyboard Edit and restore focus after cancel at ${width}px`, async ({ page }, testInfo) => {
    const blockedWrites: string[] = [];
    const externalRequests: string[] = [];

    await page.setViewportSize({ width, height });
    await page.addInitScript(() => {
      localStorage.setItem('bambutrack_language', 'en');
      localStorage.setItem('auth_token', 'fictional-inventory-card-token');
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
          return route.fulfill({ json: { token: 'fictional-inventory-card-startup-token' } });
        }
        blockedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only inventory card fixture' } });
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
      const cards = page.getByRole('button', { name: 'Cards', exact: true });
      await cards.click();
      await expect(cards).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('table')).toHaveCount(0);

      for (const spool of spools) {
        const heading = page.getByRole('heading', { name: `${spool.material} ${spool.subtype}`, exact: true });
        await expect(heading).toBeVisible();
        // Find the card by its visible spool heading and existing separate actions.
        const card = page.locator('div')
          .filter({ has: heading })
          .filter({ has: page.getByRole('button', { name: 'Copy Spool', exact: true }) })
          .filter({ has: page.getByRole('button', { name: 'Print label for this spool', exact: true }) })
          .last();
        await expect(card).toContainText(`#${spool.id}`);
        await expect(card.getByRole('button', { name: 'Copy Spool', exact: true })).toHaveCount(1);
        await expect(card.getByRole('button', { name: 'Print label for this spool', exact: true })).toHaveCount(1);

        const edit = card.getByRole('button', { name: /Edit/i });
        await expect(edit).toHaveCount(1);
        await expect(edit).toBeVisible();
        expect(await card.getByRole('button').evaluateAll((buttons) =>
          buttons.every((button) => button.tagName === 'BUTTON' && !button.parentElement?.closest('button')),
        ), 'Card actions are separate native buttons, without button ancestors').toBe(true);
        await edit.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(edit).toBeFocused();
        await page.keyboard.press(spool.id === 1 ? 'Enter' : 'Space');

        const dialog = page.getByRole('dialog', { name: `Edit Spool #${spool.id}`, exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(1);
        await testInfo.attach(`spool-${spool.id}-editor-${width}`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
        const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
        await cancel.focus();
        await page.keyboard.press('Enter');
        await expect(dialog).toHaveCount(0);
        await expect(edit).toBeFocused();

        // Preserve the existing pointer path without saving the draft.
        await heading.click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(heading).toBeVisible();
      }

      await testInfo.attach(`inventory-cards-${width}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    } finally {
      expect(blockedWrites, 'Block and detect every non-startup write').toEqual([]);
      expect(externalRequests, 'Do not contact external origins').toEqual([]);
    }
  });
}
