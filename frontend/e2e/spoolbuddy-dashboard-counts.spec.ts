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
  { id: 1, material: 'PLA', brand: 'Fictional Violet Brand', rgba: '7755AAFF' },
  { id: 2, material: 'PETG', brand: 'Fictional Teal Brand', rgba: '336699FF' },
].map((spool) => ({
  ...spool,
  subtype: null,
  color_name: 'Fictional color',
  tag_uid: null,
  label_weight: 1000,
  core_weight: 200,
  weight_used: 100,
  category: 'Fictional inventory',
  archived_at: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}));

// Issue237 requires zero/one/multiple labels in the active language.
// Expected words are independent of the application's translation keys.
const cases = [
  { count: 0, en: ['Materials', 'Brands'], de: ['Materialien', 'Marken'] },
  { count: 1, en: ['Material', 'Brand'], de: ['Material', 'Marke'] },
  { count: 2, en: ['Materials', 'Brands'], de: ['Materialien', 'Marken'] },
] as const;

for (const language of ['en', 'de'] as const) {
  for (const scenario of cases) {
    for (const [width, height] of [[390, 844], [1440, 900]] as const) {
      test(`SpoolBuddy names ${scenario.count} materials and brands in ${language} at ${width}px`, async ({ page }, testInfo) => {
        const blockedWrites: string[] = [];
        const externalRequests: string[] = [];
        const spools = fixtures.slice(0, scenario.count);

        await page.setViewportSize({ width, height });
        await page.addInitScript((locale) => {
          localStorage.setItem('bambutrack_language', locale);
          localStorage.setItem('auth_token', 'fictional-spoolbuddy-counts-token');
          localStorage.setItem('bambuddy_appliance_locale_consumed', '1');
        }, language);
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
            return route.fulfill({ status: 405, json: { detail: 'Read-only SpoolBuddy count fixture' } });
          }
          if (!path.startsWith('/api/')) return route.continue();

          let body: unknown = [];
          if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
          if (path === '/api/v1/settings') body = { language, check_updates: false, currency: 'USD' };
          if (path === '/api/v1/settings/spoolman') body = { spoolman_enabled: 'false', spoolman_url: '' };
          if (path === '/api/v1/cloud/status') body = { is_authenticated: false };
          if (path === '/api/v1/orca-cloud/status') body = { connected: false };
          if (path === '/api/v1/local-presets') body = { filament: [], printer: [], process: [] };
          if (path === '/api/v1/inventory/spools') body = spools;
          // No printer/device is connected, so no hardware action is available.
          if (path === '/api/v1/printers' || path === '/api/v1/spoolbuddy/devices') body = [];
          return route.fulfill({ json: body });
        });

        try {
          const inventoryLoaded = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return url.origin === appOrigin && url.pathname === '/api/v1/inventory/spools'
              && response.request().method() === 'GET' && response.ok();
          });
          await page.goto('/spoolbuddy', { waitUntil: 'domcontentloaded' });
          await inventoryLoaded;
          await expect(page.getByRole('link', {
            name: language === 'en' ? 'Dashboard' : 'Übersicht', exact: true,
          })).toHaveAttribute('aria-current', 'page');

          // The first visible group in the real dashboard is its inventory summary.
          const summary = page.getByRole('main').locator(':scope > div > div').first();
          const groups = summary.locator(':scope > div').filter({ has: page.locator('span') });
          await expect(summary).toBeVisible();
          await expect(groups).toHaveCount(3);
          for (const group of await groups.all()) {
            await expect(group.locator('span').first()).toHaveText(String(scenario.count));
          }
          await expect.soft(groups.nth(1).locator('span').last()).toHaveText(scenario[language][0]);
          await expect.soft(groups.nth(2).locator('span').last()).toHaveText(scenario[language][1]);

          await testInfo.attach(`spoolbuddy-counts-${language}-${scenario.count}-${width}`, {
            body: await page.screenshot(),
            contentType: 'image/png',
          });
        } finally {
          expect(blockedWrites, 'Block and detect all non-startup writes').toEqual([]);
          expect(externalRequests, 'Do not contact external HTTP or WebSocket origins').toEqual([]);
        }
      });
    }
  }
}
