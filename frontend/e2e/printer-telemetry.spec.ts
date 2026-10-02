import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [1280, 390]) {
  test(`Voron controls show read-only temperatures at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let missingBed = false;
    const unexpectedWrites: string[] = [];
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/\/$/, '');
      if (request.method() !== 'GET') {
        if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
          return route.fulfill({ json: { token: 'fixture-token' } });
        }
        unexpectedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only fixture rejects mutations' } });
      }
      let body: unknown = [];
      if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
      if (path.endsWith('/settings')) body = { check_updates: false };
      if (path === '/api/v1/printers') body = [{
        id: 1, name: 'Tim Voron', provider: 'moonraker', model: 'Voron', is_active: true,
        auto_archive: false, nozzle_count: 1, external_camera_enabled: false,
        capabilities: {
          ams: false, camera: false, start_print: false,
          extruder_temperature: false, bed_temperature: false, chamber_temperature: false,
        },
      }];
      if (path === '/api/v1/printers/1/status') body = {
        connected: true, state: 'IDLE', progress: 0, remaining_time: 0, vt_tray: [], ams: [],
        temperatures: missingBed ? { nozzle: 0 } : { nozzle: 27.2, bed: 24.3, chamber: 25.4 },
      };
      return route.fulfill({ json: body });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Open controls', exact: true }).click();
    for (const reading of ['27°C', '24°C', '25°C']) {
      const value = page.getByText(reading, { exact: true });
      await expect(value).toBeVisible();
      await value.click();
    }
    await expect(page.getByText('Set Nozzle Temperature', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Set Bed Temperature', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Set Chamber Temperature', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'OK', exact: true })).toHaveCount(0);

    missingBed = true;
    await page.reload();
    await page.getByRole('button', { name: 'Open controls', exact: true }).click();
    await expect(page.getByText('0°C', { exact: true })).toBeVisible();
    const bed = page.getByText('Bed', { exact: true }).locator('..');
    await expect(bed).toContainText('--');
    await expect(bed).not.toContainText('0°C');
    expect(unexpectedWrites).toEqual([]);
  });
}
