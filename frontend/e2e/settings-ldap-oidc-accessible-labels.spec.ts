import type {
  APIKey,
  ArchivePurgeSettings,
  AdvancedAuthStatus,
  AppSettings,
  AuthStatus,
  CloudAuthStatus,
  DebugLoggingState,
  EncryptionStatus,
  ExternalLink,
  GitHubBackupStatus,
  Group,
  LDAPStatus,
  LibraryTrashSettings,
  MQTTStatus,
  NotificationProvider,
  NotificationTemplate,
  ObicoStatus,
  OIDCProvider,
  Printer,
  PrintQueueItem,
  SmartPlug,
  SpoolBuddyDevice,
  SponsorPromptCheckResponse,
  TwoFAStatus,
  UpdateCheckResult,
  UserResponse,
  VersionInfo,
  VirtualPrinterSettings,
} from '../src/api/client';
import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const authUser: UserResponse = {
  id: 198,
  username: 'Fictional Directory Accessibility Admin',
  role: 'admin',
  is_active: true,
  is_admin: true,
  auth_source: 'local',
  groups: [],
  permissions: ['settings:read', 'settings:update'],
  created_at: '2026-01-01T00:00:00Z',
};

const settings: Partial<AppSettings> = {
  language: 'en',
  date_format: 'system',
  time_format: 'system',
  currency: 'USD',
  local_login_enabled: true,
  ldap_server_url: '',
  ldap_bind_dn: '',
  ldap_search_base: '',
  ldap_user_filter: '(sAMAccountName={username})',
  ldap_security: 'starttls',
  ldap_group_mapping: '',
  ldap_auto_provision: false,
  ldap_default_group: '',
};

