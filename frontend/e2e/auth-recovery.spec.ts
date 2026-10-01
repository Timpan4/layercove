import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

test('a temporary backend failure offers recovery without asking for credentials', async ({ page }) => {
  let available = false;
  await page.addInitScript(() => localStorage.setItem('auth_token', 'test-session'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
    if (path.endsWith('/auth/status')) {
      return route.fulfill({ json: { auth_enabled: true, requires_setup: false } });
    }
    if (path.endsWith('/auth/me')) {
      return available
        ? route.fulfill({ json: { id: 1, username: 'testuser', is_active: true, permissions: ['library:read'], groups: [] } })
        : route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable' } });
    }
    await route.fulfill({ json: [] });
  });
  await page.goto('/files');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).not.toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/files');
  available = true;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'File Manager', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('test-session');
});

test('Remember Me retains the choice after reopening the login page', async ({ page }) => {
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/auth/status') ? { auth_enabled: true, requires_setup: false }
      : path.endsWith('/auth/advanced-auth/status') ? { advanced_auth_enabled: false, local_login_enabled: true }
      : [];
    await route.fulfill({ json: body });
  });
  await page.goto('/login');
  const remember = page.getByRole('checkbox', { name: 'Remember Me', exact: true });
  await remember.check();
  await page.reload();
  await expect(remember).toBeChecked();
  await remember.uncheck();
  await page.reload();
  await expect(remember).not.toBeChecked();
});

test('an interrupted SSO login respects a later Remember Me opt-out', async ({ page }) => {
  let interrupted = false;
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: true, requires_setup: false };
    if (path.endsWith('/auth/advanced-auth/status')) body = { advanced_auth_enabled: false, local_login_enabled: true };
    if (path.endsWith('/auth/oidc/providers')) body = [{ id: 1, name: 'Test SSO', is_enabled: true }];
    if (path.endsWith('/auth/oidc/authorize/1')) {
      body = { auth_url: `${url.origin}/login${interrupted ? '#oidc_token=test-exchange' : '?interrupted=1'}` };
      interrupted = true;
    }
    if (path.endsWith('/auth/oidc/exchange')) body = {
      access_token: 'new-session', user: { id: 1, username: 'testuser', permissions: [], groups: [] },
    };
    await route.fulfill({ json: body });
  });
  await page.goto('/login');
  await page.getByRole('checkbox', { name: 'Remember Me', exact: true }).check();
  await page.getByRole('button', { name: 'Sign in with Test SSO', exact: true }).click();
  await page.waitForURL('**/login?interrupted=1');
  await page.getByRole('checkbox', { name: 'Remember Me', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Sign in with Test SSO', exact: true }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('auth_token'))).toBe('new-session');
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
});

test('a tab-only login removes an older remembered login', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('auth_token', 'old-session'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const user = { id: 1, username: 'testuser', permissions: [], groups: [] };
    const body = path.endsWith('/auth/status') ? { auth_enabled: true, requires_setup: false }
      : path.endsWith('/auth/advanced-auth/status') ? { advanced_auth_enabled: false, local_login_enabled: true }
      : path.endsWith('/auth/me') ? user
      : path.endsWith('/auth/login') ? { access_token: 'new-session', user }
      : [];
    await route.fulfill({ json: body });
  });
  await page.goto('/login');
  await page.getByRole('checkbox', { name: 'Remember Me', exact: true }).uncheck();
  await page.getByLabel('Username', { exact: true }).fill('testuser');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('auth_token'))).toBe('new-session');
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
});

test('a revoked session still requires sign-in and clears the saved token', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('auth_token', 'revoked-session'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) {
      return route.fulfill({ status: 401, json: { detail: 'Could not validate credentials' } });
    }
    await route.fulfill({ json: path.endsWith('/auth/status')
      ? { auth_enabled: true, requires_setup: false } : [] });
  });
  await page.goto('/files');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/login');
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
});
