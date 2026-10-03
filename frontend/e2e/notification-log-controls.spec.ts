import { test as base, expect } from './test';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

const test = base.extend<{ notificationFixture: string; emptyLogs: boolean }>({
  emptyLogs: [false, { option: true }],
  notificationFixture: async ({ emptyLogs, launchOptions: _launchOptions }, provideFixture) => {
    const root = resolve(import.meta.dirname, '../..');
    let child;
    let host = '127.0.0.1';
    if (process.platform === 'win32') {
      host = execFileSync('wsl.exe', ['--exec', 'hostname', '-I'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
      const wslRoot = '/mnt/' + root[0].toLowerCase() + root.slice(2).replaceAll('\\', '/');
      const command = 'cd ' + "'" + wslRoot.replaceAll("'", "'\\''") + "'" + ' && exec uv run --no-project --with-requirements requirements.txt --with-requirements requirements-dev.txt python -m backend.tests._fixtures.notification_logs';
      child = spawn('wsl.exe', ['--exec', 'env', 'NOTIFICATION_LOG_BIND_HOST=' + host, 'NOTIFICATION_LOG_FIXTURE_EMPTY=' + (emptyLogs ? '1' : '0'), 'sh', '-lc', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else if (process.env.CI) {
      host = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'layercove-integration-test'], { encoding: 'utf8' }).trim();
      child = spawn('docker', ['exec', '-i', '-e', 'NOTIFICATION_LOG_BIND_HOST=' + host, '-e', 'NOTIFICATION_LOG_FIXTURE_EMPTY=' + (emptyLogs ? '1' : '0'), 'layercove-integration-test', 'python', '-m', 'backend.tests._fixtures.notification_logs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      child = spawn('uv', ['run', '--no-project', '--with-requirements', 'requirements.txt', '--with-requirements', 'requirements-dev.txt', 'python', '-m', 'backend.tests._fixtures.notification_logs'], { cwd: root, env: { ...process.env, NOTIFICATION_LOG_BIND_HOST: host, NOTIFICATION_LOG_FIXTURE_EMPTY: emptyLogs ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    let output = '';
    const ready = new Promise<number>((resolvePort, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(/NOTIFICATION_LOG_FIXTURE=({[^\n]+})/);
        if (match) resolvePort(JSON.parse(match[1]).port);
      });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error('Notification fixture exited ' + code + ': ' + output)));
    });
    try {
      const port = await ready;
      const health = await fetch('http://' + host + ':' + port + '/health');
      expect((await health.json()).bind_host).toBe(host);
      await provideFixture('http://' + host + ':' + port);
    } finally {
      const exited = new Promise<void>((done) => {
        if (child.exitCode !== null) done();
        else child.once('exit', () => done());
      });
      child.stdin.end('shutdown\n');
      await exited;
    }
  },
});

test.use({ serviceWorkers: 'block' });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

const names = ['Recent', 'Six-day failed', 'Twenty-day', 'Forty-day failed', 'Eighty-day'];
const confirmationText = 'This will permanently delete all notification logs older than 30 days. This action cannot be undone.';

async function state(page: Page, url: string) {
  return (await (await page.request.get(url + '/health')).json());
}

async function installFixture(page: Page, url: string, width: number) {
  const writes: string[] = [];
  await expect.poll(async () => {
    try { return (await page.request.get(url + '/health')).ok(); }
    catch { return false; }
  }).toBe(true);
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth_token', 'fictional-notification-token');
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const address = new URL(request.url());
    const path = address.pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fictional-token' } });
      writes.push(request.method() + ' ' + path);
      if (request.method() === 'DELETE' && path === '/api/v1/notifications/logs') return route.fulfill({ response: await page.request.delete(url + path + address.search) });
      return route.fulfill({ status: 405, json: { detail: 'Fictional cleanup only' } });
    }
    if (path === '/api/v1/notifications/logs' || path === '/api/v1/notifications/logs/stats') return route.fulfill({ response: await page.request.get(url + path + address.search) });
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false };
    await route.fulfill({ json: body });
  });
  await page.goto('/settings?tab=notifications');
  await page.getByRole('button', { name: 'Log', exact: true }).click();
  const panel = page.getByRole('heading', { name: 'Notification Log', exact: true }).locator('..').locator('..').locator('..');
  await expect(panel.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  return { panel, writes };
}

async function checkRows(page: Page, visible: readonly string[]) {
  for (const name of names) {
    if (visible.includes(name)) await expect(page.getByText(name, { exact: true })).toBeVisible();
    else await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  }
}

async function openCleanup(page: Page) {
  // Native keyboard activation isolates confirmation from the separately tested pre-fix clipping.
  await page.getByRole('button', { name: 'Clear Old', exact: true }).focus();
  await page.keyboard.press('Enter');
  return page.getByRole('dialog', { name: 'Clear Notification Logs', exact: true });
}

