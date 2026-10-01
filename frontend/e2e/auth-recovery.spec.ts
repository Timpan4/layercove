import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const { failingEndpoint, failureStatus } of [
  { failingEndpoint: 'status', failureStatus: 503 },
  { failingEndpoint: 'me', failureStatus: 503 },
  { failingEndpoint: 'me', failureStatus: 401 },
]) {
test(`a temporary auth/${failingEndpoint} ${failureStatus} failure offers recovery without asking for credentials`, async ({ page }) => {
  let available = false;
  await page.addInitScript(() => localStorage.setItem('auth_token', 'test-session'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
    if (path.endsWith('/auth/status')) {
      if (failingEndpoint === 'status' && !available) {
        return route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable' } });
      }
      return route.fulfill({ json: { auth_enabled: true, requires_setup: false } });
    }
    if (path.endsWith('/auth/me')) {
      return available
        ? route.fulfill({ json: { id: 1, username: 'testuser', is_active: true, permissions: ['library:read'], groups: [] } })
        : route.fulfill({ status: failureStatus, json: { detail: failureStatus === 401 ? 'Authentication required' : 'Temporarily unavailable' } });
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
}

test('automatic SSO keeps a saved Remember Me choice', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('auth_remember_me_preference', '1'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const body = path.endsWith('/auth/status') ? { auth_enabled: true, requires_setup: false }
      : path.endsWith('/auth/advanced-auth/status') ? { advanced_auth_enabled: true, local_login_enabled: true, autologin_provider_id: 1 }
      : path.endsWith('/auth/oidc/authorize/1') ? { auth_url: `${url.origin}/login?callback=1#oidc_token=test-exchange` }
      : path.endsWith('/auth/oidc/exchange') ? { access_token: 'new-session', user: { id: 1, username: 'testuser', permissions: [], groups: [] } }
      : [];
    await route.fulfill({ json: body });
  });
  await page.goto('/login');
  await page.waitForURL((url) => url.pathname === '/');
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('new-session');
});

test('an unverified kiosk link preserves a remembered credential during an outage', async ({ page }) => {
  let available = false;
  await page.addInitScript(() => localStorage.setItem('auth_token', 'saved-session'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/status')) return available
      ? route.fulfill({ json: { auth_enabled: true, requires_setup: false } })
      : route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable' } });
    if (path.endsWith('/auth/me')) {
      expect(route.request().headers().authorization).toBe('Bearer unverified-kiosk-token');
      return route.fulfill({ json: { id: 1, username: 'kiosk', permissions: ['library:read'], groups: [] } });
    }
    await route.fulfill({ json: [] });
  });
  await page.goto('/files?token=unverified-kiosk-token');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('saved-session');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  available = true;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'File Manager', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe('unverified-kiosk-token');
});

for (const accepted of [false, true]) {
test(`a ${accepted ? 'valid' : 'rejected'} kiosk token ${accepted ? 'replaces' : 'preserves'} a remembered credential`, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('auth_token', 'saved-session'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/status')) return route.fulfill({ json: { auth_enabled: true, requires_setup: false } });
    if (path.endsWith('/auth/me')) {
      expect(route.request().headers().authorization).toBe('Bearer kiosk-token');
      return accepted
        ? route.fulfill({ json: { id: 1, username: 'kiosk', permissions: ['library:read'], groups: [] } })
        : route.fulfill({ status: 401, json: { detail: 'Invalid API key' } });
    }
    await route.fulfill({ json: [] });
  });
  await page.goto('/files?token=kiosk-token');
  if (accepted) await expect(page.getByRole('heading', { name: 'File Manager', exact: true })).toBeVisible();
  else await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBe(accepted ? 'kiosk-token' : 'saved-session');
});
}

test('successful SSO clears an earlier authentication outage', async ({ page }) => {
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/auth/status')) {
      return route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable' } });
    }
    const body = path.endsWith('/auth/advanced-auth/status') ? { advanced_auth_enabled: false, local_login_enabled: true }
      : path.endsWith('/auth/oidc/providers') ? [{ id: 1, name: 'Test SSO', is_enabled: true }]
      : path.endsWith('/auth/oidc/authorize/1') ? { auth_url: `${url.origin}/login?callback=1#oidc_token=test-exchange` }
      : path.endsWith('/auth/oidc/exchange') ? { access_token: 'new-session', user: { id: 1, username: 'testuser', permissions: ['library:read'], groups: [] } }
      : [];
    await route.fulfill({ json: body });
  });
  await page.goto('/login');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem('auth_post_login_redirect', '/files'));
  await page.getByRole('button', { name: 'Sign in with Test SSO', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/files');
  await expect(page.getByRole('heading', { name: 'File Manager', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).not.toBeVisible();
});

test('a late auth-status failure cannot overwrite a successful SSO login', async ({ page }) => {
  let releaseStatus!: () => void;
  const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
  await page.addInitScript(() => sessionStorage.setItem('auth_post_login_redirect', '/files'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/status')) {
      await statusGate;
      return route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable' } });
    }
    const body = path.endsWith('/auth/oidc/exchange')
      ? { access_token: 'new-session', user: { id: 1, username: 'testuser', permissions: ['library:read'], groups: [] } }
      : [];
    await route.fulfill({ json: body });
  });
  await page.goto('/login#oidc_token=test-exchange');
  await expect(page.getByRole('heading', { name: 'File Manager', exact: true })).toBeVisible();
  const failedStatus = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/auth/status'));
  releaseStatus();
  await failedStatus;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.getByRole('heading', { name: 'File Manager', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).not.toBeVisible();
});

test('password login replaces a pending kiosk credential after an outage', async ({ page }) => {
  let available = false;
  await page.addInitScript(() => {
    sessionStorage.setItem('auth_pending_kiosk_token', 'pending-kiosk-token');
    sessionStorage.setItem('auth_post_login_redirect', '/files');
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/status')) return available
      ? route.fulfill({ json: { auth_enabled: true, requires_setup: false } })
      : route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable' } });
    const user = { id: 1, username: 'testuser', permissions: ['library:read'], groups: [] };
    if (path.endsWith('/auth/login')) {
      available = true;
      return route.fulfill({ json: { access_token: 'password-session', user } });
    }
    const body = path.endsWith('/auth/advanced-auth/status') ? { advanced_auth_enabled: false, local_login_enabled: true }
      : path.endsWith('/auth/me') ? user : [];
    await route.fulfill({ json: body });
  });
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('testuser');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'File Manager', exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('auth_token'))).toBe('password-session');
  expect(await page.evaluate(() => sessionStorage.getItem('auth_pending_kiosk_token'))).toBeNull();
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
  await page.waitForURL((url) => url.pathname === '/');
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
