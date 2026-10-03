import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block', locale: 'en-US' });

async function openInventory(page: Page) {
  const writes: string[] = [];
  const spools = Array.from({ length: 16 }, (_, index) => ({
    id: index + 1, material: index === 0 ? 'PLA' : 'PETG', brand: 'Example',
    subtype: 'Basic', color_name: `Color ${index}`, rgba: '336699FF',
    label_weight: 1000, core_weight: 200, core_weight_catalog_id: 1, weight_used: 100,
    category: 'Workshop', location_id: 1, archived_at: null, note: '',
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  }));
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (path.includes('/inventory/')) writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only pagination fixture' } });
    }
    const body = path.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
      : path.endsWith('/settings/spoolman') ? { spoolman_enabled: 'false', spoolman_url: '' }
      : path.endsWith('/settings') ? { low_stock_threshold: 20, currency: 'USD' }
      : path.endsWith('/inventory/spools') ? spools
      : path.endsWith('/inventory/locations') ? [{ id: 1, name: 'Shelf' }]
      : path.endsWith('/inventory/catalog') ? [{ id: 1, name: 'Example spool', weight: 200 }]
      : path.endsWith('/local-presets') ? { filament: [], printer: [], process: [] }
      : [];
    return route.fulfill({ json: body });
  });
  await page.goto('/inventory');
  await expect(page.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true');
  return writes;
}

for (const width of [390, 1440]) {
  test(`Inventory pagination uses singular and plural spool nouns with correct filtered bounds at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const writes = await openInventory(page);
    await expect(page.getByText('Showing 1 to 15 of 16 spools', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Material', exact: true }).selectOption('PLA');
    await expect(page.getByText('Showing 1 to 1 of 1 spool', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('-1');
    await expect(page.getByText('1 spool', { exact: true }).last()).toBeVisible();
    await page.getByRole('combobox', { name: 'Material', exact: true }).selectOption('');
    await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('15');
    await expect(page.getByText('Showing 1 to 15 of 16 spools', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cards', exact: true }).click();
    await expect(page.getByText('Showing 1 to 15 of 16 spools', { exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('-1');
    await page.getByRole('combobox', { name: 'Material', exact: true }).selectOption('PLA');
    await expect(page.getByText('1 spool', { exact: true }).last()).toBeVisible();
    expect(writes).toEqual([]);
  });
}
