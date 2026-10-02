import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const printer = { id: 991, name: 'Fictional label printer', provider: 'bambu', model: 'P1S', is_active: true };
const profile = { slot_id: 1, extruder_id: 0, nozzle_id: 'HH00-0.4', nozzle_diameter: '0.4', filament_id: 'fixture-pla', name: 'HF Fictional PLA', k_value: '0.020', n_coef: '1', ams_id: 0, tray_id: 0, setting_id: null };

async function installFixture(page: Page, width: number) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fixture-token' } });
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only profile label fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false };
    if (path.endsWith('/cloud/status')) body = { is_authenticated: false };
    if (path.endsWith('/printers')) body = [printer];
    if (path.endsWith('/kprofiles')) body = { profiles: [profile], nozzle_diameter: '0.4' };
    if (path.endsWith('/kprofiles/notes')) body = { notes: {} };
    if (path.endsWith('/cloud/builtin-filaments')) body = [{ filament_id: 'fixture-pla', name: 'Fictional PLA' }];
    if (path.endsWith('/cloud/filament-id-map')) body = {};
    await route.fulfill({ json: body });
  });
  await page.goto('/profiles');
  await expect(page.getByRole('heading', { name: 'Connect to Bambu Cloud', exact: true })).toBeVisible();
  return writes;
}

async function checkLabels(page: Page, names: string[]) {
  for (const name of names) {
    const control = page.getByLabel(name, { exact: true });
    expect.soft(await control.count(), `${name} has a persistent native label`).toBe(1);
    if (await control.count() === 1) {
      await expect(control).toHaveAccessibleName(name);
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await page.locator('label').filter({ hasText: new RegExp(`^${escaped}$`) }).click();
      await expect(control).toBeFocused();
    }
  }
}

for (const width of [1280, 390]) {
  test(`cloud login controls retain native label names at ${width}px`, async ({ page }) => {
    const writes = await installFixture(page, width);
    await checkLabels(page, ['Email', 'Password', 'Region']);
    await expect(page.getByPlaceholder('your@email.com', { exact: true })).toHaveValue('');
    await expect(page.getByPlaceholder('••••••••', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Use access token instead', exact: true }).click();
    await checkLabels(page, ['Access Token', 'Region']);
    await expect(page.getByPlaceholder('eyJ...', { exact: true })).toHaveValue('');
    expect(writes).toEqual([]);
  });

  test(`K-profile filters and all Add fields retain native label names at ${width}px`, async ({ page }) => {
    const writes = await installFixture(page, width);
    await page.getByRole('button', { name: 'K-Profiles', exact: true }).click();
    await expect(page.getByText('HF Fictional PLA', { exact: true })).toBeVisible();
    await checkLabels(page, ['Printer', 'Nozzle']);
    await page.getByRole('button', { name: 'Add Profile', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add K-Profile', exact: true })).toBeVisible();
    await checkLabels(page, ['Profile Name', 'K-Value', 'Filament', 'Flow Type', 'Nozzle Size', 'Notes (stored locally)']);
    await expect(page.getByPlaceholder('My PLA Profile', { exact: true })).toHaveValue('');
    await expect(page.getByPlaceholder('0.020', { exact: true })).toHaveValue('0.020');
    expect(writes).toEqual([]);
  });
}