import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const wsOrigin = new URL(appOrigin);
wsOrigin.protocol = wsOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
const startupTokenPaths = new Set([
  '/api/v1/auth/ws-token',
  '/api/v1/printers/camera/stream-token',
]);

const archives = [33, 34].map((id) => ({
  id,
  printer_id: 1,
  filename: `fictional-archive-${id}.gcode.3mf`,
  print_name: `Fictional archive ${id}`,
  status: 'completed',
  created_at: '2026-09-22T12:00:00Z',
  completed_at: '2026-09-22T12:30:00Z',
  file_size: 1024,
  file_path: null,
  source_3mf_path: null,
  thumbnail_path: null,
  filament_type: 'PLA',
  duplicate_count: 0,
  duplicate_sequence: 0,
  photos: [],
  created_by_id: null,
}));

const populatedProject = {
  title: 'Fictional project title',
  description: '<p>Fictional project description</p>',
  designer: 'Fictional designer',
  license: 'Fictional licence',
  profile_title: 'Fictional print profile',
  profile_description: '<p>Fictional profile description</p>',
  model_pictures: [],
  profile_pictures: [],
  thumbnails: [],
};

async function withArchives(page: Page, populated: boolean, run: () => Promise<void>) {
  const blockedWrites: string[] = [];
  const externalRequests: string[] = [];
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));

  await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('bambutrack_language', 'en');
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('archive') || key.startsWith('logFilter') || key === 'logOffset' || key === 'logPageSize') {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem('archiveViewMode', 'grid');
  });
  await page.routeWebSocket(
    (url) => url.origin === wsOrigin.origin && url.pathname.startsWith('/api/'),
    (socket) => socket.close(),
  );
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== appOrigin) {
      externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }

    const path = url.pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && startupTokenPaths.has(path)) {
        return route.fulfill({ json: { token: 'fictional-archive-modal-token' } });
      }
      blockedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only archive modal fixture' } });
    }
    if (!path.startsWith('/api/')) return route.continue();

    // Display-only fictional image. QR generation/download is outside the focus contract.
    if (path === '/api/v1/archives/33/qrcode') {
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="white"/><path d="M40 40h80v80H40zM180 40h80v80h-80zM40 180h80v80H40z" fill="black"/></svg>',
      });
    }

    let body: unknown = [];
    if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
    if (path === '/api/v1/settings') body = { language: 'en', check_updates: false, currency: 'USD' };
    if (path === '/api/v1/printers') {
      body = [{ id: 1, name: 'Fictional printer', provider: 'moonraker', model: 'Voron 2.4', is_active: true }];
    }
    if (path === '/api/v1/archives') body = archives;
    if (path === '/api/v1/archives/no-3mf-warning') body = { has_fallback: false };
    if (path === '/api/v1/archives/33/project-page') {
      body = populated ? populatedProject : { model_pictures: [], profile_pictures: [], thumbnails: [] };
    }
    if (path === '/api/v1/print-log') {
      body = {
        items: [{
          id: 2491, archive_id: 33, print_name: 'Fictional log', printer_id: 1,
          printer_name: 'Fictional printer', status: 'completed',
          started_at: '2026-09-22T12:00:00Z', created_at: '2026-09-22T12:00:00Z',
          thumbnail_path: null, duration_seconds: 1800, filament_used_grams: null,
        }],
        total: 1,
      };
    }
    return route.fulfill({ json: body });
  });

  try {
    await page.goto('/archives', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Fictional archive 33', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fictional archive 34', exact: true })).toBeVisible();
    await run();
  } finally {
    expect(blockedWrites, 'Block and detect every non-startup write').toEqual([]);
    expect(externalRequests, 'Do not contact external services').toEqual([]);
    expect(downloads, 'Never activate QR or archive downloads').toEqual([]);
  }
}

const cases = [
  { menu: 'QR Code', populated: false, marker: 'Scan to open this archive', title: /^QR Code/ },
  { menu: 'Project Page', populated: false, marker: 'No project page data found in this 3MF file.', title: /^Project Page/ },
  { menu: 'Project Page', populated: true, marker: 'Fictional project description', title: /^Project Page/ },
];

