import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const wsOrigin = new URL(appOrigin);
wsOrigin.protocol = wsOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
const startupTokenPaths = new Set([
  '/api/v1/auth/ws-token',
  '/api/v1/printers/camera/stream-token',
]);

const fixtures = [
  { id: 1, material: 'PLA', brand: 'eSUN', color_name: 'Fictional Red', rgba: 'CC3333FF' },
  { id: 2, material: 'PETG', brand: 'Fictional Brand', color_name: 'Fictional Blue', rgba: '336699FF' },
].map((spool) => ({
  ...spool,
  subtype: null,
  extra_colors: null,
  effect_type: null,
  label_weight: 1000,
  core_weight: 200,
  core_weight_catalog_id: null,
  weight_used: 100,
  slicer_filament: null,
  slicer_filament_name: null,
  nozzle_temp_min: null,
  nozzle_temp_max: null,
  note: null,
  added_full: null,
  last_used: null,
  encode_time: null,
  tag_uid: null,
  tray_uuid: null,
  data_origin: null,
  tag_type: null,
  archived_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  cost_per_kg: null,
  last_scale_weight: null,
  last_weighed_at: null,
  category: 'Fictional inventory',
}));

for (const [width, height] of [[390, 844], [1440, 900]] as const) {
  test(`SpoolBuddy inventory search filters, clears and recovers at ${width}px`, async ({ page }) => {
    const blockedWrites: string[] = [];
    const externalRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.setViewportSize({ width, height });
    await page.addInitScript(() => {
      localStorage.setItem('bambutrack_language', 'en');
      localStorage.setItem('auth_token', 'fictional-spoolbuddy-search-token');
      localStorage.setItem('bambuddy_appliance_locale_consumed', '1');
    });
    await page.routeWebSocket((url) => {
      if (url.origin !== wsOrigin.origin) externalRequests.push(`WS ${url.origin}${url.pathname}`);
      return true;
    }, (socket) => socket.close());
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
          return route.fulfill({ json: { token: 'fictional-spoolbuddy-startup-token' } });
        }
        blockedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only SpoolBuddy search fixture' } });
      }
      if (!path.startsWith('/api/')) return route.continue();

      let body: unknown = [];
      if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
      if (path === '/api/v1/settings') body = { language: 'en', check_updates: false, currency: 'USD' };
      if (path === '/api/v1/settings/spoolman') body = { spoolman_enabled: 'false', spoolman_url: '' };
      if (path === '/api/v1/cloud/status') body = { is_authenticated: false };
      if (path === '/api/v1/orca-cloud/status') body = { connected: false };
      if (path === '/api/v1/local-presets') body = { filament: [], printer: [], process: [] };
      if (path === '/api/v1/inventory/spools') body = fixtures;
      // No printer/device is connected, so no hardware action is available.
      return route.fulfill({ json: body });
    });

    try {
      await page.goto('/spoolbuddy/inventory', { waitUntil: 'domcontentloaded' });
      const search = page.getByPlaceholder('Search spools...');
      const crash = page.getByText('UI Crash');
      const cards = page.getByRole('main').locator('button').filter({ hasText: /PLA|PETG/ }).filter({ hasText: /\d+g/ });
      await expect(cards).toHaveCount(2);

      await search.pressSequentially('eSUN');
      await expect(crash).toHaveCount(0);
      await expect(search).toHaveValue('eSUN');
      await expect(cards).toHaveCount(1);
      await expect(cards.first()).toContainText('PLA');

      await search.clear();
      await expect(crash).toHaveCount(0);
      await expect(cards).toHaveCount(2);

      await search.pressSequentially('no-such-spool');
      await expect(crash).toHaveCount(0);
      await expect(cards).toHaveCount(0);
      await expect(page.getByText('No spools match your filters')).toBeVisible();

      await search.clear();
      await expect(cards).toHaveCount(2);

      // Kiosk navigation still works after searching.
      await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
      await expect(page).toHaveURL(/\/spoolbuddy\/?$/);
      await expect(crash).toHaveCount(0);
      expect(pageErrors).toEqual([]);
    } finally {
      expect(blockedWrites, 'Block and detect all non-startup writes').toEqual([]);
      expect(externalRequests, 'Do not contact external HTTP or WebSocket origins').toEqual([]);
    }
  });
}
