import { test as base, expect } from './test';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

const test = base.extend<object, { providerFixture: string }>({
  providerFixture: [async ({ launchOptions: _launchOptions }, provideFixture) => {
    const root = resolve(import.meta.dirname, '../..');
    let child;
    let host = '127.0.0.1';
    if (process.platform === 'win32') {
      host = execFileSync('wsl.exe', ['--exec', 'hostname', '-I'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
      const wslRoot = '/mnt/' + root[0].toLowerCase() + root.slice(2).replaceAll('\\', '/');
      const command = 'cd ' + "'" + wslRoot.replaceAll("'", "'\\''") + "'" + ' && exec uv run --no-project --with-requirements requirements.txt --with-requirements requirements-dev.txt python -m backend.tests._fixtures.maintenance_provider';
      child = spawn('wsl.exe', ['--exec', 'sh', '-lc', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else if (process.env.CI) {
      host = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'layercove-integration-test'], { encoding: 'utf8' }).trim();
      child = spawn('docker', ['exec', '-i', 'layercove-integration-test', 'python', '-m', 'backend.tests._fixtures.maintenance_provider'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      child = spawn('uv', ['run', '--no-project', '--with-requirements', 'requirements.txt', '--with-requirements', 'requirements-dev.txt', 'python', '-m', 'backend.tests._fixtures.maintenance_provider'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    let output = '';
    const ready = new Promise<number>((resolvePort, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(/MAINTENANCE_PROVIDER_FIXTURE=({[^\n]+})/);
        if (match) resolvePort(JSON.parse(match[1]).port);
      });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error('Maintenance fixture exited ' + code + ': ' + output)));
    });
    try {
      const port = await ready;
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
  // The port announcement alone does not prove the fixture is reachable.
  await expect.poll(async () => {
    try { return (await page.request.get(url + '/health')).ok(); }
    catch { return false; }
  }).toBe(true);
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-export-token');
    localStorage.removeItem('bambusy-stats-timeframe');
  });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const address = new URL(request.url());
    const path = address.pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fictional-token' } });
      writes.push(request.method() + ' ' + path);
      return route.fulfill({ status: 405, json: { detail: 'Read-only export fixture' } });
    }
    if (path.startsWith('/api/v1/maintenance/')) {
      const response = await page.request.get(url + path + address.search);
      return route.fulfill({ response });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: true, requires_setup: false };
    if (path.endsWith('/auth/me')) body = { id: 901, username: 'Fixture Alice', permissions: ['maintenance:read', 'printers:read'], groups: [] };
    if (path.endsWith('/users')) body = [{ id: 901, username: 'Fixture Alice' }, { id: 902, username: 'Fixture Bob' }, { id: 903, username: 'Fixture Empty' }];
    if (path.endsWith('/settings')) body = { check_updates: false };
    await route.fulfill({ json: body });
  });
  await page.goto('/maintenance');
  await expect(page.getByRole('heading', { name: 'Maintenance', exact: true })).toBeVisible();
  return writes;
}


async function expandPrinter(page: Page, name: string) {
  const card = page.getByRole('heading', { name, exact: true }).locator('..').locator('..').locator('..').locator('..');
  await card.getByRole('button', { name: 'Expand', exact: true }).click();
  return card;
}

const universal = ['Clean Nozzle/Hotend', 'Check Belt Tension', 'Clean Build Plate', 'Check PTFE Tube'];

for (const width of [1440, 390]) {
  test(`Voron has universal and operator tasks without inherited carbon rods at ${width}px`, async ({ page, providerFixture }) => {
    const writes = await installFixture(page, providerFixture, width);
    const card = await expandPrinter(page, 'Fixture Voron');
    for (const task of [...universal, 'Replace HEPA Filter']) {
      await expect(card.getByRole('heading', { name: task, exact: true })).toBeVisible();
    }
    await expect(card.getByRole('heading', { name: 'Clean Carbon Rods', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: '124 hours Total Print Time', exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });

  test(`Voron documentation keeps operator override without computed Bambu links at ${width}px`, async ({ page, providerFixture }) => {
    const writes = await installFixture(page, providerFixture, width);
    const card = await expandPrinter(page, 'Fixture Voron');
    await expect(card.locator('a[href^="https://wiki.bambulab.com/"]')).toHaveCount(0);
    const custom = card.getByRole('heading', { name: 'Replace HEPA Filter', exact: true }).locator('..').getByRole('link');
    await expect(custom).toHaveAttribute('href', 'https://example.invalid/operator-guide');
    await expect(custom).toHaveAttribute('target', '_blank');
    await expect(custom).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(card.getByRole('switch', { name: 'Enable Replace HEPA Filter, Fixture Voron', exact: true })).toHaveAttribute('aria-checked', 'false');
    expect(writes).toEqual([]);
  });

  test(`Moonraker using a Bambu model name still has no Bambu links at ${width}px`, async ({ page, providerFixture }) => {
    const writes = await installFixture(page, providerFixture, width);
    const card = await expandPrinter(page, 'Fixture Moonraker X1C');
    for (const task of universal) await expect(card.getByRole('heading', { name: task, exact: true })).toBeVisible();
    await expect(card.locator('a[href^="https://wiki.bambulab.com/"]')).toHaveCount(0);
    await expect(card.getByRole('heading', { name: 'Clean Carbon Rods', exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  test(`unknown Bambu model has no guessed rod tasks or X1 guides at ${width}px`, async ({ page, providerFixture }) => {
    const writes = await installFixture(page, providerFixture, width);
    const card = await expandPrinter(page, 'Fixture Unknown Bambu');
    await expect(card.locator('a[href^="https://wiki.bambulab.com/"]')).toHaveCount(0);
    await expect(card.getByRole('heading', { name: 'Clean Carbon Rods', exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  test(`known Bambu hardware and wiki mappings remain correct at ${width}px`, async ({ page, providerFixture }) => {
    const writes = await installFixture(page, providerFixture, width);
    for (const [name, hardware, path] of [
      ['Fixture Bambu X1C', ['Clean Carbon Rods'], '/en/general/carbon-rods-clearance'],
      ['Fixture Bambu P2S', ['Lubricate Steel Rods', 'Clean Steel Rods'], '/en/p2s/maintenance/lubricate-x-y-z-axis'],
      ['Fixture Bambu A1 Mini', ['Lubricate Linear Rails', 'Clean Linear Rails'], '/en/a1-mini/maintenance/lubricate-y-axis'],
      ['Fixture Bambu H2D', ['Lubricate Linear Rails', 'Clean Linear Rails'], '/en/h2/maintenance/x-axis-lubrication'],
    ] as const) {
      const card = await expandPrinter(page, name);
      for (const task of [...universal, ...hardware]) {
        await expect(card.getByRole('heading', { name: task, exact: true })).toBeVisible();
      }
      const link = card.getByRole('heading', { name: hardware[0], exact: true }).locator('..').getByRole('link');
      await expect(link).toHaveAttribute('href', 'https://wiki.bambulab.com' + path);
      await expect(card.getByRole('button', { name: '124 hours Total Print Time', exact: true })).toBeVisible();
    }
    expect(writes).toEqual([]);
  });
}
