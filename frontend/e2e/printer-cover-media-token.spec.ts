import { test, expect } from './test';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

test('printer controls show the cover after the media credential arrives', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('auth_token', 'synthetic-session'));
  await page.routeWebSocket(url => url.pathname === '/api/v1/ws', socket => socket.close());

  const credential = Promise.withResolvers<void>();
  const coverTokens: Array<string | null> = [];
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/api/v1/auth/media-token') {
      await credential.promise;
      return route.fulfill({ json: { token: 'synthetic-media' } });
    }
    if (path === '/api/v1/printers/1/cover') {
      const token = url.searchParams.get('token');
      coverTokens.push(token);
      if (token !== 'synthetic-media') return route.fulfill({ status: 401 });
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYxkAAAAASUVORK5CYII=', 'base64');
      return route.fulfill({ contentType: 'image/png', body: png });
    }
    const body = path === '/api/v1/auth/status' ? { auth_enabled: true, requires_setup: false }
      : path === '/api/v1/auth/me' ? { id: 1, username: 'fixture-reader', groups: [], permissions: ['printers:read'] }
      : path === '/api/v1/auth/ws-token' ? { token: 'synthetic-ws' }
      : path === '/api/v1/settings' ? { check_updates: false }
      : path === '/api/v1/printers' ? [{
        id: 1, name: 'Fixture Voron', provider: 'moonraker', model: 'Voron', is_active: true, auto_archive: false,
        nozzle_count: 1, external_camera_enabled: false, capabilities: { ams: false, camera: false, start_print: false },
      }]
      : path === '/api/v1/printers/1/status' ? {
        connected: true, state: 'RUNNING', progress: 30, remaining_time: 50, vt_tray: [], ams: [],
        current_print: 'fixture-job', cover_url: '/api/v1/printers/1/cover',
      } : [];
    return route.fulfill({ json: body });
  });

  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open controls', exact: true }).click();
    const cover = page.locator('img[src*="/printers/1/cover"]').first();
    await expect(cover).toHaveCount(0);
    credential.resolve();
    await expect(cover).toBeVisible();
    await expect(cover).toHaveJSProperty('naturalWidth', 1);
    await cover.click();
    const enlarged = page.locator('img[src*="/printers/1/cover"]').last();
    await expect(enlarged).toHaveJSProperty('naturalWidth', 1);
    expect(coverTokens.length).toBeGreaterThan(0);
    expect(coverTokens.every(token => token === 'synthetic-media')).toBe(true);
  } finally {
    credential.resolve();
  }
});
