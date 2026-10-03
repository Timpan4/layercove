import type { Locator, Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const permissions = [
  'settings:read', 'settings:update',
  'users:read', 'users:create', 'users:update', 'users:delete',
  'groups:read', 'groups:create', 'groups:update', 'groups:delete',
];

const fixtureUser = {
  id: 198,
  username: 'fixture-person',
  email: 'fixture.person@example.invalid',
  role: 'user',
  is_active: true,
  is_admin: false,
  auth_source: 'local',
  groups: [{ id: 701, name: 'Fixture Operators' }],
  permissions: [],
  created_at: '2026-10-01T00:00:00Z',
};

const fixtureGroup = {
  id: 701,
  name: 'Fixture Operators',
  description: 'Fictional user-settings accessibility fixture',
  permissions: [],
  is_system: false,
  user_count: 1,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

type BlockedRequest = { method: string; path: string; status: number };

async function openFixture(
  page: Page,
  width: number,
  path: '/settings?tab=users',
  advancedAuthEnabled: boolean,
) {
  const blockedNonGets: BlockedRequest[] = [];
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-user-labels-session');
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.routeWebSocket(
    (url) => url.pathname.startsWith('/api/'),
    (socket) => socket.close(),
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request();
      const requestPath = new URL(request.url()).pathname.replace(/\/+$/, '') || '/';
      if (request.method() !== 'GET') {
        blockedNonGets.push({ method: request.method(), path: requestPath, status: 405 });
        return route.fulfill({ status: 405, json: { detail: 'Read-only user-label fixture' } });
      }

      let body: unknown = [];
      if (requestPath === '/api/v1/auth/status') body = { auth_enabled: true, requires_setup: false };
      if (requestPath === '/api/v1/auth/me') body = {
        id: 901,
        username: 'fixture-admin',
        is_admin: true,
        is_active: true,
        groups: [{ id: 1, name: 'Administrators' }],
        permissions,
      };
      if (requestPath === '/api/v1/settings') body = {
        language: 'en',
        date_format: 'system',
        time_format: 'system',
        currency: 'USD',
        ha_enabled: false,
        ha_url: '',
        ha_token: '',
        mqtt_broker: '',
        auto_archive: true,
        save_thumbnails: true,
        capture_finish_photo: false,
        default_filament_cost: 20,
        energy_cost_per_kwh: 0.25,
        library_disk_warning_gb: 5,
      };
      if (requestPath === '/api/v1/auth/advanced-auth/status') body = {
        advanced_auth_enabled: advancedAuthEnabled,
        local_login_enabled: true,
        smtp_configured: true,
      };
      if (requestPath === '/api/v1/auth/ldap/status') body = { ldap_enabled: false };
      if (requestPath === '/api/v1/auth/2fa/status') body = { totp_enabled: false, email_otp_enabled: false };
      if (requestPath === '/api/v1/auth/oidc/providers') body = [];
      if (requestPath === '/api/v1/auth/encryption-status') body = {
        key_configured: false,
        key_source: 'none',
        legacy_plaintext_rows: { oidc_providers: 0, user_totp: 0 },
        encrypted_rows: { oidc_providers: 0, user_totp: 0 },
        decryption_broken: false,
        migration_error_count: 0,
      };
      if (requestPath === '/api/v1/system/storage-usage') body = {
        categories: [],
        other_breakdown: [],
        roots: [],
        total_bytes: 0,
        total_formatted: '0 B',
        scan_errors: 0,
      };
      if (requestPath === '/api/v1/users') body = [fixtureUser];
      if (requestPath === '/api/v1/groups') body = [fixtureGroup];

      return route.fulfill({ json: body });
    },
  );

  await page.goto(path);
  await expect(page.locator('#card-users')).toBeVisible();
  await expect(page.locator('#card-groups')).toBeVisible();
  await expect(page.getByText(fixtureUser.username, { exact: true })).toBeVisible();
  await expect(page.getByText(fixtureGroup.name, { exact: true }).first()).toBeVisible();

  return blockedNonGets;
}

async function expectNativeCaption(modal: Locator, caption: RegExp) {
  const label = modal.locator('label').filter({ hasText: caption });
  await expect(label).toHaveCount(1);
  await expect(label).toBeVisible();

  const control = modal.getByLabel(caption);
  await expect(control).toHaveCount(1);
  const association = await control.evaluate((element) => ({
    id: element.id,
    labels: Array.from((element as HTMLInputElement).labels ?? []).map((item) => item.textContent?.trim() ?? ''),
  }));
  expect(association.id).not.toBe('');
  expect(association.labels.some((text) => caption.test(text))).toBe(true);
  expect(await label.evaluate((element) => (element as HTMLLabelElement).control?.id)).toBe(association.id);

  await label.click();
  await expect(control).toBeFocused();
  return control;
}

async function expectReadOnly(blockedNonGets: BlockedRequest[]) {
  expect(
    blockedNonGets.every(({ status }) => status === 405),
    'every non-GET API request must be rejected with 405',
  ).toBe(true);
  expect(
    blockedNonGets.filter(({ path }) =>
      /^\/api\/v1\/(?:users|groups)(?:\/|$)/.test(path) || /reset-password/i.test(path),
    ),
    'the fixture must not receive user, group, or password-reset writes',
  ).toEqual([]);
}

async function openModal(page: Page, heading: RegExp) {
  const modal = page.locator('.fixed.inset-0').last();
  await expect(modal.getByRole('heading', { name: heading })).toBeVisible();
  return modal;
}

for (const width of [390, 1440]) {
  test('Settings basic User Create/Edit captions stay associated at ' + width + 'px', async ({ page }) => {
    const blockedNonGets = await openFixture(page, width, '/settings?tab=users', false);

    await page.getByRole('button', { name: /Add User/i }).click();
    const createModal = await openModal(page, /^Create User$/i);
    await expectNativeCaption(createModal, /^Username/i);
    await expectNativeCaption(createModal, /^Password\b/i);
    await expectNativeCaption(createModal, /^Confirm Password/i);
    await createModal.getByRole('button', { name: /Cancel/i }).click();

    await page.getByRole('button', { name: /^Edit\b.*fixture-person$/i }).click();
    const editModal = await openModal(page, /^Edit User$/i);
    await expect(editModal.getByLabel(/^Username/i)).toHaveValue(fixtureUser.username);
    await expect(editModal.getByLabel(/^Email/i)).toHaveValue(fixtureUser.email);
    await expectNativeCaption(editModal, /^Username/i);
    await expectNativeCaption(editModal, /^Email/i);
    const password = await expectNativeCaption(editModal, /^Password\b/i);
    await password.fill('fictional local draft');
    await expectNativeCaption(editModal, /^Confirm Password/i);
    await editModal.getByRole('button', { name: /Cancel/i }).click();

    await expectReadOnly(blockedNonGets);
  });

  test('Settings advanced User Create/Edit captions stay associated at ' + width + 'px', async ({ page }) => {
    const blockedNonGets = await openFixture(page, width, '/settings?tab=users', true);

    await page.getByRole('button', { name: /Add User/i }).click();
    const createModal = await openModal(page, /^Create User$/i);
    await expectNativeCaption(createModal, /^Username/i);
    await expectNativeCaption(createModal, /^Email/i);
    await createModal.getByRole('button', { name: /Cancel/i }).click();

    await page.getByRole('button', { name: /^Edit\b.*fixture-person$/i }).click();
    const editModal = await openModal(page, /^Edit User$/i);
    await expect(editModal.getByLabel(/^Username/i)).toHaveValue(fixtureUser.username);
    await expect(editModal.getByLabel(/^Email/i)).toHaveValue(fixtureUser.email);
    await expectNativeCaption(editModal, /^Username/i);
    await expectNativeCaption(editModal, /^Email/i);
    await editModal.getByRole('button', { name: /Cancel/i }).click();

    await expectReadOnly(blockedNonGets);
  });

  test('Settings User and Group Edit/Delete icons name their targets at ' + width + 'px', async ({ page }) => {
    const blockedNonGets = await openFixture(page, width, '/settings?tab=users', false);

    await expect(page.getByRole('button', { name: /^Edit\b.*fixture-person$/i })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Delete\b.*fixture-person$/i })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Edit\b.*Fixture Operators$/i })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /^Delete\b.*Fixture Operators$/i })).toHaveCount(1);

    await expectReadOnly(blockedNonGets);
  });
}
