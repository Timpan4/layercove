import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const logEntries = [
  { timestamp: '2026-10-02 12:00:00,000', level: 'ERROR', logger_name: 'fixture', message: 'raw_data fictional error' },
  { timestamp: '2026-10-02 12:00:01,000', level: 'ERROR', logger_name: 'fixture', message: 'Fictional unrelated error' },
  { timestamp: '2026-10-02 12:00:02,000', level: 'INFO', logger_name: 'fixture', message: 'Fictional informational entry' },
];

async function installFixture(page: Page, width: number) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fixture-token' } });
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only log toolbar fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false };
    if (path.endsWith('/support/debug-logging')) body = { enabled: false, enabled_at: null, duration_seconds: null };
    if (path.endsWith('/system/info')) body = {
      app: { version: 'fictional', base_dir: '/fictional', archive_dir: '/fictional/archives' },
      database: { engine: 'SQLite', version: 'fictional', archives: 0, archives_completed: 0, archives_failed: 0, archives_printing: 0, printers: 0, filaments: 0, projects: 0, smart_plugs: 0, total_print_time_seconds: 0, total_print_time_formatted: '0h', total_filament_grams: 0, total_filament_kg: 0 },
      printers: { total: 0, connected: 0, connected_list: [] },
      storage: { archive_size_bytes: 0, archive_size_formatted: '0 B', database_size_bytes: 0, database_size_formatted: '0 B', disk_total_bytes: 1000, disk_total_formatted: '1 KB', disk_used_bytes: 0, disk_used_formatted: '0 B', disk_free_bytes: 1000, disk_free_formatted: '1 KB', disk_percent_used: 0 },
      system: { platform: 'Linux', platform_release: 'fictional', platform_version: 'fictional', architecture: 'fictional', hostname: 'fictional', python_version: 'fictional', uptime_seconds: 0, uptime_formatted: '0h', boot_time: '2026-10-02T12:00:00' },
      memory: { total_bytes: 1000, total_formatted: '1 KB', available_bytes: 1000, available_formatted: '1 KB', used_bytes: 0, used_formatted: '0 B', percent_used: 0 },
      cpu: { count: 1, count_logical: 1, percent: 0 },
    };
    if (path.endsWith('/support/logs')) {
      const entries = logEntries.filter((entry) => (!url.searchParams.get('level') || entry.level === url.searchParams.get('level')) && (!url.searchParams.get('search') || entry.message.includes(url.searchParams.get('search')!)));
      body = { entries, filtered_count: entries.length, total_in_file: logEntries.length };
    }
    await route.fulfill({ json: body });
  });
  await page.goto('/system');
  await page.getByRole('button', { name: 'Application Logs View and filter application logs', exact: true }).click();
  await expect(page.getByText('Fictional informational entry', { exact: true })).toBeVisible();
  return writes;
}

for (const width of [1280, 390]) {
  test(`named log actions preserve severity and never clear logs at ${width}px`, async ({ page }) => {
    const writes = await installFixture(page, width);
    const search = page.getByPlaceholder('Search message or logger name...', { exact: true });
    await search.fill('raw_data');
    await page.getByRole('button', { name: 'ERROR', exact: true }).click();
    await expect(page.getByText('raw_data fictional error', { exact: true })).toBeVisible();
    await expect(page.getByText('Fictional unrelated error', { exact: true })).toHaveCount(0);
    const refresh = page.getByRole('button', { name: 'Refresh logs', exact: true });
    const clearSearch = page.getByRole('button', { name: 'Clear search', exact: true });
    expect.soft(await refresh.count(), 'refresh has an accessible name').toBe(1);
    expect.soft(await clearSearch.count(), 'search clear has an accessible name').toBe(1);
    if (await refresh.count() !== 1 || await clearSearch.count() !== 1) return;
    const refreshed = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/support/logs') && url.searchParams.get('search') === 'raw_data' && url.searchParams.get('level') === 'ERROR';
    });
    await refresh.click();
    await refreshed;
    await expect(search).toHaveValue('raw_data');
    await clearSearch.click();
    await expect(search).toHaveValue('');
    await expect(page.getByText('Fictional unrelated error', { exact: true })).toBeVisible();
    await expect(page.getByText('Fictional informational entry', { exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  test(`log search and every severity filter fit the panel at ${width}px`, async ({ page }) => {
    const writes = await installFixture(page, width);
    const search = page.getByPlaceholder('Search message or logger name...', { exact: true });
    await search.fill('raw_data');
    const panel = page.getByRole('button', { name: 'Application Logs View and filter application logs', exact: true }).locator('..');
    const panelBounds = (await panel.boundingBox())!;
    for (const name of ['All', 'DEBUG', 'INFO', 'WARNING', 'ERROR']) {
      const filter = page.getByRole('button', { name, exact: true });
      const bounds = (await filter.boundingBox())!;
      expect.soft(bounds.x, `${name} starts within the panel`).toBeGreaterThanOrEqual(panelBounds.x);
      expect.soft(bounds.x + bounds.width, `${name} ends within the panel`).toBeLessThanOrEqual(panelBounds.x + panelBounds.width);
      await filter.click();
    }
    const searchBounds = (await search.boundingBox())!;
    const valueWidth = await search.evaluate((input: HTMLInputElement) => {
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d')!;
      context.font = style.font;
      return context.measureText(input.value).width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    });
    expect(searchBounds.width, 'the entered search value fits the input').toBeGreaterThanOrEqual(valueWidth);
    if (width === 1280) {
      const filterBounds = (await page.getByRole('button', { name: 'All', exact: true }).boundingBox())!;
      expect(filterBounds.y).toBeGreaterThanOrEqual(searchBounds.y);
      expect(filterBounds.y + filterBounds.height).toBeLessThanOrEqual(searchBounds.y + searchBounds.height);
    }
    expect(writes).toEqual([]);
  });
}
