import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

type ReadOnlyFixture = {
  blockedRequests: Array<{ method: string; path: string; status: number }>;
  blockedWebSockets: string[];
  externalReads: string[];
  unmatchedReads: string[];
};

async function openQueueDrying(
  page: Page,
  width: number,
  language: 'en' | 'de' = 'en',
  includeSpacedFilament = false,
): Promise<ReadOnlyFixture> {
  const fixture: ReadOnlyFixture = {
    blockedRequests: [], blockedWebSockets: [], externalReads: [], unmatchedReads: [],
  };
  const previewOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001');
  const responses = new Map<string, unknown>([
    ['/api/v1/auth/status', { auth_enabled: true, requires_setup: false }],
    ['/api/v1/auth/me', {
      id: 198, username: 'Fictional Drying Accessibility Admin', groups: [],
      permissions: ['settings:read', 'settings:update'],
    }],
    ['/api/v1/settings', {
      language, date_format: 'system', time_format: 'system', currency: 'USD',
      queue_drying_enabled: true, queue_drying_block: false,
      ambient_drying_enabled: false, print_drying_enabled: false,
      drying_presets: includeSpacedFilament ? JSON.stringify({
        PLA: { n3f: 45, n3f_hours: 12, n3s: 45, n3s_hours: 12 },
        'PLA Basic': { n3f: 55, n3f_hours: 12, n3s: 60, n3s_hours: 18 },
      }) : '',
      ams_humidity_thresholds: '', ams_humidity_fair: 60,
    }],
    ['/api/v1/system/storage-usage', {
      categories: [], other_breakdown: [], roots: [], total_bytes: 0,
      total_formatted: '0 B', scan_errors: 0,
    }],
    ['/api/v1/printers', []],
    ['/api/v1/system/appliance', { locale: null }],
    ['/api/v1/smart-plugs', []],
    ['/api/v1/notifications', []],
    ['/api/v1/api-keys', []],
    ['/api/v1/notification-templates', []],
    ['/api/v1/settings/virtual-printer', {
      enabled: false, access_code_set: false, mode: 'archive', model: '', target_printer_id: null,
      remote_interface_ip: null, tailscale_disabled: false, archive_name_source: 'metadata',
      status: { enabled: false, running: false, mode: 'archive', name: '', serial: '', model: '', model_name: '', pending_files: 0 },
    }],
    ['/api/v1/spoolbuddy/devices', []],
    ['/api/v1/obico/status', {
      is_running: false, last_error: null, per_printer: {}, thresholds: { low: 0, high: 0 },
      history: [], enabled: false, ml_url: '', sensitivity: 'medium', action: 'notify',
      poll_interval: 30, external_url_configured: false,
    }],
    ['/api/v1/settings/check-ffmpeg', { available: false, version: null }],
    ['/api/v1/updates/version', { version: '0.0.0', repo: 'fictional-drying-accessibility-fixture' }],
    ['/api/v1/updates/check', { update_available: false, current_version: '0.0.0', latest_version: null }],
    ['/api/v1/settings/mqtt/status', { enabled: false, connected: false, broker: '', port: 1883, topic_prefix: '' }],
    ['/api/v1/github-backup/status', {
      configured: false, enabled: false, is_running: false, progress: null,
      last_backup_at: null, last_backup_status: null, next_scheduled_run: null,
    }],
    ['/api/v1/cloud/status', { is_authenticated: false, email: null, region: null }],
    ['/api/v1/auth/advanced-auth/status', { advanced_auth_enabled: false, smtp_configured: false, local_login_enabled: true, autologin_provider_id: null }],
    ['/api/v1/auth/ldap/status', { ldap_enabled: false, ldap_configured: false }],
    ['/api/v1/auth/2fa/status', { totp_enabled: false, email_otp_enabled: false, backup_codes_remaining: 0 }],
    ['/api/v1/sponsor-prompt/check', { show: false }],
    ['/api/v1/settings/default-sidebar-order', { default_sidebar_order: '{}' }],
    ['/api/v1/external-links', []],
    ['/api/v1/support/debug-logging', { enabled: false, enabled_at: null, duration_seconds: null }],
    ['/api/v1/printers/developer-mode-warnings', []],
    ['/api/v1/queue', []],
    ['/api/v1/pending-uploads/count', { count: 0 }],
    ['/api/v1/inventory/colors/map', { colors: {} }],
  ]);

  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript((selectedLanguage: string) => {
    localStorage.setItem('auth_token', 'fictional-drying-accessibility-session');
    localStorage.setItem('bambutrack_language', selectedLanguage);
  }, language);
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/+$/, '');

    if (request.method() !== 'GET') {
      fixture.blockedRequests.push({ method: request.method(), path, status: 405 });
      return route.fulfill({ status: 405, json: { detail: 'Read-only Queue drying fixture' } });
    }
    if (url.origin !== previewOrigin.origin) {
      fixture.externalReads.push(url.href);
      return route.abort('blockedbyclient');
    }
    if (!path.startsWith('/api/')) {
      if (language === 'de' && request.resourceType() === 'document') {
        const response = await route.fetch();
        const html = await response.text();
        const germanFixture = html.replace(
          'localStorage.setItem("bambutrack_language","en")',
          'localStorage.setItem("bambutrack_language","de")',
        );
        expect(germanFixture, 'the preview locale override should be present').not.toBe(html);
        return route.fulfill({ response, body: germanFixture });
      }
      return route.continue();
    }

    const body = responses.get(path);
    if (body === undefined) {
      fixture.unmatchedReads.push(path);
      return route.fulfill({ status: 404, json: { detail: 'Unconfigured GET fixture' } });
    }
    return route.fulfill({ json: body });
  });
  await page.routeWebSocket((url) => {
    if (url.host !== previewOrigin.host) fixture.externalReads.push(url.href);
    else fixture.blockedWebSockets.push(url.pathname);
    return true;
  }, (socket) => socket.close());

  await page.goto('/settings?tab=queue&sub=dispatch');
  await expect(page.getByRole('heading', {
    name: language === 'de' ? 'Automatische Trocknung' : 'Queue Auto-Drying', exact: true,
  })).toBeVisible();
  return fixture;
}

