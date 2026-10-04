import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const wsOrigin = new URL(appOrigin);
wsOrigin.protocol = wsOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
const startupTokenPaths = new Set([
  '/api/v1/auth/ws-token',
  '/api/v1/printers/camera/stream-token',
]);

async function installReadOnlyAppFixture(page: Page) {
  const blockedWrites: string[] = [];
  const externalRequests: string[] = [];

  await page.addInitScript(() => {
    localStorage.setItem('bambutrack_language', 'en');
    localStorage.setItem('auth_token', 'fictional-shortcuts-focus-token');
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

    const path = url.pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && startupTokenPaths.has(path)) {
        return route.fulfill({ json: { token: 'fictional-shortcuts-focus-startup-token' } });
      }
      blockedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only keyboard shortcuts fixture' } });
    }

    if (!path.startsWith('/api/')) return route.continue();

    let body: unknown = [];
    if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
    if (path === '/api/v1/settings') body = { language: 'en', check_updates: false, currency: 'USD' };
    if (path === '/api/v1/settings/spoolman') body = { spoolman_enabled: 'false', spoolman_url: '' };
    if (path === '/api/v1/local-presets') body = { filament: [], printer: [], process: [] };
    if (path === '/api/v1/inventory/spools') body = [];
    if (path === '/api/v1/inventory/locations') body = [];
    if (path === '/api/v1/inventory/catalog') body = [];
    return route.fulfill({ json: body });
  });

  return {
    assertReadOnly: () => {
      expect(blockedWrites, 'The fixture must block and detect every non-startup write').toEqual([]);
      expect(externalRequests, 'The fixture must not contact external origins').toEqual([]);
    },
  };
}

async function openShortcutsWithKeyboard(page: Page, width: number) {
  await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Table', exact: true })).toBeVisible();
  if (width === 390) {
    const menuButton = page.getByRole('button', { name: 'Open menu', exact: true });
    await expect(menuButton).toBeVisible();
    await menuButton.focus();
    await page.keyboard.press('Enter');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  }

  const trigger = page.getByRole('button', { name: 'Keyboard shortcuts (?)', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  return trigger;
}

function shortcutsOverlay(page: Page) {
  return page.locator('div.fixed.inset-0').filter({ has: page.getByRole('heading', { name: 'Keyboard Shortcuts', exact: true }) });
}

for (const [width, height] of [[390, 844], [1440, 900]] as const) {
  test(`Keyboard shortcuts dialog has named modal semantics at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);

    try {
      await openShortcutsWithKeyboard(page, width);
      const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Keyboard shortcuts dialog names its Close action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);

    try {
      await openShortcutsWithKeyboard(page, width);
      const overlay = shortcutsOverlay(page);
      await expect(overlay).toBeVisible();
      await expect(overlay.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Opening the keyboard shortcuts dialog moves focus inside at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);

    try {
      await openShortcutsWithKeyboard(page, width);
      const overlay = shortcutsOverlay(page);
      await expect(overlay).toBeVisible();
      await expect.poll(() => overlay.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Keyboard shortcuts dialog retains its reference content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);

    try {
      await openShortcutsWithKeyboard(page, width);
      const overlay = shortcutsOverlay(page);
      await expect(overlay.getByRole('heading', { level: 3 })).toHaveText([
        'Navigation', 'Archives', 'K-Profiles', 'General',
      ]);
      const reference = [
        ['Go to Printers', '1'],
        ['Go to Filament', '2'],
        ['Go to Archives', '3'],
        ['Go to Print Queue', '4'],
        ['Go to Projects', '5'],
        ['Go to File Manager', '6'],
        ['Go to MakerWorld', '7'],
        ['Go to Profiles', '8'],
        ['Go to Maintenance', '9'],
        ['Focus search', '/'],
        ['Open upload modal', 'U'],
        ['Clear selection / blur input', 'Esc'],
        ['Context menu on cards', 'Right-click'],
        ['Refresh profiles', 'R'],
        ['New profile', 'N'],
        ['Exit selection mode', 'Esc'],
        ['Show this help', '?'],
      ];
      for (const [description, key] of reference) {
        const row = overlay.getByText(description, { exact: true }).locator('..');
        await expect(row.locator('kbd')).toHaveText([key]);
      }
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Keyboard shortcuts dialog contains Tab in both directions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);

    try {
      await openShortcutsWithKeyboard(page, width);
      const overlay = shortcutsOverlay(page);
      const closeButton = overlay.locator('button').first();
      await expect(overlay).toBeVisible();

      await closeButton.focus();
      await page.keyboard.press('Tab');
      expect.soft(await overlay.evaluate((element) => element.contains(document.activeElement)), 'Forward Tab stays inside the shortcuts overlay').toBe(true);

      await closeButton.focus();
      await page.keyboard.press('Shift+Tab');
      expect.soft(await overlay.evaluate((element) => element.contains(document.activeElement)), 'Backward Tab stays inside the shortcuts overlay').toBe(true);
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Escape dismisses the keyboard shortcuts dialog and restores its trigger at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);

    try {
      const trigger = await openShortcutsWithKeyboard(page, width);
      const overlay = shortcutsOverlay(page);
      await expect(overlay).toBeVisible();
      await overlay.locator('button').first().focus();
      await page.keyboard.press('Escape');
      await expect(overlay).toHaveCount(0);
      await expect(trigger).toBeFocused();
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Close dismisses the keyboard shortcuts dialog and restores its trigger at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);

    try {
      const trigger = await openShortcutsWithKeyboard(page, width);
      const overlay = shortcutsOverlay(page);
      await expect(overlay).toBeVisible();
      await overlay.locator('button').first().click();
      await expect(overlay).toHaveCount(0);
      await expect(trigger).toBeFocused();
    } finally {
      fixture.assertReadOnly();
    }
  });
}
