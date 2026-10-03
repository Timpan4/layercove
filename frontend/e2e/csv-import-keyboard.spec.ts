import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [390, 1440]) {
  test(`CSV import stays keyboard-operable at ${width}px without importing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
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
          columns: ['material'], total: 1, valid_count: 1, error_count: 0, skipped_count: 0,
          warnings: [], rows: [{ row_number: 2, status: 'valid', material: 'PLA', brand: 'Fictional', color_name: 'Blue', rgba: '336699FF' }],
        } });
      }
      if (request.method() !== 'GET') {
        if (url.pathname.startsWith('/api/v1/inventory/')) writes.push(`${request.method()} ${url.pathname}${url.search}`);
        return route.fulfill({ status: 405, json: { detail: 'Preview-only CSV fixture' } });
      }
      const body = url.pathname.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
        : url.pathname.endsWith('/settings/spoolman') ? { spoolman_enabled: 'false', spoolman_url: '' }
        : url.pathname.endsWith('/settings') ? { language: 'en', low_stock_threshold: 20, currency: 'USD' }
        : url.pathname.endsWith('/inventory/locations') ? [{ id: 1, name: 'Shelf' }]
        : url.pathname.endsWith('/inventory/catalog') ? [{ id: 1, name: 'Example spool', weight: 200 }]
        : url.pathname.endsWith('/local-presets') ? { filament: [], printer: [], process: [] }
        : [];
      return route.fulfill({ json: body });
    });

    await page.goto('/inventory');
    const trigger = page.getByRole('button', { name: 'Import CSV', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Import spools from CSV' });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const closeButton = dialog.getByRole('button', { name: 'Close', exact: true });
    const cancelButton = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(closeButton).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(cancelButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
    const chooserButton = page.getByRole('button', { name: 'Choose a CSV file or drag it here', exact: true });
    await page.keyboard.press('Tab');
    await expect(chooserButton).toBeFocused();
    const chooserPromise = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'fictional-preview.csv', mimeType: 'text/csv', buffer: Buffer.from('material\nPLA\n'),
    });
    await expect(page.getByText('Fictional', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import 1 valid row', exact: true })).toBeEnabled();
    await expect.poll(() => previews.length).toBe(1);
    expect(writes).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(writes).toEqual([]);
  });
}
