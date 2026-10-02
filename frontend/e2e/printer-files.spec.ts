import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [1280, 390]) {
  test(`Voron files browse and recover from request failure at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let failed = true;
    let deleted = false;
    const unexpectedWrites: string[] = [];
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace(/\/$/, '');
      if (request.method() !== 'GET') {
        if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
          return route.fulfill({ json: { token: 'fixture-token' } });
        }
        if (request.method() === 'DELETE' && path === '/api/v1/printers/1/files' && url.searchParams.get('path') === '/nested/cube.gcode') {
          deleted = true;
          return route.fulfill({ json: { status: 'deleted', path: '/nested/cube.gcode' } });
        }
        unexpectedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Fixture does not permit this action' } });
      }
      let body: unknown = [];
      if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
      if (path.endsWith('/settings')) body = { check_updates: false };
      if (path === '/api/v1/printers') body = [{
        id: 1, name: 'Tim Voron', provider: 'moonraker', model: 'Voron', is_active: true,
        auto_archive: false, nozzle_count: 1, external_camera_enabled: false,
        capabilities: { ams: false, camera: false, start_print: false, temperature_read: true },
      }];
      if (path === '/api/v1/printers/1/status') body = {
        connected: true, state: 'IDLE', progress: 0, remaining_time: 0, vt_tray: [], ams: [],
        temperatures: { nozzle: 25, bed: 25, chamber: 25 },
      };
      if (path === '/api/v1/printers/1/storage') body = { used_bytes: 100, free_bytes: 900 };
      if (path === '/api/v1/printers/1/files') {
        if (failed) return route.fulfill({ status: 502, json: { detail: 'Printer file service is unavailable' } });
        const nested = url.searchParams.get('path') === '/nested';
        body = { files: nested
          ? (deleted ? [] : [{ name: 'cube.gcode', path: '/nested/cube.gcode', size: 1024, is_directory: false, permissions: 'rw' }])
          : [
              { name: 'nested', path: '/nested', size: 0, is_directory: true, permissions: 'rw' },
              { name: 'readonly.gcode', path: '/readonly.gcode', size: 1024, is_directory: false, permissions: 'r' },
            ],
        };
      }
      await route.fulfill({ json: body });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Open controls', exact: true }).click();
    await page.getByTitle('Browse printer files', { exact: true }).click();
    const modal = page.locator('div').filter({ has: page.getByRole('heading', { name: 'File Manager', exact: true }) }).filter({ has: page.getByRole('button', { name: 'Close file manager', exact: true }) }).last();
    await expect(page.getByRole('alert')).toContainText('Failed to load files');
    await expect(page.getByText('No files in this directory', { exact: true })).not.toBeVisible();
    failed = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('readonly.gcode', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'G-code', exact: true })).toBeVisible();
    for (const name of ['Cache', 'Models', 'Timelapse']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Select All', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    await page.getByText('nested', { exact: true }).click();
    await expect(page.getByText('cube.gcode', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Select All', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Delete "cube.gcode"? This cannot be undone.', { exact: true })).toBeVisible();
    expect(deleted).toBe(false);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('cube.gcode', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await expect(page.getByText('No files in this directory', { exact: true })).toBeVisible();
    expect(deleted).toBe(true);
    expect(unexpectedWrites).toEqual([]);
    await page.getByRole('button', { name: 'Close file manager', exact: true }).click();
    await expect(modal).not.toBeVisible();
  });
}
