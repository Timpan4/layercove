import type { Page } from '@playwright/test';
import { test, expect } from './test';

type FixtureValue = string | number | boolean | null | FixtureValue[] | { [key: string]: FixtureValue };

test.use({ serviceWorkers: 'block' });

const settingsFixture = {
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
  check_updates: false,
  library_disk_warning_gb: 5,
  obico_enabled: false,
  obico_ml_url: '',
  obico_sensitivity: 'medium',
  obico_action: 'notify',
  obico_poll_interval: 10,
  obico_enabled_printers: '',
} satisfies Record<string, FixtureValue>;

const getFixtures = new Map<string, FixtureValue>([
  ['/api/v1/auth/status', { auth_enabled: true, requires_setup: false }],
  ['/api/v1/auth/me', {
    id: 901,
    username: 'Fixture Printer Detection',
    groups: [],
    permissions: [
      'settings:read', 'settings:update', 'printers:read', 'library:purge', 'archives:purge',
    ],
  }],
  ['/api/v1/system/appliance', { locale: null }],
  ['/api/v1/settings', settingsFixture],
  ['/api/v1/settings/default-sidebar-order', { default_sidebar_order: '' }],
  ['/api/v1/support/debug-logging', { enabled: false, enabled_at: null, duration_seconds: null }],
  ['/api/v1/updates/check', { update_available: false, latest_version: null }],
  ['/api/v1/sponsor-prompt/check', { show: false }],
  ['/api/v1/system/storage-usage', {
    categories: [], other_breakdown: [], roots: [], total_bytes: 0,
    total_formatted: '0 B', scan_errors: 0,
  }],
  ['/api/v1/smart-plugs', []],
  ['/api/v1/notifications', []],
  ['/api/v1/api-keys', []],
  ['/api/v1/printers', []],
  ['/api/v1/printers/developer-mode-warnings', []],
  ['/api/v1/queue', []],
  ['/api/v1/pending-uploads/count', { count: 0 }],
  ['/api/v1/inventory/colors/map', { colors: {} }],
  ['/api/v1/external-links', []],
  ['/api/v1/notification-templates', []],
  ['/api/v1/settings/virtual-printer', {
    enabled: false,
    access_code_set: false,
    mode: 'archive',
    model: '',
    target_printer_id: null,
    remote_interface_ip: null,
    tailscale_disabled: false,
    archive_name_source: 'metadata',
    status: {
      enabled: false,
      running: false,
      mode: 'archive',
      name: '',
      serial: '',
      model: '',
      model_name: '',
      pending_files: 0,
    },
  }],
  ['/api/v1/spoolbuddy/devices', []],
  ['/api/v1/obico/status', {
    is_running: false,
    last_error: null,
    per_printer: {},
    thresholds: { low: 0.5, high: 0.8 },
    history: [],
    enabled: false,
    ml_url: '',
    sensitivity: 'medium',
    action: 'notify',
    poll_interval: 10,
    external_url_configured: false,
  }],
  ['/api/v1/settings/check-ffmpeg', { installed: false, path: null }],
  ['/api/v1/updates/version', {
    current_version: '1.0.0', latest_version: null, update_available: false,
  }],
  ['/api/v1/library/trash/settings', {
    retention_days: 30,
    auto_purge_enabled: false,
    auto_purge_days: 90,
    auto_purge_include_never_printed: false,
  }],
  ['/api/v1/archives/purge/settings', { enabled: false, days: 30, purge_stats: false }],
  ['/api/v1/settings/mqtt/status', { enabled: false, connected: false }],
  ['/api/v1/github-backup/status', {
    configured: false,
    enabled: false,
    is_running: false,
    progress: null,
    last_backup_at: null,
    last_backup_status: null,
    next_scheduled_run: null,
  }],
  ['/api/v1/cloud/status', { is_authenticated: false, email: null, region: null }],
  ['/api/v1/auth/advanced-auth/status', {
    advanced_auth_enabled: false,
    smtp_configured: false,
    local_login_enabled: true,
    autologin_provider_id: null,
  }],
  ['/api/v1/auth/ldap/status', { ldap_enabled: false, ldap_configured: false }],
  ['/api/v1/auth/2fa/status', {
    totp_enabled: false, email_otp_enabled: false, backup_codes_remaining: 0,
  }],
  ['/api/v1/virtual-printers', { printers: [], models: {} }],
  ['/api/v1/virtual-printers/ca-certificate', {
    pem: '', fingerprint_sha256: '', not_valid_after: '2099-01-01T00:00:00Z',
  }],
]);

