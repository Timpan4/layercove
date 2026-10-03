import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const sections = [
  { label: 'Authentication', marker: () => ({ selector: 'heading' as const, name: 'Authentication' }) },
  { label: 'Email Authentication', marker: () => ({ selector: 'locator' as const, name: '#card-smtp' }) },
  { label: 'LDAP', marker: () => ({ selector: 'locator' as const, name: '#card-ldap' }) },
  { label: 'Two-Factor Auth', marker: () => ({ selector: 'heading' as const, name: 'Authenticator App (TOTP)' }) },
  { label: 'SSO / OIDC', marker: () => ({ selector: 'heading' as const, name: 'SSO / OIDC Providers' }) },
  { label: 'Security', marker: () => ({ selector: 'heading' as const, name: 'MFA Encryption Status' }) },
] as const;

async function openReadOnlyAdminSettings(page: Page, width: number) {
  const stateMutationRequests: string[] = [];
  const startupTokenResponses: Array<{ request: string; status: number }> = [];
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-auth-navigation-session');
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && path === '/api/v1/auth/ws-token') {
        startupTokenResponses.push({ request: `${request.method()} ${path}`, status: 200 });
        return route.fulfill({ json: { token: 'fictional-ws-token' } });
      }
      if (request.method() === 'POST' && path === '/api/v1/printers/camera/stream-token') {
        startupTokenResponses.push({ request: `${request.method()} ${path}`, status: 405 });
        return route.fulfill({ status: 405, json: { detail: 'Read-only Authentication navigation fixture' } });
      }
      stateMutationRequests.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only Authentication navigation fixture' } });
    }

    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: true, requires_setup: false };
    if (path.endsWith('/auth/me')) body = {
      id: 902,
      username: 'Fictional Authentication Admin',
      is_admin: true,
      is_active: true,
      groups: [],
      permissions: ['settings:read', 'settings:update'],
    };
    if (path.endsWith('/settings')) body = {
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
    if (path.endsWith('/auth/advanced-auth/status')) body = { advanced_auth_enabled: false, local_login_enabled: true };
    if (path.endsWith('/auth/2fa/status')) body = { totp_enabled: false, email_otp_enabled: false };
    if (path.endsWith('/auth/ldap/status')) body = { ldap_enabled: false };
    if (path.endsWith('/auth/oidc/providers')) body = [];
    if (path.endsWith('/auth/encryption-status')) body = {
      key_configured: false,
      key_source: 'none',
      legacy_plaintext_rows: { oidc_providers: 0, user_totp: 0 },
      encrypted_rows: { oidc_providers: 0, user_totp: 0 },
      decryption_broken: false,
      migration_error_count: 0,
    };
    if (path.endsWith('/system/storage-usage')) body = {
      categories: [],
      other_breakdown: [],
      roots: [],
      total_bytes: 0,
      total_formatted: '0 B',
      scan_errors: 0,
    };
    return route.fulfill({ json: body });
  });
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Authentication', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Email Authentication', exact: true })).toBeVisible();
  return { stateMutationRequests, startupTokenResponses };
}

async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) throw new Error('Settings main element is missing');
    return {
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      mainClient: main.clientWidth,
      mainScroll: main.scrollWidth,
    };
  });
  expect(dimensions.document, `document overflowed: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body, `body overflowed: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.mainScroll, `main overflowed: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.mainClient);
}

for (const width of [390, 1440]) {
  test(`all Authentication sections stay reachable without horizontal overflow at ${width}px`, async ({ page }) => {
    const { stateMutationRequests, startupTokenResponses } = await openReadOnlyAdminSettings(page, width);
    const authenticationButton = page.getByRole('button', { name: 'Email Authentication', exact: true });
    const authNavigation = authenticationButton.locator('xpath=..');
    await expect(authNavigation.getByRole('button')).toHaveCount(6);

    try {
      for (const { label } of sections) {
        const button = authNavigation.getByRole('button', { name: label, exact: true });
        await expect(button, `${label} tab should be rendered and visible`).toBeVisible();
        const bounds = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
        expect(bounds.left, `${label} starts outside the viewport`).toBeGreaterThanOrEqual(0);
        expect(bounds.right, `${label} ends outside the viewport`).toBeLessThanOrEqual(width);
        expect(bounds.top, `${label} starts below the viewport`).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom, `${label} ends below the viewport`).toBeLessThanOrEqual(width === 1440 ? 1000 : 844);
      }

      if (width === 1440) {
        const tabTops = await authNavigation.getByRole('button').evaluateAll((buttons) =>
          buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
        );
        expect(new Set(tabTops).size, 'desktop Authentication tabs should keep their single-row layout').toBe(1);
      }

      await expectNoHorizontalOverflow(page);
      for (const section of sections) {
        await authNavigation.getByRole('button', { name: section.label, exact: true }).click();
        const marker = section.marker();
        if (marker.selector === 'heading') {
          await expect(page.getByRole('heading', { name: marker.name, exact: true })).toBeVisible();
        } else {
          await expect(page.locator(marker.name)).toBeVisible();
        }
        await expectNoHorizontalOverflow(page);
      }
    } finally {
      expect(stateMutationRequests, 'Authentication navigation must not write settings, credentials, or security options').toEqual([]);
      expect(startupTokenResponses.every(({ request, status }) =>
        (request === 'POST /api/v1/auth/ws-token' && status === 200) ||
        (request === 'POST /api/v1/printers/camera/stream-token' && status === 405),
      )).toBe(true);
    }
  });
}
