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
  model_pictures: [
    { name: 'Fictional gallery one.png', path: 'fictional/one.png', url: `${appOrigin}/api/v1/archives/33/project-page-image/one` },
    { name: 'Fictional gallery two.png', path: 'fictional/two.png', url: `${appOrigin}/api/v1/archives/33/project-page-image/two` },
  ],
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

    if (path === '/api/v1/archives/33/project-page-image/one' || path === '/api/v1/archives/33/project-page-image/two') {
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#336699"/></svg>',
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

async function openGallery(page: Page) {
  const card = page.locator('[data-archive-id="33"]');
  await card.getByRole('button', { name: 'Right-click for more options', exact: true }).click();
  await card.getByRole('button', { name: 'Project Page', exact: true }).click();
  const panel = page.getByRole('dialog', { name: /^Project Page/ });
  await expect(panel).toBeVisible();
  const galleryButton = panel.getByRole('button', { name: 'Fictional gallery one.png', exact: true });
  await expect(galleryButton).toBeVisible();
  await galleryButton.focus();
  await page.keyboard.press('Enter');
  const counter = page.getByText('1 / 2', { exact: true });
  await expect(counter).toBeVisible();
  const lightbox = page.getByText(/^[12] \/ 2$/, { exact: true }).locator('..');
  await expect(lightbox.getByRole('img', { name: 'Fictional gallery one.png', exact: true })).toBeVisible();
  await expect(lightbox.getByRole('button')).toHaveCount(3);
  return { panel, galleryButton, lightbox };
}

for (const [width, height] of [[390, 844], [1440, 1000]] as const) {
  test(`Project Page gallery moves focus into the open image lightbox at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await withArchives(page, true, async () => {
      const { lightbox } = await openGallery(page);
      await expect.poll(() => lightbox.evaluate((element) =>
        element.contains(document.activeElement),
      )).toBe(true);
      await testInfo.attach(`project-lightbox-focus-${width}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await page.keyboard.press('Escape');
    });
  });

  test(`Project Page lightbox contains forward and backward Tab at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await withArchives(page, true, async () => {
      const { lightbox } = await openGallery(page);
      const controls = lightbox.getByRole('button');
      const next = controls.nth(1);
      const close = controls.last();
      await expect(controls.first()).toBeDisabled();
      await expect(next).toBeEnabled();
      await close.focus();
      await page.keyboard.press('Tab');
      await expect(next).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(close).toBeFocused();
      await page.keyboard.press('Escape');
    });
  });

  test(`Project Page lightbox preserves native keyboard image navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await withArchives(page, true, async () => {
      const { lightbox } = await openGallery(page);
      const controls = lightbox.getByRole('button');
      await controls.nth(1).focus();
      await page.keyboard.press('Enter');
      await expect(lightbox.getByRole('img', { name: 'Fictional gallery two.png', exact: true })).toBeVisible();
      await expect(lightbox.getByText('2 / 2', { exact: true })).toBeVisible();
      await expect(controls.nth(1)).toBeDisabled();
      await controls.first().focus();
      await page.keyboard.press('Enter');
      await expect(lightbox.getByRole('img', { name: 'Fictional gallery one.png', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    });
  });

  for (const dismissal of ['Close', 'Escape'] as const) {
    test(`Project Page lightbox ${dismissal} restores its gallery opener at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await withArchives(page, true, async () => {
        const { panel, galleryButton, lightbox } = await openGallery(page);
        if (dismissal === 'Close') {
          await lightbox.getByRole('button').last().focus();
          await page.keyboard.press('Enter');
        } else {
          await lightbox.getByRole('button').nth(1).focus();
          await page.keyboard.press('Escape');
        }
        await expect(page.getByText('1 / 2', { exact: true })).toHaveCount(0);
        await expect(panel).toBeVisible();
        await expect(galleryButton).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
      });
    });
  }
}