const readOnlyServiceTokenRequests = new Set([
  'POST /api/v1/printers/camera/stream-token',
  'POST /api/v1/auth/ws-token',
]);

async function openSettingsFixture(page: Page, width: number) {
  const writes: string[] = [];
  const blockedNonGets: string[] = [];
  const unexpectedGets: string[] = [];

  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript(() => localStorage.setItem('auth_token', 'fictional-printer-detection-token'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

    if (request.method() !== 'GET') {
      const requestDescription = `${request.method()} ${path}`;
      blockedNonGets.push(requestDescription);
      if (!readOnlyServiceTokenRequests.has(requestDescription)) writes.push(requestDescription);
      return route.fulfill({ status: 405, json: { detail: 'Read-only printer detection fixture' } });
    }

    const fixture = getFixtures.get(path);
    if (fixture === undefined) {
      unexpectedGets.push(path);
      return route.fulfill({ status: 404, json: { detail: `No fixture for ${path}` } });
    }
    return route.fulfill({ json: fixture });
  });
  await page.routeWebSocket('**/api/**', (socket) => socket.close());

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  return { writes, blockedNonGets, unexpectedGets };
}

async function expectNativeCaption(control: ReturnType<Page['locator']>, caption: string) {
  const labels = await control.evaluate((element) =>
    Array.from((element as HTMLInputElement | HTMLSelectElement).labels ?? [])
      .map((label) => label.textContent?.trim() ?? ''),
  );
  expect(labels).toContain(caption);
}

for (const width of [390, 1440]) {
  test(`virtual printer Name uses its native caption at ${width}px`, async ({ page }) => {
    const { writes, blockedNonGets, unexpectedGets } = await openSettingsFixture(page, width);
    await page.getByRole('button', { name: 'Virtual Printer', exact: true }).click();
    await page.getByRole('button', { name: /Add/ }).first().click();

    const name = page.getByPlaceholder('Bambuddy', { exact: true });
    await expect(name).toBeVisible();
    await expect(name).toHaveAttribute('placeholder', 'Bambuddy');
    await expectNativeCaption(name, 'Name');

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(name).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(blockedNonGets.every((request) => readOnlyServiceTokenRequests.has(request))).toBe(true);
    expect(unexpectedGets).toEqual([]);
  });

  test(`Failure Detection field captions name disabled controls at ${width}px`, async ({ page }) => {
    const { writes, blockedNonGets, unexpectedGets } = await openSettingsFixture(page, width);
    await page.getByRole('button', { name: 'Failure Detection', exact: true }).click();

    const failureCard = page.locator('#card-fd-ml');
    const fields = [
      { control: failureCard.getByPlaceholder('http://192.168.1.10:3333', { exact: true }), caption: 'Obico ML API URL', value: '' },
      { control: failureCard.locator('select').nth(0), caption: 'Sensitivity', value: 'medium' },
      { control: failureCard.locator('select').nth(1), caption: 'Action on detected failure', value: 'notify' },
      { control: failureCard.locator('input[type="number"]'), caption: 'Poll interval (seconds)', value: '10' },
    ] as const;

    for (const field of fields) {
      await expect(field.control).toBeVisible();
      await expect(field.control).toBeDisabled();
      await expect(field.control).toHaveValue(field.value);
      await expectNativeCaption(field.control, field.caption);
    }

    await page.waitForTimeout(600);
    expect(writes).toEqual([]);
    expect(blockedNonGets.every((request) => readOnlyServiceTokenRequests.has(request))).toBe(true);
    expect(unexpectedGets).toEqual([]);
  });
}
