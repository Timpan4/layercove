import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [1280, 390]) {
  test(`Moonraker model edits preserve the exact slicer binding at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const printer = {
      id: 1, name: 'Tim Voron', provider: 'moonraker', model: '', is_active: true,
      auto_archive: false, nozzle_count: 1, external_camera_enabled: false,
      moonraker_config: { base_url: 'http://klipper.invalid:7125', tls_verify: true },
      capabilities: { ams: false, camera: false, start_print: false },
    };
    const profileName = 'Voron 2.4 300 0.4 nozzle - my';
    const unexpectedWrites: string[] = [];
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/\/$/, '');
      if (request.method() === 'PATCH' && path === '/api/v1/printers/1') {
        const body = request.postDataJSON();
        printer.model = body.model;
        return route.fulfill({ json: printer });
      }
      if (request.method() !== 'GET') {
        if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
          return route.fulfill({ json: { token: 'fixture-token' } });
        }
        unexpectedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Fixture rejects unrelated mutations' } });
      }
      let body: unknown = [];
      if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
      if (path.endsWith('/settings')) body = { check_updates: false };
      if (path === '/api/v1/printers') body = [printer];
      if (path === '/api/v1/printers/1/status') body = { connected: true, state: 'IDLE', vt_tray: [], ams: [] };
      if (path === '/api/v1/slicer/catalog/bindings') body = [{
        id: 7, printer_id: 1, profile_id: 12, profile_name: profileName,
        expected_nozzle_diameter: 0.4, tool_index: 0, is_active: true,
        default_process_profile_id: null, default_filament_profile_id: null,
        enforcement_state: 'shadow', readiness: { state: 'blocked', reason_codes: ['default_unavailable'] },
        nozzle: { status: 'unknown', diameter: null, tool_index: 0 },
      }];
      if (path === '/api/v1/slicer/catalog/printers/1/classification') body = { classifications: [] };
      return route.fulfill({ json: body });
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Open controls', exact: true }).click();
    await expect(page.getByText(profileName, { exact: true })).toBeVisible();
    const openEdit = async () => {
      await page.locator('#printer-card-1 button').filter({ has: page.locator('.lucide-ellipsis-vertical') }).click();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
    };
    await openEdit();
    const model = page.getByRole('textbox', { name: 'Model', exact: true });
    await model.fill('Voron 2.4');
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(page.locator('#printer-card-1').getByText('Voron 2.4', { exact: true })).toBeVisible();
    await expect(page.getByText(profileName, { exact: true })).toBeVisible();
    await openEdit();
    await expect(model).toHaveValue('Voron 2.4');
    await model.fill('');
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect(page.locator('#printer-card-1').getByText('Unknown Model', { exact: true })).toBeVisible();
    await expect(page.getByText(profileName, { exact: true })).toBeVisible();
    expect(unexpectedWrites).toEqual([]);
  });
}
