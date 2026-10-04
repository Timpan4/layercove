import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const wsOrigin = new URL(appOrigin);
wsOrigin.protocol = wsOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
const startupTokenPaths = new Set([
  '/api/v1/auth/ws-token',
  '/api/v1/printers/camera/stream-token',
]);

const providers = [
  { value: 'github', name: 'GitHub', repoPlaceholder: 'https://github.com/username/repo-name', tokenPlaceholder: 'ghp_xxxxxxxxxxxx' },
  { value: 'gitlab', name: 'GitLab', repoPlaceholder: 'https://gitlab.com/username/repo-name', tokenPlaceholder: 'glpat-xxxxxxxxxxxx' },
  { value: 'gitea', name: 'Gitea', repoPlaceholder: 'https://gitea.example.com/username/repo-name', tokenPlaceholder: 'your_access_token' },
  { value: 'forgejo', name: 'Forgejo', repoPlaceholder: 'https://forgejo.example.com/username/repo-name', tokenPlaceholder: 'your_access_token' },
] as const;

for (const width of [390, 1440]) {
  test(`Git backup provider guidance matches backend permissions at ${width}px`, async ({ page }) => {
    const blockedWrites: string[] = [];
    const externalRequests: string[] = [];
    const getPaths = new Set<string>();

    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(() => {
      localStorage.setItem('bambutrack_language', 'en');
      localStorage.setItem('auth_token', 'fictional-provider-guidance-token');
    });
    await page.routeWebSocket((url) => url.origin === wsOrigin.origin && url.pathname.startsWith('/api/'), (socket) => socket.close());
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== appOrigin) {
        externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }

      const path = url.pathname.replace(/\/$/, '');
      if (request.method() !== 'GET') {
        if (request.method() === 'POST' && startupTokenPaths.has(path)) {
          return route.fulfill({ json: { token: 'fictional-startup-token' } });
        }
        blockedWrites.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only provider guidance fixture' } });
      }

      if (!path.startsWith('/api/')) return route.continue();

      getPaths.add(path);
      let body: unknown = [];
      if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
      if (path === '/api/v1/settings') body = { language: 'en', check_updates: false, local_backup_enabled: false };
      if (path === '/api/v1/github-backup/config') body = null;
      if (path === '/api/v1/github-backup/status') body = {
        configured: false, enabled: false, is_running: false, progress: null,
        last_backup_at: null, last_backup_status: null, next_scheduled_run: null,
      };
      if (path === '/api/v1/github-backup/logs') body = [];
      if (path === '/api/v1/cloud/status') body = { is_authenticated: false, email: null };
      if (path === '/api/v1/local-backup/status') body = {
        enabled: false, schedule: 'daily', time: '02:00', retention: 7,
        path: '', default_path: '/fictional/backups', is_running: false,
        last_backup_at: null, last_status: null, last_message: null, next_run: null, timezone: 'UTC',
      };
      if (path === '/api/v1/local-backup/backups') body = [];
      if (path === '/api/v1/printers') body = [];
      return route.fulfill({ json: body });
    });

    try {
      await page.goto('/settings?tab=backup');
      const card = page.locator('#card-backup-github');
      const providerSelect = page.locator('#git-provider-select');
      const repositoryInput = page.locator('#github-backup-repository-url');
      const tokenInput = page.locator('#github-backup-access-token');
      const description = card.locator('p').first();
      const tokenHint = tokenInput.locator('xpath=following-sibling::p[1]');
      const tlsCheckbox = card.getByRole('checkbox', { name: /Allow insecure HTTP/ });

      await expect(card.getByRole('heading', { name: 'Git Backup', exact: true })).toBeVisible();
      await expect(providerSelect).toHaveValue('github');
      await expect(description).toBeVisible();
      await expect(tokenHint).toBeVisible();
      await expect(repositoryInput).toHaveValue('');
      await expect(tokenInput).toHaveValue('');
      await expect(tlsCheckbox).not.toBeChecked();

      const requiredGetPaths = [
        '/api/v1/auth/status', '/api/v1/settings', '/api/v1/github-backup/config',
        '/api/v1/github-backup/status', '/api/v1/github-backup/logs', '/api/v1/cloud/status',
        '/api/v1/local-backup/status', '/api/v1/local-backup/backups', '/api/v1/printers',
      ];
      await expect.poll(() => [...getPaths]).toEqual(expect.arrayContaining(requiredGetPaths));

      const initialStorage = await page.evaluate(() => ({
        local: Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)),
        session: Object.entries(sessionStorage).sort(([a], [b]) => a.localeCompare(b)),
      }));

      for (const provider of providers) {
        await providerSelect.selectOption(provider.value);
        await expect(providerSelect).toHaveValue(provider.value);
        await expect(repositoryInput).toHaveAttribute('placeholder', provider.repoPlaceholder);
        await expect(tokenInput).toHaveAttribute('placeholder', provider.tokenPlaceholder);
        await expect(repositoryInput).toHaveValue('');
        await expect(tokenInput).toHaveValue('');
        await expect(tlsCheckbox).not.toBeChecked();

        const descriptionText = (await description.innerText()).toLocaleLowerCase('en');
        const tiedProvider = ['github', 'gitlab', 'gitea', 'forgejo'].find((name) =>
          new RegExp(`\\b${name}\\s+(?:repository|repo)\\b`, 'i').test(descriptionText),
        );
        if (tiedProvider) expect.soft(tiedProvider, 'Description must not associate a different provider with the repository').toBe(provider.value);

        const hintText = (await tokenHint.innerText()).toLocaleLowerCase('en');
        if (provider.value === 'github') {
          expect.soft(hintText).toMatch(/contents/);
          expect.soft(hintText).toMatch(/read\s*\/\s*write/);
        } else if (provider.value === 'gitlab') {
          expect.soft(hintText).toMatch(/\bapi\b/);
        } else if (provider.value === 'gitea') {
          expect.soft(hintText).toMatch(/write\s*:\s*repository/);
        } else {
          expect.soft(hintText).toMatch(/write\s*:\s*repository/);
          expect.soft(hintText).toMatch(/read\s*:\s*user/);
        }
      }

      const finalStorage = await page.evaluate(() => ({
        local: Object.entries(localStorage).sort(([a], [b]) => a.localeCompare(b)),
        session: Object.entries(sessionStorage).sort(([a], [b]) => a.localeCompare(b)),
      }));
      expect(finalStorage, 'Changing providers must remain local and not persist browser settings or credentials').toEqual(initialStorage);

    } finally {
      expect(blockedWrites, 'Provider changes must not write config, credentials, or security settings').toEqual([]);
      expect(externalRequests, 'The fixture must not contact an external repository or service').toEqual([]);
    }
  });
}