for (const width of [1440, 390]) {
  test(`selected notification period summary remains truthful at ${width}px`, async ({ page, notificationFixture }) => {
    const { panel, writes } = await installFixture(page, notificationFixture, width);
    for (const [days, count, rows] of [[7, 2, names.slice(0, 2)], [30, 3, names.slice(0, 3)], [90, 5, names]] as const) {
      await panel.getByRole('combobox').selectOption(String(days));
      await expect(panel.getByText('Last ' + days + ' days: ' + count + ' notifications', { exact: true })).toBeVisible();
      await checkRows(page, rows);
    }
    await panel.getByRole('combobox').selectOption('1');
    await expect(panel.getByText('Last 24 hours 1 notifications', { exact: true })).toBeVisible();
    await checkRows(page, ['Recent']);
    expect(writes).toEqual([]);
  });

  test(`cleanup requires confirmation, cancel and Escape preserve real rows at ${width}px`, async ({ page, notificationFixture }) => {
    const { panel, writes } = await installFixture(page, notificationFixture, width);
    const confirm = await openCleanup(page);
    await expect.soft(confirm).toBeVisible();
    expect((await state(page, notificationFixture)).record_ids).toEqual([1, 2, 3, 4, 5]);
    expect(writes).toEqual([]);
    await expect(confirm.getByText(confirmationText, { exact: true })).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await openCleanup(page);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    expect((await state(page, notificationFixture)).record_ids).toEqual([1, 2, 3, 4, 5]);
    expect(writes).toEqual([]);
    await panel.getByLabel('Failed only', { exact: true }).check();
    await checkRows(page, ['Six-day failed']);
    await openCleanup(page);
    const cleanup = page.waitForResponse(response => response.request().method() === 'DELETE');
    await confirm.getByRole('button', { name: 'Clear Logs', exact: true }).click();
    expect((await cleanup).ok()).toBe(true);
    await expect(confirm).toHaveCount(0);
    expect((await state(page, notificationFixture)).record_ids).toEqual([1, 2, 3]);
    await expect(panel.getByRole('combobox')).toHaveValue('7');
    await expect(panel.getByLabel('Failed only', { exact: true })).toBeChecked();
    await panel.getByRole('combobox').selectOption('90');
    await panel.getByLabel('Failed only', { exact: true }).uncheck();
    await checkRows(page, names.slice(0, 3));
    await expect(panel.getByText('Last 90 days: 3 notifications', { exact: true })).toBeVisible();
    expect((await state(page, notificationFixture)).writes).toEqual([
      { method: 'DELETE', path: '/api/v1/notifications/logs', query: 'older_than_days=30', allowed: true },
    ]);
  });

  test(`failed fictional cleanup stays retryable without losing rows at ${width}px`, async ({ page, notificationFixture }) => {
    await installFixture(page, notificationFixture, width);
    let fail = true;
    await page.route('**/api/v1/notifications/logs?older_than_days=*', async route => {
      if (route.request().method() === 'DELETE' && fail) {
        fail = false;
        return route.fulfill({ status: 503, json: { detail: 'Fictional cleanup unavailable' } });
      }
      return route.fallback();
    });
    const confirm = await openCleanup(page);
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Clear Logs', exact: true }).click();
    await expect(page.getByText('Failed to clear logs: Fictional cleanup unavailable', { exact: true })).toBeVisible();
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Clear Logs', exact: true })).toBeEnabled();
    expect((await state(page, notificationFixture)).record_ids).toEqual([1, 2, 3, 4, 5]);
    await confirm.getByRole('button', { name: 'Clear Logs', exact: true }).click();
    await expect(confirm).toHaveCount(0);
    expect((await state(page, notificationFixture)).record_ids).toEqual([1, 2, 3]);
  });

  for (const emptyLogs of [false, true]) {
    test.describe(`toolbar ${emptyLogs ? 'empty' : 'populated'} at ${width}px`, () => {
      test.use({ emptyLogs });
      test('all notification filters and actions fit and keep their results', async ({ page, notificationFixture }) => {
        const { panel, writes } = await installFixture(page, notificationFixture, width);
        const controls = [panel.getByRole('combobox'), panel.getByLabel('Failed only', { exact: true }).locator('..'),
          panel.getByRole('button', { name: 'Refresh', exact: true }), panel.getByRole('button', { name: 'Clear Old', exact: true })];
        const bounds = (await panel.boundingBox())!;
        const rectangles = [];
        for (const control of controls) {
          const rect = (await control.boundingBox())!;
          rectangles.push(rect);
          expect.soft(rect.x).toBeGreaterThanOrEqual(bounds.x);
          expect.soft(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          expect.soft(rect.x + rect.width).toBeLessThanOrEqual(width);
        }
        for (let i = 0; i < rectangles.length; i++) {
          for (let j = i + 1; j < rectangles.length; j++) {
            const a = rectangles[i], b = rectangles[j];
            expect.soft(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
          }
        }
        if (width === 1440) expect(new Set(rectangles.map(rect => Math.round(rect.y + rect.height / 2))).size).toBe(1);
        for (const control of [controls[0], controls[2], controls[3]]) await control.click({ trial: true });
        await panel.getByRole('combobox').selectOption('90');
        await panel.getByLabel('Failed only', { exact: true }).check();
        if (emptyLogs) await expect(panel.getByText('No failed notifications', { exact: true })).toBeVisible();
        else await checkRows(page, ['Six-day failed', 'Forty-day failed']);
        await panel.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(panel.getByRole('combobox')).toHaveValue('90');
        await expect(panel.getByLabel('Failed only', { exact: true })).toBeChecked();
        expect(writes).toEqual([]);
      });
    });
  }
}
