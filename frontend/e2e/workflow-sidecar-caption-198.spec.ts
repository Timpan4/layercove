import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const startupTokenRequests = new Set([
  'POST /api/v1/printers/camera/stream-token',
  'POST /api/v1/auth/ws-token',
]);

for (const width of [390, 1440]) {
  for (const language of ['en', 'de'] as const) {
    for (const slicer of [
      { value: 'orcaslicer', placeholder: 'http://localhost:3003', en: 'OrcaSlicer sidecar URL', de: 'OrcaSlicer Sidecar-URL' },
      { value: 'bambu_studio', placeholder: 'http://localhost:3001', en: 'Bambu Studio sidecar URL', de: 'Bambu Studio Sidecar-URL' },
    ] as const) {
      test(`Workflow ${slicer.value} URL caption names and focuses its field in ${language} at ${width}px`, async ({ page }) => {
        const writes: string[] = [];
        await page.setViewportSize({ width, height: 1000 });
        await page.addInitScript((locale) => {
          localStorage.setItem('bambutrack_language', locale);
        }, language);
        await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
        await page.route('**/*', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== appOrigin) return route.abort();
          if (request.method() !== 'GET') {
            writes.push(`${request.method()} ${url.pathname}`);
            return route.fulfill({ status: 405, json: { detail: 'Read-only sidecar caption fixture' } });
          }
          return route.continue();
        });
        await page.route((url) => url.origin === appOrigin && url.pathname.startsWith('/api/'), async (route) => {
          const request = route.request();
          const path = new URL(request.url()).pathname.replace(/\/+$/, '');
          if (request.method() !== 'GET') {
            writes.push(`${request.method()} ${path}`);
            return route.fulfill({ status: 405, json: { detail: 'Read-only sidecar caption fixture' } });
          }
          const body = path.endsWith('/auth/status')
            ? { auth_enabled: false, requires_setup: false }
            : path.endsWith('/settings')
              ? {
                language, date_format: 'system', time_format: 'system', currency: 'USD',
                use_slicer_api: true, preferred_slicer: slicer.value,
                orcaslicer_api_url: 'http://localhost:3003',
                bambu_studio_api_url: 'http://localhost:3001',
              }
              : [];
          return route.fulfill({ json: body });
        });

        await page.goto('/settings?tab=queue&sub=dispatch');
        const card = page.locator('#card-slicer');
        await expect(card.getByRole('heading', { name: 'Slicer', exact: true })).toBeVisible();
        const caption = slicer[language];
        const field = card.getByPlaceholder(slicer.placeholder, { exact: true });
        await expect(field).toBeVisible();
        await expect(field).toHaveValue(slicer.placeholder);
        await card.getByText(caption, { exact: true }).click();
        await expect.soft(field).toBeFocused();
        await expect.soft(field).toHaveAccessibleName(caption);
        expect(writes.filter((write) => !startupTokenRequests.has(write))).toEqual([]);
      });
    }
  }
}
