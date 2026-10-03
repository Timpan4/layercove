import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

async function openSettings(page: Page, width: number) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-account-label-session');
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only account label fixture' } });
    }
    const body = path.endsWith('/auth/status') ? { auth_enabled: true, requires_setup: false }
      : path.endsWith('/auth/me') ? {
        id: 198, username: 'Fictional Account Admin', is_admin: true, is_active: true,
        groups: [], permissions: ['settings:read', 'settings:update', 'api_keys:read', 'api_keys:create'],
      }
      : path.endsWith('/settings') ? {
        language: 'en', date_format: 'system', time_format: 'system', currency: 'USD',
        ha_enabled: false, ha_url: '', ha_token: '', mqtt_broker: '', auto_archive: true,
        save_thumbnails: true, capture_finish_photo: false, default_filament_cost: 20,
        energy_cost_per_kwh: 0.25, library_disk_warning_gb: 5,
      }
      : path.endsWith('/system/storage-usage') ? {
        categories: [], other_breakdown: [], roots: [], total_bytes: 0, total_formatted: '0 B', scan_errors: 0,
      }
      : path.endsWith('/auth/advanced-auth/status') ? { advanced_auth_enabled: false, local_login_enabled: true }
      : [];
    return route.fulfill({ json: body });
  });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  return writes;
}

function expectNoAccountWrites(writes: string[]) {
  // Authenticated app startup requests temporary stream/WebSocket tokens.
  // Those requests are rejected with 405 alongside every other non-GET.
  expect(writes.filter((request) => ![
    'POST /api/v1/printers/camera/stream-token',
    'POST /api/v1/auth/ws-token',
  ].includes(request))).toEqual([]);
}

for (const width of [390, 1440]) {
  test(`API key Name caption names and focuses its draft field at ${width}px`, async ({ page }) => {
    const writes = await openSettings(page, width);
    await page.getByRole('button', { name: 'API Keys', exact: true }).click();
    await page.getByRole('button', { name: 'Create Key', exact: true }).click();
    const name = page.getByRole('textbox', { name: 'Key Name', exact: true });
    await expect(name).toBeVisible();
    await page.locator('label').filter({ hasText: /^Key Name$/ }).click();
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute('placeholder', 'e.g., Home Assistant, OctoPrint');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create New API Key', exact: true })).toHaveCount(0);
    expectNoAccountWrites(writes);
  });

  test(`Sidebar Change Password captions name their fields without submitting at ${width}px`, async ({ page }) => {
    const writes = await openSettings(page, width);
    if (width === 390) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    await page.getByRole('button', { name: 'Change Password', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Change Password', exact: true })).toBeVisible();
    for (const label of ['Current Password', 'New Password', 'Confirm New Password']) {
      const field = page.getByLabel(label, { exact: true });
      await expect(field).toBeVisible();
      await expect(field).toHaveAttribute('type', 'password');
      await page.locator('label').filter({ hasText: new RegExp(`^${label}$`) }).click();
      await expect(field).toBeFocused();
    }
    await expect(page.getByRole('button', { name: 'Change Password', exact: true }).last()).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Change Password', exact: true })).toHaveCount(0);
    expectNoAccountWrites(writes);
  });
}