for (const [width, height] of [[390, 844], [1440, 1000]] as const) {
  for (const state of cases) {
    const name = state.menu + (state.menu === 'Project Page' ? (state.populated ? ' populated' : ' empty') : '');

    test(`Archive ${name} contains keyboard focus and restores an archive action at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await withArchives(page, state.populated, async () => {
        const card = page.locator('[data-archive-id="33"]');
        const trigger = card.getByRole('button', { name: 'Right-click for more options', exact: true });

        for (const dismissal of ['Escape', 'Close'] as const) {
          await trigger.focus();
          await page.keyboard.press('Enter');
          const action = page.getByRole('button', { name: state.menu, exact: true });
          await expect(action).toBeVisible();
          await action.focus();
          await page.keyboard.press('Enter');
          const heading = page.getByRole('heading', { name: state.title });
          const marker = page.getByText(state.marker, { exact: true });
          await expect(heading).toBeVisible();
          await expect(marker).toBeVisible();
          const panel = page.locator('div').filter({ has: heading }).filter({ has: marker }).last();

          // Prove the reported initial background-focus failure before dialog-role assertions.
          await expect.poll(() => panel.evaluate((element) =>
            element.contains(document.activeElement),
          )).toBe(true);
          const dialog = page.getByRole('dialog', { name: state.title });
          await expect(dialog).toBeVisible();
          await expect(dialog).toHaveAttribute('aria-modal', 'true');
          await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();

          const first = dialog.getByRole('button').first();
          const last = dialog.getByRole('button').last();
          await last.focus();
          await page.keyboard.press('Tab');
          await expect(first).toBeFocused();
          await page.keyboard.press('Shift+Tab');
          await expect(last).toBeFocused();
          if (state.populated) {
            await expect(dialog.getByRole('heading', { name: 'Fictional project title', exact: true })).toBeVisible();
            await expect(dialog.getByText('Fictional print profile', { exact: true })).toBeVisible();
          }
          await testInfo.attach(`archive-${name}-${dismissal}-${width}`, {
            body: await page.screenshot(), contentType: 'image/png',
          });

          if (dismissal === 'Escape') {
            await page.keyboard.press('Escape');
          } else {
            await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
            await page.keyboard.press('Enter');
          }
          await expect(dialog).toHaveCount(0);
          await expect.poll(() => card.evaluate((element) =>
            element.contains(document.activeElement) &&
            !!document.activeElement?.matches('button:not(:disabled), a[href]'),
          )).toBe(true);
        }
      });
    });

    if (!state.populated) {
      test(`Archive ${name} Close action has a usable accessible name at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await withArchives(page, state.populated, async () => {
          const card = page.locator('[data-archive-id="33"]');
          await card.getByRole('button', { name: 'Right-click for more options', exact: true }).click();
          await page.getByRole('button', { name: state.menu, exact: true }).click();
          const heading = page.getByRole('heading', { name: state.title });
          const marker = page.getByText(state.marker, { exact: true });
          await expect(heading).toBeVisible();
          await expect(marker).toBeVisible();
          // Naming is checked independently of the missing modal role/focus in issues251/252.
          const panel = page.locator('div').filter({ has: heading }).filter({ has: marker }).last();
          const close = panel.getByRole('button', { name: 'Close', exact: true });
          await expect(close).toHaveCount(1);
          await close.focus();
          await page.keyboard.press('Enter');
          await expect(heading).toHaveCount(0);
        });
      });
    }
  }

  test(`Print Log archive-period context is named when present at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await withArchives(page, false, async () => {
      await page.getByRole('button', { name: 'Print Log', exact: true }).click();
      await expect(page.getByRole('table')).toContainText('Fictional log');
      const period = page.getByRole('combobox').filter({
        has: page.getByRole('option', { name: 'All Archives', exact: true }),
      });
      // Issue253 also permits hiding this irrelevant archive filter in Print Log.
      if (await period.count()) {
        await expect(period).toHaveAccessibleName(/archive.*(?:period|collection)|(?:period|collection).*archive/i);
        await period.selectOption('this-month');
        await expect(period).toHaveValue('this-month');
        await expect(page.getByRole('table')).toContainText('Fictional log');
      }
    });
  });
}
