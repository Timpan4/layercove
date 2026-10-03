import type { Page } from '@playwright/test';
import type { GroupDetail, PermissionsListResponse } from '../src/api/client';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block', locale: 'en-US' });

const permissionFixture: PermissionsListResponse = {
  categories: [
    { name: 'Printers', permissions: [{ value: 'printers:read', label: 'Read printers' }, { value: 'printers:control', label: 'Control printers' }] },
    { name: 'Archives', permissions: [{ value: 'archives:read', label: 'Read archives' }] },
  ],
  all_permissions: ['printers:read', 'printers:control', 'archives:read'],
};
const groupFixture: GroupDetail = {
  id: 701, name: 'Fictional operators', description: 'Read-only editor fixture',
  permissions: ['printers:read'], is_system: false, user_count: 0, users: [],
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
};

async function openGroup(page: Page, width: number, editing: boolean, system = false) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-group-label-session');
    localStorage.setItem('bambutrack_language', 'en');
  });
  const origin = new URL(test.info().project.use.baseURL ?? 'http://localhost:8001').origin;
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.routeWebSocket(() => true, (socket) => socket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only group editor fixture' } });
    }
    const fixtures = new Map<string, unknown>([
      ['/api/v1/auth/status', { auth_enabled: true, requires_setup: false }],
      ['/api/v1/auth/me', { id: 901, username: 'fictional-admin', is_admin: true, is_active: true, groups: [], permissions: ['groups:create', 'groups:update', 'settings:read'] }],
      ['/api/v1/groups/permissions', permissionFixture],
      ['/api/v1/groups/701', { ...groupFixture, is_system: system }],
      ['/api/v1/auth/advanced-auth/status', { advanced_auth_enabled: false, local_login_enabled: true }],
      ['/api/v1/settings', { language: 'en', check_updates: false }],
    ]);
    return route.fulfill({ status: fixtures.has(path) ? 200 : 404, json: fixtures.get(path) ?? { detail: 'No fixture for this GET' } });
  });
  await page.goto(editing ? '/groups/701/edit' : '/groups/new');
  await expect(page.getByRole('heading', { name: editing ? 'Edit Group' : 'Create Group', exact: true })).toBeVisible();
  await expect(page.getByText('Read printers', { exact: true })).toBeVisible();
  return writes;
}

function expectNoGroupWrites(writes: string[]) {
  expect(writes.filter((request) => ![
    'POST /api/v1/printers/camera/stream-token', 'POST /api/v1/auth/ws-token',
  ].includes(request))).toEqual([]);
}

for (const width of [390, 1440]) {
  for (const editing of [false, true]) {
    test(`Group ${editing ? 'Edit' : 'Create'} captions and category draft state at ${width}px`, async ({ page }) => {
      const writes = await openGroup(page, width, editing);
      for (const caption of ['Group Name', 'Description']) {
        const field = page.getByLabel(caption, { exact: true });
        expect.soft(await field.count(), `${caption} native label`).toBe(1);
        if (await field.count()) {
          await page.locator('label').filter({ hasText: caption }).click();
          await expect(field).toBeFocused();
          await expect(field).toHaveValue(editing ? (caption === 'Group Name' ? groupFixture.name : groupFixture.description ?? '') : '');
        }
      }
      const search = page.getByLabel('Search permissions...', { exact: true });
      expect.soft(await search.count(), 'Named permission search').toBe(1);
      expect.soft(await page.getByRole('button', { name: 'Back', exact: true }).count(), 'Named Back action').toBe(1);
      const category = page.getByRole('checkbox', { name: 'Printers', exact: true });
      expect.soft(await category.count(), 'Named category selector').toBe(1);
      if (await category.count()) {
        await expect(category).toHaveAttribute('aria-checked', editing ? 'mixed' : 'false');
        if (!editing) {
          await page.getByRole('checkbox', { name: 'Read printers', exact: true }).check();
          await expect(category).toHaveAttribute('aria-checked', 'mixed');
        }
        await category.press('Space');
        await expect(category).toHaveAttribute('aria-checked', 'true');
        await expect(page.getByRole('checkbox', { name: 'Control printers', exact: true })).toBeChecked();
        await category.press('Space');
        await expect(category).toHaveAttribute('aria-checked', 'false');
        await expect(page.getByRole('checkbox', { name: 'Read printers', exact: true })).not.toBeChecked();
      }
      expectNoGroupWrites(writes);
    });
  }
}

test('System group name stays disabled while its native caption remains available', async ({ page }) => {
  const writes = await openGroup(page, 1440, true, true);
  const field = page.getByLabel('Group Name', { exact: true });
  expect.soft(await field.count(), 'System group native name').toBe(1);
  if (await field.count()) {
    await expect(field).toBeDisabled();
    await expect(field).toHaveValue(groupFixture.name);
  }
  expectNoGroupWrites(writes);
});
