import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test('Add Spool is reachable from the mobile inventory header', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
      : path.replace(/\/$/, '').endsWith('/local-presets') ? { filament: [], printer: [], process: [] }
      : [];
    await route.fulfill({ json: body });
  });
  await page.goto('/inventory');
  const add = page.getByRole('button', { name: 'Add Spool', exact: true }).first();
  await expect(add).toBeVisible();
  const box = await add.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await add.click();
  await expect(page.getByRole('heading', { name: 'Add Spool', exact: true })).toBeVisible();
});

async function inventoryFixture(page: Page) {
  const writes: string[] = [];
  // The default page holds 15 rows. One more distinct spool exposes pagination.
  const spools = Array.from({ length: 16 }, (_, index) => ({
    id: index + 1, material: index % 2 ? 'PETG' : 'PLA', brand: index % 2 ? 'Other' : 'Example',
    subtype: 'Basic', color_name: `Color ${index}`, rgba: '336699FF',
    label_weight: 1000, core_weight: 200, core_weight_catalog_id: 1, weight_used: 100,
    category: 'Workshop', location_id: 1, archived_at: null, note: '',
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  }));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
    if (route.request().method() !== 'GET' && /\/inventory\//.test(path)) {
      writes.push(`${route.request().method()} ${path}`);
      await route.fulfill({ status: 405, json: { detail: 'Draft-only test' } });
      return;
    }
    const body = path.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
      : path.endsWith('/settings/spoolman') ? { spoolman_enabled: 'false', spoolman_url: '' }
      : path.endsWith('/settings') ? { low_stock_threshold: 20, currency: 'USD' }
      : path.endsWith('/inventory/spools') ? spools
      : /\/inventory\/spools\/\d+$/.test(path) ? spools[0]
      : path.endsWith('/inventory/locations') ? [{ id: 1, name: 'Shelf' }]
      : path.endsWith('/inventory/catalog') ? [{ id: 1, name: 'Example spool', weight: 200 }]
      : path.endsWith('/local-presets') ? { filament: [], printer: [], process: [] }
      : [];
    await route.fulfill({ json: body });
  });
  await page.goto('/inventory');
  await expect(page.getByRole('button', { name: 'Add Spool', exact: true }).first()).toBeVisible();
  return writes;
}

for (const width of [1280, 390]) {
  test(`Inventory view switches and filters have usable names at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const writes = await inventoryFixture(page);
    const table = page.getByRole('button', { name: 'Table', exact: true });
    await expect(table).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Cards', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cards', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('30');
    await table.click();
    await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('15');
    for (const [name, value] of [['Material', 'PLA'], ['Brand', 'Example'], ['Category', 'Workshop'], ['Spool', '1'], ['Storage Location', '1']]) {
      const filter = page.getByRole('combobox', { name, exact: true });
      await filter.selectOption(value);
      await expect(filter).toHaveValue(value);
      await filter.selectOption('');
    }
    await page.getByRole('button', { name: 'Forecast', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Forecast', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await table.click();
    expect(writes).toEqual([]);
  });

  test(`Spool fields and Quick Add are named draft controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const writes = await inventoryFixture(page);
    await page.getByRole('button', { name: 'Add Spool', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add Spool', exact: true });
    await expect(dialog).toBeVisible();
    for (const name of [/^Slicer Preset/, /^Material/, /^Brand/, /^Subtype/, 'Label Weight', 'Empty Spool Weight', 'Remaining Weight', 'Measured Weight', 'Cost per kg', 'Color Name', 'Hex Color', 'Note', 'Extra colors', 'Effect']) {
      await expect(dialog.getByLabel(name)).toHaveCount(1);
    }
    await dialog.getByLabel('Label Weight', { exact: true }).fill('500');
    await dialog.getByLabel('Empty Spool Weight', { exact: true }).fill('200');
    await dialog.getByLabel('Remaining Weight', { exact: true }).fill('400');
    await dialog.getByLabel('Measured Weight', { exact: true }).fill('600');
    await dialog.getByLabel('Cost per kg', { exact: true }).fill('25');
    await dialog.getByLabel('Color Name', { exact: true }).fill('Draft blue');
    await dialog.getByLabel('Hex Color', { exact: true }).fill('336699');
    await dialog.getByLabel('Note', { exact: true }).fill('Unsaved draft');
    await dialog.getByLabel('Category', { exact: true }).fill('Draft');
    await dialog.getByLabel('Low-stock threshold (this spool)', { exact: true }).fill('10');
    await dialog.getByLabel('Storage Location', { exact: true }).selectOption('1');
    const quick = dialog.getByRole('switch', { name: 'Quick Add (Stock)', exact: true });
    await expect(quick).not.toBeChecked();
    await quick.click();
    await expect(quick).toBeChecked();
    await dialog.getByLabel('Quantity', { exact: true }).fill('2');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(writes).toEqual([]);
    const firstSpool = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '1', exact: true }) });
    await firstSpool.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: /^Edit Spool/ });
    await expect(edit.getByLabel('Label Weight', { exact: true })).toHaveValue('1000');
    await edit.getByLabel('Note', { exact: true }).fill('Unsaved edit');
    await edit.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(edit).not.toBeVisible();
    expect(writes).toEqual([]);
  });
}
