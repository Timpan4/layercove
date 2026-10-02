import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const unavailable = 'Printer compatibility filtering is unavailable for Orca Cloud profiles.';
const voron = 'Voron 2.4 300 0.4 nozzle - my';
const bambu = 'Bambu Lab X1 Carbon 0.6 nozzle';
const standard = '0.20mm Standard @Voron 2.4';
const fine = '0.12mm Fine @BBL X1C';

async function openOrcaProfiles(page: Page, width: number, model: string | null) {
  const unexpectedWrites: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() === 'POST' && (path.endsWith('/auth/ws-token') || path.endsWith('/camera/stream-token'))) {
      return route.fulfill({ json: { token: 'test-stream-token' } });
    }
    if (request.method() !== 'GET') {
      unexpectedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only test fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false };
    if (path.endsWith('/cloud/status')) body = { connected: false };
    if (path.endsWith('/orca-cloud/status')) body = { connected: true, email: 'fixture@example.test', user_id: 'fixture-user' };
    if (path.endsWith('/printers')) body = [{ id: 1, name: 'Tim Voron', provider: 'moonraker', model, is_active: true }];
    if (path.endsWith('/orca-cloud/profiles')) body = {
      printer: [voron, bambu].map((name, index) => ({ setting_id: `printer-${index}`, name, type: 'printer' })),
      filament: ['Generic PLA', 'Generic PETG'].map((name, index) => ({ setting_id: `filament-${index}`, name, type: 'filament' })),
      process: [standard, fine].map((name, index) => ({ setting_id: `process-${index}`, name, type: 'process' })),
    };
    await route.fulfill({ json: body });
  });
  await page.goto('/profiles');
  await page.getByRole('button', { name: 'Orca Cloud', exact: true }).click();
  await expect(page.getByTitle(voron, { exact: true })).toBeVisible();
  return unexpectedWrites;
}

async function chooseFilter(page: Page, label: string, option: string) {
  await page.getByRole('button', { name: new RegExp(`^${label}:`) }).click();
  await page.getByRole('button', { name: new RegExp(`^${option}(?:\\s+\\d+)?$`) }).click();
}

for (const width of [1280, 390]) {
  for (const model of ['Voron 2.4', null]) {
    test(`Orca printer compatibility is explicitly unavailable with ${model ?? 'missing model'} at ${width}px`, async ({ page }) => {
      const writes = await openOrcaProfiles(page, width, model);
      await expect(page.getByText(unavailable, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Printer:/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Tim Voron', exact: true })).toHaveCount(0);
      await chooseFilter(page, 'Type', 'Printer');
      await expect(page.getByTitle(voron, { exact: true })).toBeVisible();
      await expect(page.getByTitle(bambu, { exact: true })).toBeVisible();
      await expect(page.getByTitle('Generic PLA', { exact: true })).toHaveCount(0);
      expect(writes).toEqual([]);
    });
  }

  test(`Orca type, nozzle, material, layer, search and clear filters still work at ${width}px`, async ({ page }) => {
    const writes = await openOrcaProfiles(page, width, null);
    const clear = page.getByRole('button', { name: 'Clear filters', exact: true });
    await chooseFilter(page, 'Type', 'Printer');
    await chooseFilter(page, 'Nozzle', '0.4mm');
    await expect(page.getByTitle(voron, { exact: true })).toBeVisible();
    await expect(page.getByTitle(bambu, { exact: true })).toHaveCount(0);
    await clear.click();

    await chooseFilter(page, 'Filament', 'PLA');
    await expect(page.getByTitle('Generic PLA', { exact: true })).toBeVisible();
    await expect(page.getByTitle('Generic PETG', { exact: true })).toHaveCount(0);
    await clear.click();

    await chooseFilter(page, 'Type', 'Process');
    await chooseFilter(page, 'Layer', '0.20mm');
    await expect(page.getByTitle(standard, { exact: true })).toBeVisible();
    await expect(page.getByTitle(fine, { exact: true })).toHaveCount(0);
    await clear.click();

    await page.getByPlaceholder('Search presets...', { exact: true }).fill('generic');
    await expect(page.getByTitle('Generic PLA', { exact: true })).toBeVisible();
    await expect(page.getByTitle('Generic PETG', { exact: true })).toBeVisible();
    await expect(page.getByTitle(voron, { exact: true })).toHaveCount(0);
    await clear.click();
    await expect(page.getByPlaceholder('Search presets...', { exact: true })).toHaveValue('');
    await expect(page.getByTitle(voron, { exact: true })).toBeVisible();
    await expect(page.getByTitle(bambu, { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });
}
