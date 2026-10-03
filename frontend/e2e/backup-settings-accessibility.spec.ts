import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const backupConfig = {
  id: 23,
  repository_url: 'https://backup.example.invalid/fixture/repo',
  has_token: false,
  branch: 'fixture-main',
  provider: 'github',
  allow_insecure_http: false,
  schedule_enabled: false,
  schedule_type: 'daily',
  backup_kprofiles: false,
  backup_cloud_profiles: false,
  backup_settings: false,
  backup_spools: false,
  backup_archives: false,
  enabled: false,
  last_backup_at: null,
  last_backup_status: null,
  last_backup_message: null,
  last_backup_commit_sha: null,
  next_scheduled_run: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

for (const width of [1440, 390]) {
  test(`Backup settings inputs have meaningful labels at ${width}px`, async ({ page }) => {
    const blockedWrites: string[] = [];
    await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      localStorage.setItem('i18nextLng', 'en');
      localStorage.setItem('auth_token', 'fictional-backup-settings-token');
    });
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      let path = new URL(request.url()).pathname;
      while (path.endsWith('/')) path = path.slice(0, -1);
      if (request.method() !== 'GET') {
        blockedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only fictional backup fixture' } });
      }

      let body: unknown = [];
      if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
      if (path === '/api/v1/settings') body = { check_updates: false, local_backup_enabled: false };
      if (path === '/api/v1/github-backup/config') body = backupConfig;
      if (path === '/api/v1/github-backup/status') body = {
        configured: true, enabled: false, is_running: false, progress: null,
        last_backup_at: null, last_backup_status: null, next_scheduled_run: null,
      };
      if (path === '/api/v1/github-backup/logs') body = [];
      if (path === '/api/v1/local-backup/status') body = {
        enabled: false, schedule: 'daily', time: '02:00', retention: 7,
        path: '', default_path: '/fictional/backups', is_running: false,
        last_backup_at: null, last_status: null, last_message: null, next_run: null, timezone: 'UTC',
      };
      if (path === '/api/v1/local-backup/backups') body = [];
      if (path === '/api/v1/cloud/status') body = { is_authenticated: false, email: null };
      if (path === '/api/v1/printers') body = [];
      return route.fulfill({ json: body });
    });

    await page.goto('/settings?tab=backup');
    const card = page.locator('#card-backup-github');
    await expect(card.getByRole('heading', { name: 'Git Backup', exact: true })).toBeVisible();
    await expect(card.getByRole('combobox', { name: 'Git Provider', exact: true })).toHaveValue('github');
    await expect(card.getByRole('textbox', { name: 'Repository URL', exact: true })).toHaveValue(backupConfig.repository_url);
    await expect(card.locator('input[type="password"]')).toHaveAccessibleName('Personal Access Token');
    await expect(card.getByRole('textbox', { name: 'Branch', exact: true })).toHaveValue('fixture-main');
    await expect(card.getByRole('combobox', { name: 'Auto Backup', exact: true })).toHaveValue('disabled');
    await expect(card.getByRole('checkbox', { name: /^K-Profiles\b/ })).toBeVisible();
    await expect(card.getByRole('checkbox', { name: /^Cloud Profiles\b/ })).toBeVisible();
    expect(blockedWrites.filter((request) => /github-backup|local-backup/.test(request))).toEqual([]);
  });
}