const groups: Group[] = [
  {
    id: 901,
    name: 'Fixture Operators',
    description: 'Fictional group for read-only accessibility coverage.',
    permissions: [],
    is_system: false,
    user_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 902,
    name: 'Fixture Viewers',
    description: 'Fictional group for read-only accessibility coverage.',
    permissions: [],
    is_system: false,
    user_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const advancedAuthStatus: AdvancedAuthStatus = {
  advanced_auth_enabled: false,
  smtp_configured: false,
  local_login_enabled: true,
  autologin_provider_id: null,
};

const ldapStatus: LDAPStatus = {
  ldap_enabled: false,
  ldap_configured: false,
};

const twoFAStatus: TwoFAStatus = {
  totp_enabled: false,
  email_otp_enabled: false,
  backup_codes_remaining: 0,
};

const encryptionStatus: EncryptionStatus = {
  key_configured: false,
  key_source: 'none',
  legacy_plaintext_rows: { oidc_providers: 0, user_totp: 0 },
  encrypted_rows: { oidc_providers: 0, user_totp: 0 },
  decryption_broken: false,
  migration_error_count: 0,
};

const oidcProviders: OIDCProvider[] = [];
const authStatus: AuthStatus = { auth_enabled: true, requires_setup: false };
const apiKeys: APIKey[] = [];
const cloudAuthStatus: CloudAuthStatus = { is_authenticated: false, email: null, region: null };
const debugLoggingState: DebugLoggingState = { enabled: false, enabled_at: null, duration_seconds: null };
const externalLinks: ExternalLink[] = [];
const githubBackupStatus: GitHubBackupStatus = {
  configured: false,
  enabled: false,
  is_running: false,
  progress: null,
  last_backup_at: null,
  last_backup_status: null,
  next_scheduled_run: null,
};
const notificationProviders: NotificationProvider[] = [];
const notificationTemplates: NotificationTemplate[] = [];
const obicoStatus: ObicoStatus = {
  is_running: false,
  last_error: null,
  per_printer: {},
  thresholds: { low: 0, high: 0 },
  history: [],
  enabled: false,
  ml_url: '',
  sensitivity: 'medium',
  action: 'notify',
  poll_interval: 30,
  external_url_configured: false,
};
const printers: Printer[] = [];
const printQueue: PrintQueueItem[] = [];
const smartPlugs: SmartPlug[] = [];
const spoolBuddyDevices: SpoolBuddyDevice[] = [];
const sponsorPromptCheck: SponsorPromptCheckResponse = { show: false };
const mqttStatus: MQTTStatus = { enabled: false, connected: false, broker: '', port: 1883, topic_prefix: '' };
const libraryTrashSettings: LibraryTrashSettings = {
  retention_days: 0,
  auto_purge_enabled: false,
  auto_purge_days: 0,
  auto_purge_include_never_printed: false,
};
const archivePurgeSettings: ArchivePurgeSettings = { enabled: false, days: 0, purge_stats: false };
const updateCheck: UpdateCheckResult = {
  update_available: false,
  current_version: '0.0.0',
  latest_version: null,
};
const versionInfo: VersionInfo = { version: '0.0.0', repo: 'fictional-directory-fixture' };
const virtualPrinterSettings: VirtualPrinterSettings = {
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
};
const ffmpegStatus: { available: boolean; version: string | null } = { available: false, version: null };
const defaultSidebarOrder: { default_sidebar_order: string } = { default_sidebar_order: '{}' };
const developerModeWarnings: Array<{ printer_id: number; name: string }> = [];
const pendingUploadsCount: { count: number } = { count: 0 };
const colorNameMap: { colors: Record<string, string> } = { colors: {} };

type BlockedRequest = { method: string; path: string; status: number };
type ReadOnlyFixture = {
  blockedRequests: BlockedRequest[];
  blockedWebSockets: string[];
  externalReads: string[];
  unmatchedReads: string[];
};

async function openReadOnlyAuthenticationSettings(
  page: Page,
  width: number,
  section: 'ldap' | 'oidc',
): Promise<ReadOnlyFixture> {
  const blockedRequests: BlockedRequest[] = [];
  const blockedWebSockets: string[] = [];
  const externalReads: string[] = [];
  const unmatchedReads: string[] = [];
  const previewOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
  const responses = new Map<string, unknown>([
    ['/api/v1/auth/status', authStatus],
    ['/api/v1/auth/me', authUser],
    ['/api/v1/settings', settings],
    ['/api/v1/auth/advanced-auth/status', advancedAuthStatus],
    ['/api/v1/auth/ldap/status', ldapStatus],
    ['/api/v1/auth/2fa/status', twoFAStatus],
    ['/api/v1/auth/oidc/providers', oidcProviders],
    ['/api/v1/auth/oidc/providers/all', oidcProviders],
    ['/api/v1/auth/encryption-status', encryptionStatus],
    ['/api/v1/groups', groups],
    ['/api/v1/system/storage-usage', {
      categories: [],
      other_breakdown: [],
      roots: [],
      total_bytes: 0,
      total_formatted: '0 B',
      scan_errors: 0,
    }],
    ['/api/v1/system/appliance', { locale: null }],
    ['/api/v1/smart-plugs', smartPlugs],
    ['/api/v1/notifications', notificationProviders],
    ['/api/v1/api-keys', apiKeys],
    ['/api/v1/printers', printers],
    ['/api/v1/notification-templates', notificationTemplates],
    ['/api/v1/settings/virtual-printer', virtualPrinterSettings],
    ['/api/v1/spoolbuddy/devices', spoolBuddyDevices],
    ['/api/v1/obico/status', obicoStatus],
    ['/api/v1/settings/check-ffmpeg', ffmpegStatus],
    ['/api/v1/updates/version', versionInfo],
    ['/api/v1/library/trash/settings', libraryTrashSettings],
    ['/api/v1/archives/purge/settings', archivePurgeSettings],
    ['/api/v1/updates/check', updateCheck],
    ['/api/v1/settings/mqtt/status', mqttStatus],
    ['/api/v1/github-backup/status', githubBackupStatus],
    ['/api/v1/cloud/status', cloudAuthStatus],
    ['/api/v1/users', [] as UserResponse[]],
    ['/api/v1/sponsor-prompt/check', sponsorPromptCheck],
    ['/api/v1/settings/default-sidebar-order', defaultSidebarOrder],
    ['/api/v1/external-links', externalLinks],
    ['/api/v1/support/debug-logging', debugLoggingState],
    ['/api/v1/printers/developer-mode-warnings', developerModeWarnings],
    ['/api/v1/queue', printQueue],
    ['/api/v1/pending-uploads/count', pendingUploadsCount],
    ['/api/v1/inventory/colors/map', colorNameMap],
  ]);

  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-directory-accessibility-session');
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/+$/, '');

    if (request.method() !== 'GET') {
      blockedRequests.push({ method: request.method(), path, status: 405 });
      return route.fulfill({ status: 405, json: { detail: 'Read-only LDAP and OIDC accessibility fixture' } });
    }

    if (url.origin !== previewOrigin) {
      externalReads.push(url.href);
      return route.abort('blockedbyclient');
    }

    if (!path.startsWith('/api/')) return route.continue();

    const body = responses.get(path);
    if (body === undefined) {
      unmatchedReads.push(path);
      return route.fulfill({ status: 404, json: { detail: 'Unconfigured GET fixture' } });
    }
    return route.fulfill({ json: body });
  });
  await page.routeWebSocket((url) => {
    if (!url.pathname.startsWith('/api/')) return false;
    blockedWebSockets.push(url.pathname);
    return true;
  }, (socket) => socket.close());

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Authentication', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Email Authentication', exact: true })).toBeVisible();

  if (section === 'ldap') {
    await page.getByRole('button', { name: 'LDAP', exact: true }).click();
    await expect(page.locator('#card-ldap-server')).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'SSO / OIDC', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'SSO / OIDC Providers', exact: true })).toBeVisible();
  }

  return { blockedRequests, blockedWebSockets, externalReads, unmatchedReads };
}

