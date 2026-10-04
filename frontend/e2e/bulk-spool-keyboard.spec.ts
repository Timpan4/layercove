import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const spools = [
  { id: 21101, material: 'PLA', subtype: null, color_name: 'Fictional Blue', rgba: '336699FF', brand: 'Example', label_weight: 1000, core_weight: 200, core_weight_catalog_id: null, weight_used: 0, slicer_filament: null, slicer_filament_name: null, nozzle_temp_min: null, nozzle_temp_max: null, note: null, added_full: true, last_used: null, encode_time: null, tag_uid: null, tray_uuid: null, data_origin: 'local', tag_type: null, archived_at: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', cost_per_kg: null, last_scale_weight: null, last_weighed_at: null, category: null, low_stock_threshold_pct: null, location_id: null },
  { id: 21102, material: 'PETG', subtype: null, color_name: 'Fictional Green', rgba: '339966FF', brand: 'Example', label_weight: 1000, core_weight: 200, core_weight_catalog_id: null, weight_used: 0, slicer_filament: null, slicer_filament_name: null, nozzle_temp_min: null, nozzle_temp_max: null, note: null, added_full: true, last_used: null, encode_time: null, tag_uid: null, tray_uuid: null, data_origin: 'local', tag_type: null, archived_at: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', cost_per_kg: null, last_scale_weight: null, last_weighed_at: null, category: null, low_stock_threshold_pct: null, location_id: null },
];

for (const width of [390, 1440]) {
  for (const closeWith of ['Escape', 'Cancel'] as const) {
    test('Bulk spool edit contains keyboard focus and restores it after ' + closeWith + ' at ' + width + 'px', async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const writes: string[] = [];
      await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/\/$/, '');
        if (request.method() !== 'GET') {
          writes.push(request.method() + ' ' + path);
          return route.fulfill({ status: 405, json: { detail: 'Read-only bulk-edit fixture' } });
        }
        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        else if (path.endsWith('/settings/spoolman')) body = { spoolman_enabled: 'false', spoolman_url: '' };
        else if (path.endsWith('/settings')) body = { language: 'en', currency: 'USD', low_stock_threshold: 20 };
        else if (path.endsWith('/inventory/spools')) body = spools;
        else if (path.endsWith('/inventory/locations')) body = [{ id: 1, name: 'Fictional shelf' }];
        else if (path.endsWith('/inventory/assignments') || path.endsWith('/spool-assignments')) body = [];
        else if (path.endsWith('/inventory/catalog')) body = [];
        else if (path.endsWith('/inventory/spool-catalog')) body = [];
        else if (path.endsWith('/local-presets')) body = { filament: [], printer: [], process: [] };
        else if (path.endsWith('/cloud/status')) body = { is_authenticated: false };
        else if (path.endsWith('/orca/cloud/status')) body = { connected: false };
        return route.fulfill({ json: body });
      });

      await page.goto('/inventory');
      await expect(page.getByRole('heading', { name: 'Spool Inventory', exact: true })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Select row', exact: true })).toHaveCount(2);
      await page.getByRole('checkbox', { name: 'Select row', exact: true }).nth(0).check();
      await page.getByRole('checkbox', { name: 'Select row', exact: true }).nth(1).check();
      await expect(page.getByText('2 selected', { exact: true })).toBeVisible();

      const trigger = page.getByRole('button', { name: 'Edit', exact: true }).filter({ hasText: 'Edit' });
      await trigger.focus();
      await page.keyboard.press('Enter');

      const overlayHeading = page.getByRole('heading', { name: 'Bulk edit spools', exact: true });
      const overlay = overlayHeading.locator('xpath=../../..');
      const firstField = overlay.getByRole('checkbox', { name: 'Toggle update for this field' }).first();
      await expect(firstField).toBeFocused();
      await page.keyboard.press('Tab');
      await expect.poll(() => overlay.evaluate((element) => element.contains(document.activeElement))).toBe(true);

      const dialog = page.getByRole('dialog', { name: 'Bulk edit spools' });
      await expect(dialog).toBeVisible();
      await firstField.check();
      await dialog.getByRole('textbox').first().fill('Draft only');

      const lastFocusable = dialog.getByRole('button', { name: 'Apply to 2 spools', exact: true });
      await lastFocusable.focus();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(lastFocusable).toBeFocused();

      if (closeWith === 'Escape') {
        await page.keyboard.press('Escape');
      } else {
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      expect(writes.filter((request) => /\/inventory\/|assignment|label|preference/i.test(request))).toEqual([]);
    });
  }
}
