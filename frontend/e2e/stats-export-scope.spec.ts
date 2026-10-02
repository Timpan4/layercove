import { test as base, expect } from './test';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import type { Page } from '@playwright/test';

const test = base.extend<object, { exportFixture: string }>({
  exportFixture: [async ({ launchOptions: _launchOptions }, provideFixture) => {
    const root = resolve(import.meta.dirname, '../..');
    let child;
    let host = '127.0.0.1';
    if (process.platform === 'win32') {
      host = execFileSync('wsl.exe', ['--exec', 'hostname', '-I'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
      const wslRoot = '/mnt/' + root[0].toLowerCase() + root.slice(2).replaceAll('\\', '/');
      const command = 'cd ' + "'" + wslRoot.replaceAll("'", "'\\''") + "'" + ' && exec uv run --no-project --with-requirements requirements.txt --with-requirements requirements-dev.txt python -m backend.tests._fixtures.stats_exports';
      child = spawn('wsl.exe', ['--exec', 'sh', '-lc', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else if (process.env.CI) {
      host = execFileSync('docker', ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'layercove-integration-test'], { encoding: 'utf8' }).trim();
      child = spawn('docker', ['exec', '-i', 'layercove-integration-test', 'python', '-m', 'backend.tests._fixtures.stats_exports'], { stdio: ['pipe', 'pipe', 'pipe'] });
    } else {
      child = spawn('uv', ['run', '--no-project', '--with-requirements', 'requirements.txt', '--with-requirements', 'requirements-dev.txt', 'python', '-m', 'backend.tests._fixtures.stats_exports'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    let output = '';
    const ready = new Promise<number>((resolvePort, reject) => {
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = output.match(/STATS_EXPORT_FIXTURE=({[^\n]+})/);
        if (match) resolvePort(JSON.parse(match[1]).port);
      });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error('Statistics fixture exited ' + code + ': ' + output)));
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
    if (['/api/v1/archives/stats/export', '/api/v1/archives/stats', '/api/v1/archives/analysis/failures'].includes(path)) {
      const response = await page.request.get(url + path + address.search);
      return route.fulfill({ response });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: true, requires_setup: false };
    if (path.endsWith('/auth/me')) body = { id: 901, username: 'Fixture Alice', permissions: ['stats:read', 'stats:filter_by_user', 'archives:read_all'], groups: [] };
    if (path.endsWith('/users')) body = [{ id: 901, username: 'Fixture Alice' }, { id: 902, username: 'Fixture Bob' }, { id: 903, username: 'Fixture Empty' }];
    if (path.endsWith('/settings')) body = { check_updates: false };
    await route.fulfill({ json: body });
  });
  await page.goto('/stats');
  await expect(page.getByRole('heading', { name: 'Statistics', exact: true })).toBeVisible();
  return writes;
}

for (const width of [1440, 390]) {
  for (const scope of ['all-time', 'all-time-user', 'historical-user', 'empty-all-time-user']) {
    test(`Failure Analysis respects ${scope} at ${width}px`, async ({ page, exportFixture }, testInfo) => {
      const writes = await installFixture(page, exportFixture, width);
      const user = scope === 'empty-all-time-user' ? 'Fixture Empty' : 'Fixture Alice';
      if (scope !== 'all-time') {
        await page.getByRole('button', { name: 'All Users', exact: true }).click();
        await page.getByRole('button', { name: user, exact: true }).click();
        await expect(page.getByRole('button', { name: user, exact: true })).toBeVisible();
      }
      if (scope === 'historical-user') {
        await page.getByRole('button', { name: 'All Time', exact: true }).click();
        await page.getByRole('button', { name: 'Custom Range', exact: true }).click();
        await page.locator('input[type=date]').nth(0).fill('2020-01-05');
        await page.locator('input[type=date]').nth(1).fill('2020-01-12');
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Custom Range', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Custom Range', exact: true }).click();
        await expect(page.locator('input[type=date]').nth(0)).toHaveValue('2020-01-05');
        await expect(page.locator('input[type=date]').nth(1)).toHaveValue('2020-01-12');
        await page.getByRole('button', { name: 'Apply', exact: true }).click();
      } else {
        await expect(page.getByRole('button', { name: 'All Time', exact: true })).toBeVisible();
      }
      const card = page.getByRole('heading', { name: 'Failure Analysis', exact: true }).locator('..').locator('..').locator('..');
      if (scope === 'empty-all-time-user') {
        await expect(card.getByText('No print data available', { exact: true })).toBeVisible();
        await expect(card.getByText('No print data in the last 30 days', { exact: true })).toHaveCount(0);
      } else {
        const total = scope === 'all-time' ? 5 : scope === 'all-time-user' ? 3 : 2;
        const failed = scope === 'all-time' ? 3 : 1;
        const rate = scope === 'all-time' ? '60.0' : scope === 'all-time-user' ? '33.3' : '50.0';
        await expect(card.getByText(`Failed: ${failed} / ${total} completed or failed prints`, { exact: true })).toBeVisible();
        await expect(card.getByText(`${rate}%`, { exact: true })).toBeVisible();
        await expect(card.getByText('Cancelled, stopped and skipped prints are excluded.', { exact: true })).toBeVisible();
      }
      await card.scrollIntoViewIfNeeded();
      await testInfo.attach('failure-analysis-period', { body: await card.screenshot(), contentType: 'image/png' });
      expect(writes).toEqual([]);
    });
  }
}

async function artifactRows(page: Page, bytes: Buffer, format: string): Promise<string[][]> {
  if (format === 'csv') return bytes.toString('utf8').trim().split(/\r?\n/).map((line) => line.split(','));
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  return page.evaluate((xml) => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.from(doc.querySelectorAll('sheetData row'), (row) =>
      Array.from(row.querySelectorAll('c'), (cell) => cell.querySelector('t, v')?.textContent || ''));
  }, xml);
}

for (const width of [1280, 390]) {
  for (const format of ['csv', 'xlsx']) {
    for (const scope of ['today', 'all-time', 'historical-user', 'last-30-user']) {
      test(`Statistics ${format} download respects ${scope} at ${width}px`, async ({ page, exportFixture }, testInfo) => {
        const writes = await installFixture(page, exportFixture, width);
        let total = 0;
        if (scope === 'today') {
          await page.getByRole('button', { name: 'All Time', exact: true }).click();
          await page.getByRole('button', { name: 'Today', exact: true }).click();
        } else if (scope === 'all-time') {
          total = 5;
        } else {
          await page.getByRole('button', { name: 'All Users', exact: true }).click();
          await page.getByRole('button', { name: 'Fixture Alice', exact: true }).click();
          await page.getByRole('button', { name: 'All Time', exact: true }).click();
          if (scope === 'historical-user') {
            total = 2;
            await page.getByRole('button', { name: 'Custom Range', exact: true }).click();
            await page.locator('input[type=date]').nth(0).fill('2020-01-05');
            await page.locator('input[type=date]').nth(1).fill('2020-01-12');
            await page.getByRole('button', { name: 'Apply', exact: true }).click();
          } else {
            total = 1;
            await page.getByRole('button', { name: 'Last 30 Days', exact: true }).click();
          }
        }
        await page.getByRole('button', { name: 'Export Stats', exact: true }).click();
        const pendingDownload = page.waitForEvent('download');
        await page.getByRole('button', { name: format === 'csv' ? 'Export as CSV' : 'Export as Excel', exact: true }).click();
        const download = await pendingDownload;
        await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
        const stream = await download.createReadStream();
        const chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
        const rows = await artifactRows(page, Buffer.concat(chunks), format);
        const metrics = Object.fromEntries(rows.filter((row) => row.length > 1));
        expect(Number(metrics['Total Prints'])).toBe(total);
        if (scope === 'all-time') expect(metrics.Period).toBe('All time');
        else {
          expect(metrics['Start date']).toBeTruthy();
          expect(metrics['End date']).toBeTruthy();
          if (scope === 'historical-user') {
            expect(metrics['Start date']).toBe('2020-01-05');
            expect(metrics['End date']).toBe('2020-01-12');
            const weeks = rows.slice(rows.findIndex((row) => row[0] === 'Week') + 1);
            expect(weeks.reduce((sum, row) => sum + Number(row[1] || 0), 0)).toBe(2);
          }
        }
        expect(writes).toEqual([]);
      });
    }
  }
}
