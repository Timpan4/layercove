import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const language of ['en', 'de']) {
  for (const count of [1, 2]) {
    for (const width of [390, 1440]) {
      test(`CSV preview names ${count} valid rows in ${language} at ${width}px without importing`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 });
        await page.addInitScript((locale) => localStorage.setItem('bambutrack_language', locale), language);
        const writes: string[] = [];
        const previews: string[] = [];
        await page.routeWebSocket(() => true, (socket) => socket.close());
        await page.route('**/*', async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
          if (!url.pathname.startsWith('/api/')) return route.continue();
          if (request.method() === 'POST' && url.pathname === '/api/v1/inventory/spools/import' && url.search === '?dry_run=true') {
            previews.push(url.search);
            return route.fulfill({ json: {
              columns: ['material'], total: count, valid_count: count, error_count: 0, skipped_count: 0,
              warnings: [], rows: Array.from({ length: count }, (_, index) => ({
                row_number: index + 2, status: 'valid', material: 'PLA', brand: 'Fictional', color_name: 'Blue', rgba: '336699FF',
              })),
            } });
          }
          if (request.method() !== 'GET') {
            if (url.pathname.startsWith('/api/v1/inventory/')) writes.push(`${request.method()} ${url.pathname}${url.search}`);
            return route.fulfill({ status: 405, json: { detail: 'Preview-only CSV fixture' } });
          }
          const body = url.pathname.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
            : url.pathname.endsWith('/settings/spoolman') ? { spoolman_enabled: 'false', spoolman_url: '' }
            : url.pathname.endsWith('/settings') ? { language, low_stock_threshold: 20, currency: 'USD' }
            : url.pathname.endsWith('/inventory/locations') ? [{ id: 1, name: 'Shelf' }]
            : url.pathname.endsWith('/inventory/catalog') ? [{ id: 1, name: 'Example spool', weight: 200 }]
            : url.pathname.endsWith('/local-presets') ? { filament: [], printer: [], process: [] }
            : [];
          return route.fulfill({ json: body });
        });
        await page.goto('/inventory');
        await page.getByRole('button', { name: language === 'en' ? 'Import CSV' : 'CSV importieren', exact: true }).click();
        const title = page.getByRole('heading', { name: language === 'en' ? 'Import spools from CSV' : 'Spulen aus CSV importieren', exact: true });
        await expect(title).toBeVisible();
        await page.locator('input[type="file"][accept=".csv,text/csv"]').setInputFiles({
          name: 'fictional-preview.csv', mimeType: 'text/csv', buffer: Buffer.from(`material\n${'PLA\n'.repeat(count)}`),
        });
        const expected = language === 'en'
          ? `Import ${count} valid ${count === 1 ? 'row' : 'rows'}`
          : `${count} ${count === 1 ? 'gültige Zeile' : 'gültige Zeilen'} importieren`;
        await expect(page.getByRole('button', { name: expected, exact: true })).toBeEnabled();
        await page.getByRole('button', { name: language === 'en' ? 'Cancel' : 'Abbrechen', exact: true }).click();
        await expect(title).not.toBeVisible();
        expect(previews).toEqual(['?dry_run=true']);
        expect(writes).toEqual([]);
      });
    }
  }
}