function expectFixtureStayedReadOnly(fixture: ReadOnlyFixture) {
  expect(fixture.blockedRequests.every(({ status }) => status === 405), 'all writes must receive 405').toBe(true);
  expect(
    fixture.blockedRequests.filter(({ path }) =>
      path === '/api/v1/settings' || /\/api\/v1\/queue(?:\/|$)/.test(path) || /\/api\/v1\/prints?(?:\/|$)/.test(path),
    ),
    'settings and print side effects must not be attempted',
  ).toEqual([]);
  expect(fixture.blockedWebSockets, 'the app WebSocket must be intercepted and closed').toContain('/api/v1/ws');
  expect(fixture.externalReads, 'no external request may escape the fixture').toEqual([]);
  expect(fixture.unmatchedReads, 'every application GET must have an explicit fixture').toEqual([]);
}

test('drying preset headers use translated German accessible names', async ({ page }) => {
  const fixture = await openQueueDrying(page, 1440, 'de');
  try {
    for (const name of [
      'PLA AMS 2 Pro Temperatur (°C)',
      'PLA AMS 2 Pro Dauer (h)',
      'PLA AMS-HT Temperatur (°C)',
      'PLA AMS-HT Dauer (h)',
    ]) {
      await expect(page.getByRole('spinbutton', { name, exact: true }), `${name} should use the German visible column label`).toHaveCount(1);
    }
  } finally {
    expectFixtureStayedReadOnly(fixture);
  }
});

for (const width of [390, 1440]) {
  test(`filament names with spaces remain complete in preset accessible names at ${width}px`, async ({ page }) => {
    const fixture = await openQueueDrying(page, width, 'en', true);
    try {
      const row = page.getByRole('row').filter({
        has: page.getByRole('rowheader', { name: 'PLA Basic', exact: true }),
      });
      await expect(row).toHaveCount(1);
      const expectedNames = [
        'PLA Basic AMS 2 Pro Temperature (°C)',
        'PLA Basic AMS 2 Pro Duration (h)',
        'PLA Basic AMS-HT Temperature (°C)',
        'PLA Basic AMS-HT Duration (h)',
      ];
      for (const name of expectedNames) {
        await expect(page.getByRole('spinbutton', { name, exact: true }), `${name} should retain the full visible filament name`).toHaveCount(1);
      }
    } finally {
      expectFixtureStayedReadOnly(fixture);
    }
  });
}

async function expectNativeVisibleLabel(page: Page, name: string) {
  const control = page.getByRole('checkbox', { name, exact: true });
  await expect(control, `${name} should resolve by its visible caption`).toHaveCount(1);
  const captionIsNativeLabel = await control.evaluate((element) =>
    Array.from((element as HTMLInputElement).labels ?? []).some((label) => label.textContent?.trim()),
  );
  expect(captionIsNativeLabel, `${name} should use its visible caption as a native label`).toBe(true);
}

for (const width of [390, 1440]) {
  test(`enabled auto-drying exposes its wait caption at ${width}px`, async ({ page }) => {
    const fixture = await openQueueDrying(page, width);
    try {
      await expectNativeVisibleLabel(page, 'Wait for drying to complete');
    } finally {
      expectFixtureStayedReadOnly(fixture);
    }
  });

  test(`Queue drying toggles use native visible captions at ${width}px`, async ({ page }) => {
    const fixture = await openQueueDrying(page, width);
    try {
      await expectNativeVisibleLabel(page, 'Enable auto-drying');
      await expectNativeVisibleLabel(page, 'Ambient drying');
      await expectNativeVisibleLabel(page, 'Continue drying while printing');
    } finally {
      expectFixtureStayedReadOnly(fixture);
    }
  });

  test(`drying and humidity controls resolve unique visible table context at ${width}px`, async ({ page }) => {
    const fixture = await openQueueDrying(page, width);
    try {
      const presets = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'AMS 2 Pro', exact: true }) });
      const dryingFilaments = await presets.locator('tbody tr').evaluateAll((rows) =>
        rows.map((row) => row.querySelector('th[scope="row"], td')?.textContent?.trim() ?? '').filter(Boolean),
      );
      for (const filament of dryingFilaments) {
        for (const name of [
          `${filament} AMS 2 Pro Temperature (°C)`,
          `${filament} AMS 2 Pro Duration (h)`,
          `${filament} AMS-HT Temperature (°C)`,
          `${filament} AMS-HT Duration (h)`,
        ]) {
          await expect(page.getByRole('spinbutton', { name, exact: true }), `${name} needs its visible row, device, field, and unit context`).toHaveCount(1);
        }
      }

      const humidity = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Threshold', exact: true }) });
      const thresholdFilaments = await humidity.locator('tbody tr').evaluateAll((rows) =>
        rows.map((row) => row.querySelector('th[scope="row"], td')?.textContent?.trim() ?? '').filter(Boolean),
      );
      for (const filament of thresholdFilaments) {
        const name = `${filament} Threshold`;
        await expect(page.getByRole('spinbutton', { name, exact: true }), `${name} needs its visible row and column context`).toHaveCount(1);
      }
    } finally {
      expectFixtureStayedReadOnly(fixture);
    }
  });
}
