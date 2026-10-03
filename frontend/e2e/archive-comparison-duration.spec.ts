import { test as base, expect } from './test';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

const test = base.extend<object, { archiveFixture: string }>({
  archiveFixture: [async ({ launchOptions: _launchOptions }, provideFixture) => {
    const root = resolve(import.meta.dirname, '../..');
    let child;
    let host = '127.0.0.1';
    if (process.platform === 'win32') {
      host = execFileSync('wsl.exe', ['--exec', 'hostname', '-I'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
      const wslRoot = '/mnt/' + root[0].toLowerCase() + root.slice(2).replaceAll('\\', '/');
      const command = 'cd ' + "'" + wslRoot.replaceAll("'", "'\\''") + "'" + ' && exec uv run --no-project --with-requirements requirements.txt --with-requirements requirements-dev.txt python -m backend.tests._fixtures.archive_comparison';
      child = spawn('wsl.exe', ['--exec', 'env', 'ARCHIVE_COMPARISON_BIND_HOST=' + host, 'sh', '-lc', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else if (process.env.CI) {
      host = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'layercove-integration-test'], { encoding: 'utf8' }).trim();
      child = spawn('docker', ['exec', '-i', '-e', 'ARCHIVE_COMPARISON_BIND_HOST=' + host, 'layercove-integration-test', 'python', '-m', 'backend.tests._fixtures.archive_comparison'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      child = spawn('uv', ['run', '--no-project', '--with-requirements', 'requirements.txt', '--with-requirements', 'requirements-dev.txt', 'python', '-m', 'backend.tests._fixtures.archive_comparison'], { cwd: root, env: { ...process.env, ARCHIVE_COMPARISON_BIND_HOST: host }, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    let output = '';
    const ready = new Promise<number>((resolvePort, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(/ARCHIVE_COMPARISON_FIXTURE=({[^\n]+})/);
        if (match) resolvePort(JSON.parse(match[1]).port);
      });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error('Archive fixture exited ' + code + ': ' + output)));
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
  }, { scope: 'worker' }],
});

test.use({ serviceWorkers: 'block' });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });

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
    localStorage.setItem('auth_token', 'fictional-duration-token');
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const address = new URL(request.url());
    const path = address.pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fictional-token' } });
      writes.push(request.method() + ' ' + path);
      return route.fulfill({ status: 405, json: { detail: 'Read-only archive fixture' } });
    }
    if (path === '/api/v1/archives' || path === '/api/v1/archives/compare') {
      return route.fulfill({ response: await page.request.get(url + path + (path === '/api/v1/archives' ? '/' : '') + address.search) });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false };
    if (path.endsWith('/printers')) body = [{ id: 168, name: 'Fixture Voron', provider: 'moonraker', model: 'Voron 2.4', is_active: true }];
    if (path.endsWith('/archives/no3mf-warning')) body = { has_fallback: false };
    await route.fulfill({ json: body });
  });
  await page.goto('/archives');
  await expect(page.getByRole('heading', { name: 'Fixture reference', exact: true })).toBeVisible();
  return writes;
}

for (const width of [1440, 390]) {
  for (const [ident, label, duration] of [
    [1681, 'minute', '24m'], [1682, 'hours', '2h 3m'],
    [1683, 'seconds', '45s'], [1684, 'zero', '0m'],
  ] as const) {
    test(`comparison duration agrees with ${label} archive at ${width}px`, async ({ page, archiveFixture }) => {
      const writes = await installFixture(page, archiveFixture, width);
      const card = page.locator('[data-archive-id="' + ident + '"]');
      const estimate = card.locator('[title^="Estimated:"]');
      if (ident === 1684) await expect(estimate).toHaveCount(0);
      else await expect.soft(estimate).toHaveText(duration);
      const select = page.getByRole('button', { name: 'Select', exact: true });
      await select.focus();
      await page.keyboard.press('Enter');
      await card.click();
      await page.locator('[data-archive-id="1685"]').click();
      // Keyboard activation also works while the independently filed phone toolbar issue is open.
      await page.getByRole('button', { name: 'Compare (2)', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Compare Archives (2)' })).toBeVisible();
      const row = page.getByRole('row').filter({ has: page.getByText('Print Time', { exact: true }) });
      await expect(row.getByRole('cell').nth(1)).toHaveText(duration);
      await expect(row.getByRole('cell').nth(2)).toHaveText('30m');
      await expect(page.getByRole('listitem').filter({ hasText: 'Print Time:' })).toHaveText('Print Time: ' + duration + ' vs 30m');
      for (const [label, value] of [['Layer Height', '0.2mm'], ['Bed Temperature', '60°C'], ['Filament Used', '12.5g']]) {
        const field = page.getByRole('row').filter({ has: page.getByText(label, { exact: true }) });
        await expect(field.getByRole('cell').nth(1)).toHaveText(value);
      }
      const modal = page.getByRole('heading', { name: 'Compare Archives (2)' }).locator('..').locator('..');
      await modal.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Compare Archives (2)' })).toHaveCount(0);
      expect(writes).toEqual([]);
      expect((await (await page.request.get(archiveFixture + '/health')).json()).writes).toEqual([]);
    });
  }
}
