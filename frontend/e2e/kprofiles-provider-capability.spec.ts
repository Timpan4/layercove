import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const printers = [
  { id: 991, name: 'Fictional online Voron', provider: 'moonraker', model: 'Voron', is_active: true },
  { id: 992, name: 'Fictional offline Bambu', provider: 'bambu', model: 'P1S', is_active: true },
  { id: 993, name: 'Fictional online Bambu', provider: 'bambu', model: 'P1S', is_active: true },
];
const profile = { slot_id: 1, extruder_id: 0, nozzle_id: 'HH00-0.4', nozzle_diameter: '0.4', filament_id: 'fixture-pla', name: 'HF Fictional PLA', k_value: '0.020', n_coef: '1', ams_id: 0, tray_id: 0, setting_id: null };

for (const width of [1280, 390]) {
  test(`K-profile support follows provider and preserves Bambu behavior at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const unsupportedReads: string[] = [];
    const writes: string[] = [];
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/\/$/, '');
      if (request.method() !== 'GET') {
        if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fixture-token' } });
        writes.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only provider fixture' } });
      }
      let body: unknown = [];
      if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
      if (path.endsWith('/settings')) body = { check_updates: false };
      if (path.endsWith('/printers')) body = printers;
      if (path.includes('/printers/991/kprofiles')) unsupportedReads.push(path);
      if (path.endsWith('/kprofiles')) {
        if (!path.includes('/printers/993/')) return route.fulfill({ status: 400, json: { detail: 'Printer not connected' } });
        body = { profiles: [profile], nozzle_diameter: '0.4' };
      }
      if (path.endsWith('/kprofiles/notes')) body = { notes: {} };
      if (path.endsWith('/cloud/builtin-filaments')) body = [{ filament_id: 'fixture-pla', name: 'Fictional PLA' }];
      if (path.endsWith('/cloud/filament-id-map')) body = {};
      await route.fulfill({ json: body });
    });
    await page.goto('/profiles');
    await page.getByRole('button', { name: 'K-Profiles', exact: true }).click();
    const unsupported = page.getByRole('heading', { name: 'K-profiles are not supported for this printer', exact: true });
    await expect(unsupported).toBeVisible();
    await expect(page.getByText('K-profile management is available for Bambu printers. For pressure-advance tests on this printer, use the Calibration tab.', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Printer Offline', exact: true })).toHaveCount(0);
    for (const name of ['Add Profile', 'Import', 'Create First Profile', 'Refresh']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'K-Profiles', exact: true }).focus();
    await page.keyboard.press('r');
    await page.keyboard.press('n');
    await expect(page.getByRole('heading', { name: 'Add K-Profile', exact: true })).toHaveCount(0);
    await page.getByLabel('Printer', { exact: true }).selectOption('992');
    await expect(page.getByRole('heading', { name: 'Printer Offline', exact: true })).toBeVisible();
    await page.getByLabel('Printer', { exact: true }).selectOption('993');
    await expect(page.getByText('HF Fictional PLA', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add Profile', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeEnabled();
    await page.getByLabel('Printer', { exact: true }).selectOption('991');
    await expect(unsupported).toBeVisible();
    expect(unsupportedReads).toEqual([]);
    expect(writes).toEqual([]);
  });
}
