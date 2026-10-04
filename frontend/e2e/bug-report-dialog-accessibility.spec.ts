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
    localStorage.setItem('auth_token', 'fictional-bug-report-dialog-token');
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
        return route.fulfill({ json: { token: 'fictional-bug-report-dialog-startup-token' } });
      }
      blockedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only bug-report fixture' } });
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

async function openBugReportWithKeyboard(page: Page) {
  await page.goto('/inventory', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Table', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Report a Bug', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  const panel = page.locator('#bug-report-modal');
  await expect(panel.getByRole('heading', { name: 'Report a Bug', exact: true })).toBeVisible();
  await expect(panel.locator('textarea')).toBeVisible();
  return { trigger, panel };
}

for (const [width, height] of [[390, 844], [1440, 900]] as const) {
  test(`Bug-report fields use their persistent captions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);
    try {
      const { panel } = await openBugReportWithKeyboard(page);
      const description = panel.locator('textarea');
      const email = panel.locator('input[type="email"]');
      await description.fill('Fictional keyboard accessibility report');
      await email.fill('fictional@example.invalid');
      await expect.soft(panel.getByLabel('Description', { exact: false })).toHaveValue('Fictional keyboard accessibility report');
      await expect.soft(description).toHaveAccessibleName(/^Description\s*\*?$/);
      await expect.soft(panel.getByLabel('Email (optional)', { exact: true })).toHaveValue('fictional@example.invalid');
      await expect.soft(email).toHaveAccessibleName('Email (optional)');
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Bug-report panel names its Close action at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);
    try {
      const { panel } = await openBugReportWithKeyboard(page);
      await expect(panel.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Bug-report panel has named modeless dialog context at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);
    try {
      await openBugReportWithKeyboard(page);
      const dialog = page.getByRole('dialog', { name: 'Report a Bug', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Opening the bug-report panel moves focus inside at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);
    try {
      const { panel } = await openBugReportWithKeyboard(page);
      await expect.poll(() => panel.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Bug-report panel preserves modeless background keyboard access at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);
    try {
      const { trigger, panel } = await openBugReportWithKeyboard(page);
      await panel.locator('button').first().focus();
      await page.keyboard.press('Shift+Tab');
      await expect(trigger).toBeFocused();
      await expect(panel).toBeVisible();
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Close dismisses the bug-report panel and restores its trigger at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);
    try {
      const { trigger, panel } = await openBugReportWithKeyboard(page);
      await panel.locator('textarea').fill('Fictional draft before Close');
      await panel.locator('button').first().focus();
      await page.keyboard.press('Enter');
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Cancel dismisses the bug-report panel and restores its trigger at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);
    try {
      const { trigger, panel } = await openBugReportWithKeyboard(page);
      await panel.locator('textarea').fill('Fictional draft before Cancel');
      const cancel = panel.getByRole('button', { name: 'Cancel', exact: true });
      await cancel.focus();
      await page.keyboard.press('Enter');
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
    } finally {
      fixture.assertReadOnly();
    }
  });

  test(`Bug-report panel retains optional email, privacy and attachment guidance at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const fixture = await installReadOnlyAppFixture(page);
    try {
      const { panel } = await openBugReportWithKeyboard(page);
      await expect(panel.getByText('Email (optional)', { exact: true })).toBeVisible();
      await expect(panel.locator('input[type="email"]')).toHaveJSProperty('required', false);
      await expect(panel.getByText('If provided, your email will be included in a collapsed section of the GitHub issue so the maintainer can follow up.', { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Upload, paste, or drag an image', exact: true })).toBeVisible();
      const disclosure = panel.locator('summary').filter({ hasText: 'What data is included in the report?' });
      await disclosure.click();
      await expect(panel.getByText('Never included:', { exact: true })).toBeVisible();
      await expect(panel.getByText('Printer names, serial numbers, access codes, passwords, IP addresses, email addresses, API keys, tokens, webhook URLs, hostnames, or usernames.', { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Start Debug Logging', exact: true })).toBeDisabled();
    } finally {
      fixture.assertReadOnly();
    }
  });
}
