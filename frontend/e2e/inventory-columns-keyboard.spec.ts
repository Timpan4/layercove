import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [390, 1440]) {
  test(`Inventory columns dialog contains keyboard focus and discards drafts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const writes: { path: string; status: number }[] = [];
    page.on('response', (response) => {
      const request = response.request();
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/') && request.method() !== 'GET') writes.push({ path, status: response.status() });
    });
    await page.routeWebSocket(() => true, (socket) => socket.close());
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
      if (request.method() !== 'GET') {
        return route.fulfill({ status: 405, json: { detail: 'Read-only inventory fixture' } });
      }
      const spools = Array.from({ length: 2 }, (_, index) => ({
        id: index + 1, material: index ? 'PETG' : 'PLA', brand: 'Example', subtype: 'Basic',
        color_name: `Color ${index + 1}`, rgba: '336699FF', label_weight: 1000,
        core_weight: 200, core_weight_catalog_id: 1, weight_used: 100, category: 'Workshop',
        location_id: 1, archived_at: null, note: '', created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      }));
      const path = url.pathname.replace(/\/$/, '');
      const body = path.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
        : path.endsWith('/settings/spoolman') ? { spoolman_enabled: 'false', spoolman_url: '' }
        : path.endsWith('/settings') ? { language: 'en', low_stock_threshold: 20, currency: 'USD' }
        : path.endsWith('/inventory/spools') ? spools
        : /\/inventory\/spools\/\d+$/.test(path) ? spools[0]
        : path.endsWith('/inventory/locations') ? [{ id: 1, name: 'Shelf' }]
        : path.endsWith('/inventory/catalog') ? [{ id: 1, name: 'Example spool', weight: 200 }]
        : path.endsWith('/local-presets') ? { filament: [], printer: [], process: [] }
        : [];
      return route.fulfill({ json: body });
    });

    await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
    const trigger = page.locator('button[title="Configure Columns"]');
    await expect(trigger).toBeVisible();
    const savedConfig = await page.evaluate(() => localStorage.getItem('bambuddy-inventory-columns'));

    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Configure Columns', exact: true });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    const firstMoveDown = dialog.getByRole('button', { name: 'Move down', exact: true }).first();
    await expect(firstMoveDown).toBeFocused();

    const apply = dialog.getByRole('button', { name: 'Apply Changes', exact: true });
    await apply.focus();
    await page.keyboard.press('Tab');
    await expect(firstMoveDown).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(apply).toBeFocused();

    const initialLabels = await dialog.locator('[draggable="true"]').allTextContents();
    const secondMoveUp = dialog.getByRole('button', { name: 'Move up', exact: true }).nth(1);
    await secondMoveUp.focus();
    await page.keyboard.press('Enter');
    const movedLabels = await dialog.locator('[draggable="true"]').allTextContents();
    expect(movedLabels).not.toEqual(initialLabels);

    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('bambuddy-inventory-columns'))).toBe(savedConfig);
    expect(writes.every(({ status }) => status === 405)).toBe(true);
    expect(writes.filter(({ path }) => path.startsWith('/api/v1/inventory/'))).toEqual([]);

    await trigger.focus();
    await page.keyboard.press('Enter');
    const reopened = page.getByRole('dialog', { name: 'Configure Columns', exact: true });
    await expect(reopened).toBeVisible();
    await expect(reopened.locator('[draggable="true"]').allTextContents()).resolves.toEqual(initialLabels);
    await expect.poll(() => reopened.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    const firstMoveDownAgain = reopened.getByRole('button', { name: 'Move down', exact: true }).first();
    await firstMoveDownAgain.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(reopened).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('bambuddy-inventory-columns'))).toBe(savedConfig);
    expect(writes.every(({ status }) => status === 405)).toBe(true);
    expect(writes.filter(({ path }) => path.startsWith('/api/v1/inventory/'))).toEqual([]);
  });
}