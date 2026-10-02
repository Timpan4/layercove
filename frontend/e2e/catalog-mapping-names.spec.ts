import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const knownName = 'Voron 2.4 300 0.4 nozzle, workshop profile with a full human-readable name';
const retiredName = 'Retired Voron workshop profile';
const printerName = 'Fictional Voron workshop printer with a full human-readable name';
const inactiveName = 'Fictional inactive printer';
const profile = (id: number, display_name: string, active = true, tombstoned = false) => ({
  profile_id: id, revision_id: id + 100, latest_revision_id: id + 100, active_revision_id: active ? id + 100 : null,
  active, review_state: 'approved', source: 'standard', account_id: 1, account_name: 'Fictional catalog',
  remote_profile_id: `profile-${id}`, profile_type: 'printer', display_name, content_hash: `hash-${id}`,
  compatibility_metadata: {}, tombstoned, stale: false, sharing_state: 'shared',
});
const profiles = [...Array.from({ length: 30 }, (_, index) => profile(index + 1, `Alpha profile ${String(index + 1).padStart(2, '0')}`)), profile(9828, retiredName, false, true), profile(9827, knownName)];
const printers = [{ id: 1, name: printerName, provider: 'moonraker', is_active: true }, { id: 2, name: inactiveName, provider: 'bambu', is_active: false }];
const mappings = [{ id: 1, profile_id: 9827, printer_id: 1 }, { id: 2, profile_id: 9828, printer_id: 2 }, { id: 3, profile_id: 999991, printer_id: 999992 }];

async function installFixture(page: Page) {
  const writes: string[] = [];
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fixture-token' } });
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only mapping names fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false };
    if (path.endsWith('/printers')) body = printers;
    if (path.endsWith('/slicer/catalog/mappings')) body = mappings;
    if (path.endsWith('/slicer/catalog/profiles')) {
      const available = url.searchParams.get('include_inactive') === 'true' ? profiles : profiles.filter((item) => item.active);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? available.length);
      body = available.slice(offset, offset + limit);
    }
    return route.fulfill({ json: body });
  });
  await page.goto('/profiles');
  await page.getByRole('button', { name: 'Shared catalog', exact: true }).click();
  return writes;
}

for (const width of [1280, 390]) {
  test(`saved mappings show full names and unavailable or retired states at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const writes = await installFixture(page);
    const catalog = page.getByLabel('Shared Profiles catalog administration', { exact: true });
    await expect(catalog.getByRole('article', { name: 'Alpha profile 01', exact: true })).toBeVisible();
    await expect(catalog.getByRole('article', { name: knownName, exact: true })).toHaveCount(0);
    const rows = catalog.getByRole('button', { name: 'Delete', exact: true }).locator('..');
    await expect(rows).toHaveCount(3);
    for (const [index, names] of [[0, [knownName, printerName]], [1, [retiredName, inactiveName, 'Retired profile', 'Inactive printer']], [2, ['Profile unavailable', 'Printer unavailable']]] as const) {
      for (const name of names) expect.soft(await rows.nth(index).getByText(name, { exact: true }).count(), `saved mapping shows ${name}`).toBe(1);
    }
    for (const [index, mapping] of mappings.entries()) {
      expect.soft(await rows.nth(index).getByText(`Profile ${mapping.profile_id} · Printer ${mapping.printer_id}`, { exact: true }).count(), 'IDs remain secondary references').toBe(1);
    }
    const choices = catalog.getByRole('combobox', { name: 'Catalog profile', exact: true });
    expect(await choices.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(['', ...Array.from({ length: 30 }, (_, index) => String(index + 1)), '9827']);
    expect(await catalog.getByRole('combobox', { name: 'Physical printer', exact: true }).locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).toEqual(['', '1', '2']);
    if (await rows.first().getByText(knownName, { exact: true }).count() === 1) {
      await rows.first().scrollIntoViewIfNeeded();
      for (const name of [knownName, printerName]) {
        const bounds = await rows.first().getByText(name, { exact: true }).boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      }
    }
    expect(writes).toEqual([]);
  });
}