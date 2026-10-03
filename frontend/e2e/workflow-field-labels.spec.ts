import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block', locale: 'en-US' });

async function openWorkflow(page: Page, width: number) {
  const blockedWrites: string[] = [];
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-workflow-label-session');
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      blockedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only Workflow caption fixture' } });
    }
    const body = path.endsWith('/auth/status') ? { auth_enabled: true, requires_setup: false }
      : path.endsWith('/auth/me') ? {
        id: 198, username: 'Fictional Workflow Admin', is_admin: true, is_active: true,
        groups: [], permissions: ['settings:read', 'settings:update'],
      }
      : path.endsWith('/settings') ? {
        language: 'en', date_format: 'system', time_format: 'system', currency: 'USD',
        ha_enabled: false, auto_archive: true, save_thumbnails: true,
        stagger_group_size: 2, stagger_interval_minutes: 5,
      }
      : path.endsWith('/system/storage-usage') ? {
        categories: [], other_breakdown: [], roots: [], total_bytes: 0, total_formatted: '0 B', scan_errors: 0,
      }
      : path.endsWith('/auth/advanced-auth/status') ? { advanced_auth_enabled: false, local_login_enabled: true }
      : [];
    return route.fulfill({ json: body });
  });
  await page.goto('/settings?tab=queue&sub=dispatch');
  await expect(page.getByRole('heading', { name: 'Temperature & Fan Presets', exact: true })).toBeVisible();
  return blockedWrites;
}

function expectNoSettingWrites(writes: string[]) {
  // Startup token requests also return405; none reach a backend or hardware.
  expect(writes.filter((request) => ![
    'POST /api/v1/printers/camera/stream-token',
    'POST /api/v1/auth/ws-token',
  ].includes(request))).toEqual([]);
}

for (const width of [390, 1440]) {
  test(`Workflow preset values have distinct names at ${width}px`, async ({ page }) => {
    const writes = await openWorkflow(page, width);
    for (const [name, values, max] of [
      ['Nozzle temperature', [120, 220, 260], 320],
      ['Bed temperature', [55, 75, 90], 140],
      ['Chamber temperature', [35, 45, 60], 60],
      ['Fan speed', [50, 75, 100], 100],
    ] as const) {
      const group = page.getByRole('group', { name, exact: true });
      await expect.soft(group).toBeVisible();
      for (const [index, value] of values.entries()) {
        const field = page.getByRole('spinbutton', { name: `${name} ${index + 1}`, exact: true });
        await expect.soft(field).toBeVisible();
        if (await field.count()) {
          await expect(field).toHaveValue(String(value));
          await expect(field).toHaveAttribute('min', '0');
          await expect(field).toHaveAttribute('max', String(max));
        }
      }
    }
    expectNoSettingWrites(writes);
  });

  test(`Workflow stagger captions name and focus the preserved numeric fields at ${width}px`, async ({ page }) => {
    const writes = await openWorkflow(page, width);
    for (const [caption, value, max] of [['Group size', '2', '50'], ['Interval (minutes)', '5', '60']] as const) {
      const field = page.getByRole('spinbutton', { name: caption, exact: true });
      await expect.soft(field).toBeVisible();
      if (await field.count()) {
        await page.locator('label').filter({ hasText: caption }).click();
        await expect(field).toBeFocused();
        await expect(field).toHaveValue(value);
        await expect(field).toHaveAttribute('min', '1');
        await expect(field).toHaveAttribute('max', max);
      }
    }
    expectNoSettingWrites(writes);
  });
}

