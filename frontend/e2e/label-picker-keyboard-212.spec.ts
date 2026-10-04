import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const fictionalSpools = [
  { id: 821, material: 'PLA', subtype: 'Matte', brand: 'Fictional Works', color_name: 'Fictional Rose', rgba: 'CC6688FF' },
  { id: 822, material: 'PETG', subtype: 'Basic', brand: 'Imaginary Lab', color_name: 'Imaginary Blue', rgba: '336699FF' },
  { id: 823, material: 'PLA', subtype: 'Basic', brand: 'Example Maker', color_name: 'Sample Gold', rgba: 'DDBB33FF' },
].map((spool) => ({
  ...spool,
  label_weight: 1000,
  core_weight: 200,
  core_weight_catalog_id: null,
  weight_used: 100,
  category: 'Fictional shelf',
  location_id: 1,
  archived_at: null,
  note: '',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}));

for (const width of [390, 1440]) {
  test(`Inventory label picker traps keyboard focus and restores its opener at ${width}px`, async ({ page }) => {
    const blockedWrites: string[] = [];
    const labelRequests: string[] = [];
    await page.setViewportSize({ width, height: 900 });
    await page.routeWebSocket('**', (socket) => socket.close());
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/\/+$/, '');
      const isLabelRequest = /\/(?:labels?|print(?:-spool)?-labels?)(?:\/|$)/i.test(path);
      if (isLabelRequest) {
        labelRequests.push(`${request.method()} ${path}`);
      }
      if (request.method() !== 'GET' || isLabelRequest) {
        blockedWrites.push(`${request.method()} ${path}`);
        await route.fulfill({ status: 405, json: { detail: 'Read-only fictional spool fixture' } });
        return;
      }

      let body: unknown = [];
      if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
      else if (path.endsWith('/settings/spoolman')) body = { spoolman_enabled: 'false', spoolman_url: '' };
      else if (path.endsWith('/settings')) body = { low_stock_threshold: 20, currency: 'USD' };
      else if (path.endsWith('/inventory/spools')) body = fictionalSpools;
      else if (/\/inventory\/spools\/\d+$/.test(path)) body = fictionalSpools[0];
      else if (path.endsWith('/inventory/locations')) body = [{ id: 1, name: 'Fictional shelf' }];
      else if (path.endsWith('/inventory/catalog')) body = [];
      else if (path.endsWith('/local-presets')) body = { filament: [], printer: [], process: [] };
      await route.fulfill({ json: body });
    });

    await page.goto('/inventory');
    const opener = page.getByRole('button', { name: /Print labels/ }).first();
    await expect(opener).toBeVisible();
    await opener.click();

    const dialog = page.getByRole('dialog', { name: 'Print spool labels', exact: true });
    await expect(dialog).toBeVisible();
    const search = dialog.getByPlaceholder('Search name, brand, or #ID', { exact: true });
    await expect(search).toBeFocused();
    await expect(dialog.getByRole('checkbox', { name: /Fictional Rose/ })).toBeChecked();

    await search.fill('Imaginary');
    await expect(dialog.getByRole('checkbox', { name: /Imaginary Blue/ })).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /Fictional Rose/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'PETG', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: /Imaginary Blue/ })).toBeVisible();
    const sortByColor = dialog.getByRole('button', { name: 'By colour', exact: true });
    await expect(sortByColor).toBeVisible();
    await sortByColor.click();

    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    await cancel.focus();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(cancel).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    const reopened = page.getByRole('dialog', { name: 'Print spool labels', exact: true });
    await expect(reopened).toBeVisible();
    await expect(reopened.getByPlaceholder('Search name, brand, or #ID', { exact: true })).toHaveValue('');
    await reopened.getByRole('button', { name: 'PETG', exact: true }).click();
    await reopened.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(reopened).toHaveCount(0);
    await expect(opener).toBeFocused();

    await opener.click();
    const canceled = page.getByRole('dialog', { name: 'Print spool labels', exact: true });
    await expect(canceled).toBeVisible();
    await canceled.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(canceled).toHaveCount(0);
    await expect(opener).toBeFocused();

    const readOnlySocketProbes = ['/api/v1/printers/camera/stream-token', '/api/v1/auth/ws-token'];
    expect(blockedWrites.filter((request) => !readOnlySocketProbes.some((path) => request.endsWith(path)))).toEqual([]);
    expect(labelRequests).toEqual([]);
  });
}
