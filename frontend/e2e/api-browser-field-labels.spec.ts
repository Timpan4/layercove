import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const schemaFixture = {
  "paths": {
    "/api/v1/slicer/jobs/{job_id}": {
      "get": {
        "summary": "Get fictional slice job",
        "tags": [
          "slicer",
          "jobs"
        ],
        "parameters": [
          {
            "name": "job_id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "integer"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Fictional job"
          }
        }
      }
    }
  }
};

async function openApiSettings(page: Page, width: number) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-api-browser-label-session');
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only api-browser label fixture' } });
    }
    const body = path.endsWith('/auth/status') ? { auth_enabled: true, requires_setup: false }
      : path.endsWith('/auth/me') ? {
        id: 198, username: 'Fictional API Browser Admin', is_admin: true, is_active: true,
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
  await page.route('**/openapi.json', (route) => route.fulfill({ json: schemaFixture }));
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  return writes;
}

function expectNoAPIWrites(writes: string[]) {
  // Authenticated app startup requests temporary stream/WebSocket tokens.
  // Those requests are rejected with 405 alongside every other non-GET.
  expect(writes.filter((request) => ![
    'POST /api/v1/printers/camera/stream-token',
    'POST /api/v1/auth/ws-token',
  ].includes(request))).toEqual([]);
}


for (const width of [390, 1440]) {
  test(`API Browser testing key caption names and focuses its field at ${width}px`, async ({ page }) => {
    const writes = await openApiSettings(page, width);
    await page.getByRole('button', { name: 'API Keys', exact: true }).click();
    const key = page.getByPlaceholder('Paste your API key here to test authenticated endpoints...', { exact: true });
    await expect(key).toBeVisible();
    expect(await key.evaluate((e) => Array.from((e as HTMLInputElement).labels ?? []).map(l => l.textContent?.trim()))).toContain('API Key for Testing');
    await page.locator('label').filter({ hasText: /^API Key for Testing$/ }).click();
    await expect(key).toBeFocused();
    await expect(key).toHaveValue('');
    expectNoAPIWrites(writes);
  });

  test(`API Browser endpoint search keeps a name after filtering at ${width}px`, async ({ page }) => {
    const writes = await openApiSettings(page, width);
    await page.getByRole('button', { name: 'API Keys', exact: true }).click();
    const search = page.getByPlaceholder('Search endpoints...', { exact: true });
    await expect(search).toBeVisible();
    // A placeholder can supply a browser fallback name. Require a persistent
    // programmatic name from a label or ARIA rather than that fallback.
    expect(await search.evaluate((e) => Boolean(
      e.getAttribute('aria-label')?.trim() || e.getAttribute('aria-labelledby')?.trim() ||
      (e as HTMLInputElement).labels?.length,
    ))).toBe(true);
    await search.fill('slice');
    await expect(search).toHaveAccessibleName('Search endpoints');
    await expect(page.getByRole('heading', { name: 'jobs', exact: true })).toBeVisible();
    expectNoAPIWrites(writes);
  });

  test(`API Browser job_id captions target their own repeated endpoint at ${width}px`, async ({ page }) => {
    const writes = await openApiSettings(page, width);
    await page.getByRole('button', { name: 'API Keys', exact: true }).click();
    await page.getByRole('button', { name: 'Expand All', exact: true }).click();
    const endpoints = page.getByRole('button', { name: /get \/api\/v1\/slicer\/jobs\/\{job_id\}/i });
    await expect(endpoints).toHaveCount(2);
    for (const endpoint of await endpoints.all()) await endpoint.click();
    const jobs = page.getByPlaceholder('integer', { exact: true });
    await expect(jobs).toHaveCount(2);
    const ids: string[] = [];
    for (const field of await jobs.all()) {
      await expect(field).toBeVisible();
      const association = await field.evaluate((e) => ({ id: e.id, labels: Array.from((e as HTMLInputElement).labels ?? []).map(l => l.textContent?.trim()) }));
      expect(association.labels).toContain('job_id*');
      ids.push(association.id);
      await page.locator('label').filter({ hasText: /^job_id\s*\*$/ }).nth(ids.length - 1).click();
      await expect(field).toBeFocused();
      await expect(field).toHaveValue('');
    }
    expect(new Set(ids).size).toBe(2);
    expectNoAPIWrites(writes);
  });
}
