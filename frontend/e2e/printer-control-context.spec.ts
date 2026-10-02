import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function openVoronControls(page: Page, width: number) {
  await page.setViewportSize({ width, height: 844 });
  const unexpectedWrites: string[] = [];
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
        return route.fulfill({ json: { token: 'fixture-token' } });
      }
      unexpectedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only fleet fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false };
    if (path === '/api/v1/printers') body = [
      { id: 2, name: "DOGGE'S PRINTER", model: 'P1S', provider: 'bambu', is_active: true, capabilities: { camera: false, ams: false } },
      { id: 1, name: 'Tim Voron', model: 'Voron 2.4', provider: 'moonraker', is_active: true,
        capabilities: { camera: false, ams: false, emergency_stop: true, extruder_temperature: false, bed_temperature: false } },
    ];
    if (/\/printers\/\d+\/status$/.test(path)) body = {
      connected: true, state: 'IDLE', vt_tray: [], ams: [], temperatures: { nozzle: 27, bed: 24 },
    };
    if (path === '/api/v1/slicer/catalog/printers/2/suggestion') body = {
      printer_id: 2, suggested_profile_ids: [], requires_confirmation: true, readiness: 'blocked',
    };
    return route.fulfill({ json: body });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Inspect Tim Voron', exact: true }).click();
  await page.getByRole('button', { name: 'Open controls', exact: true }).click();
  await expect(page.locator('#printer-card-1')).toBeVisible();
  return unexpectedWrites;
}

for (const width of [1280, 390]) {
  test(`opens focused Voron controls before bindings at ${width}px`, async ({ page }) => {
    const unexpectedWrites = await openVoronControls(page, width);
    await expect(page.locator('#printer-card-2')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Tim Voron', level: 1 })).toBeVisible();
    const card = page.locator('#printer-card-1');
    await expect(card.getByRole('heading', { name: 'Tim Voron' })).toBeInViewport();
    await expect(card.getByText('Nozzle', { exact: true })).toBeInViewport();
    const bindingHeading = page.getByRole('heading', { name: 'Installed printer slicer bindings' });
    const cardBounds = await card.boundingBox();
    const bindingBounds = await bindingHeading.boundingBox();
    expect(bindingBounds!.y).toBeGreaterThan(cardBounds!.y + cardBounds!.height);
    expect(unexpectedWrites).toEqual([]);
  });

  test(`Back restores the inspected Voron and retains the fleet at ${width}px`, async ({ page }) => {
    const unexpectedWrites = await openVoronControls(page, width);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Command deck', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tim Voron', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: "Inspect DOGGE'S PRINTER", exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Inspect Tim Voron', exact: true })).toBeVisible();
    expect(unexpectedWrites).toEqual([]);
  });
}
