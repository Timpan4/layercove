import type { SMTPSettings } from '../src/api/client';
import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const controls = [
  { id: 'smtp-auth-enabled', label: 'Authentication' },
  { id: 'smtp-username', label: 'Username' },
  { id: 'smtp-password', label: 'Password' },
  { id: 'smtp-host', label: 'SMTP Server *' },
  { id: 'smtp-port', label: 'SMTP Port' },
  { id: 'smtp-security', label: 'Security' },
  { id: 'smtp-from-email', label: 'From Email *' },
  { id: 'smtp-from-name', label: 'From Name' },
  { id: 'smtp-test-recipient', label: 'Test Recipient Email' },
] as const;

const smtpSettings: SMTPSettings = {
  smtp_host: 'smtp.example.invalid',
  smtp_port: 587,
  smtp_username: 'fictional-admin@example.invalid',
  smtp_security: 'starttls',
  smtp_auth_enabled: true,
  smtp_from_email: 'notifications@example.invalid',
  smtp_from_name: 'Fictional LayerCove',
};

async function openEmailAuthentication(page: Page, width: number) {
  const rejectedWrites: Array<{ method: string; path: string; status: number }> = [];

  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-smtp-accessibility-session');
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      rejectedWrites.push({ method: request.method(), path, status: 405 });
      return route.fulfill({ status: 405, json: { detail: 'Read-only SMTP accessibility fixture' } });
    }

    let body: unknown = [];
    if (path === '/api/v1/auth/status') body = { auth_enabled: true, requires_setup: false };
    if (path === '/api/v1/auth/me') body = {
      id: 198,
      username: 'Fictional SMTP Accessibility Admin',
      is_admin: true,
      is_active: true,
      groups: [],
      permissions: ['settings:read', 'settings:update'],
    };
    if (path === '/api/v1/settings') body = {
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
    if (path === '/api/v1/auth/smtp') body = smtpSettings;
    if (path === '/api/v1/system/storage-usage') body = {
      categories: [],
      other_breakdown: [],
      roots: [],
      total_bytes: 0,
      total_formatted: '0 B',
      scan_errors: 0,
    };
    if (path === '/api/v1/auth/advanced-auth/status') body = {
      advanced_auth_enabled: false,
      local_login_enabled: true,
      smtp_configured: true,
    };
    return route.fulfill({ json: body });
  });
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Authentication', exact: true }).first().click();
  await page.getByRole('button', { name: 'Email Authentication', exact: true }).click();
  await expect(page.locator('#card-smtp-config')).toBeVisible();
  await expect(page.locator('#card-email-test')).toBeVisible();

  return { rejectedWrites };
}

for (const width of [390, 1440]) {
  test(`SMTP Email Authentication controls have native accessible labels at ${width}px`, async ({ page }) => {
    const { rejectedWrites } = await openEmailAuthentication(page, width);

    for (const { id, label } of controls) {
      const nativeLabel = page.locator(`label[for="${id}"]`);
      await expect(nativeLabel, `${label} should have a native label`).toHaveCount(1);
      await expect(nativeLabel).toHaveText(label);

      const control = page.getByLabel(label, { exact: true });
      await expect(control, `${label} should resolve to one control`).toHaveCount(1);
      await expect(control).toHaveAttribute('id', id);
      expect(await nativeLabel.evaluate((element) => (element as HTMLLabelElement).control?.id)).toBe(id);
    }

    expect(
      rejectedWrites.every(({ status }) => status === 405),
      `every non-GET API request must be rejected, received ${JSON.stringify(rejectedWrites)}`,
    ).toBe(true);
    expect(
      rejectedWrites.filter(({ path }) => path === '/api/v1/auth/smtp' || path === '/api/v1/auth/smtp/test'),
      'the SMTP settings and test endpoints must remain untouched',
    ).toEqual([]);
  });
}