async function expectNativeLabel(page: Page, name: RegExp) {
  const control = page.getByLabel(name, { exact: false });
  await expect(control, 'the visible caption should find exactly one control').toHaveCount(1);
  const hasNativeLabel = await control.evaluate((element) =>
    Array.from(element.ownerDocument.querySelectorAll('label')).some((label) => label.control === element),
  );
  expect(hasNativeLabel, 'the caption should be a native label for the control').toBe(true);
}

function expectReadOnly(fixture: ReadOnlyFixture) {
  expect(
    fixture.blockedRequests.every(({ status }) => status === 405),
    'every non-GET request must be rejected with 405',
  ).toBe(true);
  expect(
    fixture.blockedRequests.filter(({ path }) =>
      path === '/api/v1/settings' ||
      path === '/api/v1/auth/ldap/test' ||
      path === '/api/v1/auth/advanced-auth/enable' ||
      path === '/api/v1/auth/oidc/providers' ||
      /^\/api\/v1\/auth\/oidc\/providers\/\d+/.test(path),
    ),
    'the settings, LDAP test, enable, and OIDC provider mutation endpoints must stay untouched',
  ).toEqual([]);
  expect(fixture.blockedWebSockets.every((path) => path.startsWith('/api/'))).toBe(true);
  expect(fixture.externalReads, 'the local fixture must not access external hosts').toEqual([]);
  expect(fixture.unmatchedReads, 'every application GET must have an explicit fixture').toEqual([]);
}

for (const width of [390, 1440]) {
  test('LDAP directory, provisioning, and group captions resolve to controls at ' + width + 'px', async ({ page }) => {
    const fixture = await openReadOnlyAuthenticationSettings(page, width, 'ldap');

    try {
      await expect(page.locator('#card-ldap-server')).toBeVisible();

      await expectNativeLabel(page, /^Server URL$/);
      await expectNativeLabel(page, /^Bind DN/);
      await expectNativeLabel(page, /^Bind Password$/);
      await expectNativeLabel(page, /^Search Base DN$/);
      await expectNativeLabel(page, /^User Search Filter$/);

      const security = page.getByRole('group', { name: 'Security', exact: true });
      await expect(security).toHaveCount(1);
      await expect(security.getByRole('button', { name: 'StartTLS', exact: true })).toBeVisible();
      await expect(security.getByRole('button', { name: 'LDAPS', exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Advanced', exact: true }).click();
      await expectNativeLabel(page, /^Default group$/);
      await expectNativeLabel(page, /^Group Mapping \(JSON\)$/);

      await expectNativeLabel(page, /^Auto-provision users$/);
    } finally {
      expectReadOnly(fixture);
    }
  });

  test('blank New Provider captions resolve to controls at ' + width + 'px', async ({ page }) => {
    const fixture = await openReadOnlyAuthenticationSettings(page, width, 'oidc');

    try {
      await expect(page.getByRole('heading', { name: 'SSO / OIDC Providers', exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Add Provider', exact: true }).first().click();
      await expect(page.getByText('New Provider', { exact: true })).toBeVisible();

      await expectNativeLabel(page, /^Display Name/);
      await expectNativeLabel(page, /^Issuer URL/);
      await expectNativeLabel(page, /^Client ID/);
      await expectNativeLabel(page, /^Client Secret/);
      await expectNativeLabel(page, /^Scopes$/);
      await expectNativeLabel(page, /^Icon URL/);
      await expectNativeLabel(page, /^Email Claim$/);
      await expectNativeLabel(page, /^Default Group$/);

      for (const name of [
        /^Enabled\b/,
        /^Auto-create users\b/,
        /^Auto-link existing accounts\b/,
        /^Require email verified\b/,
        /^Autologin\b/,
      ]) {
        await expect(page.getByRole('switch', { name })).toHaveCount(1);
      }
    } finally {
      expectReadOnly(fixture);
    }
  });
}
