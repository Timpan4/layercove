import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [1440, 390, 640, 768]) {
  test(`Every archive selection action fits and is reachable at ${width}px without changing archives`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const writes: string[] = [];
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/\/$/, '');
      if (request.method() !== 'GET') {
        // Startup token reads are fictional and never reach a backend or camera.
        if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
          await route.fulfill({ json: { token: 'fictional-token' } });
          return;
        }
        writes.push(`${request.method()} ${path}`);
        await route.fulfill({ status: 405, json: { detail: 'Read-only archive fixture' } });
        return;
      }
      let body: unknown = [];
      if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
      if (path.endsWith('/settings')) body = { check_updates: false, currency: 'USD' };
      if (path === '/api/v1/printers') body = [{ id: 167, name: 'Tim Voron', provider: 'moonraker', model: 'Voron' }];
      if (path === '/api/v1/archives' || path === '/api/v1/archives/slim') body = [1, 2].map((id) => ({
        id, printer_id: 167, project_id: null, project_name: null,
        print_name: `Voron Cube ${id}`, filename: `voron-cube-${id}.gcode.3mf`, file_path: `fictional/${id}.gcode.3mf`,
        thumbnail_path: null, status: 'completed', is_favorite: false, tags: '', quantity: 1,
        print_time_seconds: 3600, filament_used_grams: 24, filament_type: 'PLA', filament_color: '#ff0000',
        created_at: '2026-10-02T07:00:00Z', started_at: '2026-10-02T08:00:00Z', completed_at: '2026-10-02T09:00:00Z',
      }));
      await route.fulfill({ json: body });
    });
    await page.goto('/archives');
    await expect(page.getByRole('heading', { name: 'Archives', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await page.getByRole('combobox').filter({ has: page.locator('option[value="167"]') }).selectOption('167');
    await expect(page.getByText('Voron Cube 1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.getByRole('button', { name: 'Select All', exact: true }).click();
    await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
    const toolbar = page.getByRole('button', { name: 'Close', exact: true }).locator('..');

    const report = await page.getByRole('button', { name: 'Report a Bug', exact: true }).boundingBox();
    expect(report).not.toBeNull();
    for (const name of ['Close', 'Select All', 'Tags', 'Project', 'Favorite', 'Delete']) {
      const control = toolbar.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
      const bounds = await control.boundingBox();
      expect(bounds, `${name} bounds`).not.toBeNull();
      expect.soft(bounds!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
      expect.soft(bounds!.x + bounds!.width, `${name} right edge`).toBeLessThanOrEqual(width);
      expect.soft(bounds!.y, `${name} top edge`).toBeGreaterThanOrEqual(0);
      expect.soft(bounds!.y + bounds!.height, `${name} bottom edge`).toBeLessThanOrEqual(width === 390 ? 844 : 1000);
      const overlapsReport = bounds!.x < report!.x + report!.width && bounds!.x + bounds!.width > report!.x
        && bounds!.y < report!.y + report!.height && bounds!.y + bounds!.height > report!.y;
      expect.soft(overlapsReport, `${name} does not collide with Report a Bug`).toBe(false);
      if (bounds!.x >= 0 && bounds!.x + bounds!.width <= width && !overlapsReport) {
        // Trial checks hit testing without invoking Favorite, Delete or another action.
        await control.click({ trial: true });
      }
    }
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
    await toolbar.getByRole('button', { name: 'Close', exact: true }).press('Enter');
    await expect(page.getByRole('button', { name: 'Select', exact: true })).toBeVisible();
    await expect(page.getByText('2 selected', { exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}
