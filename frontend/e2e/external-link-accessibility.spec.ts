import type { Page } from '@playwright/test';
import type { AppSettings, StorageUsageResponse } from '../src/api/client';
import { expect, test } from './test';

test.use({ serviceWorkers: 'block' });

const settingsFixture: Pick<AppSettings, 'currency'> = { currency: 'USD' };
const storageUsageFixture: StorageUsageResponse = {
  roots: [],
  total_bytes: 0,
  total_formatted: '0 B',
  categories: [],
  other_breakdown: [],
  scan_errors: 0,
  generated_at: '2026-10-03T00:00:00Z',
  cache: { hit: false, age_seconds: 0, max_age_seconds: 0 },
};

async function openExternalLinkForm(page: Page, width: number) {
  const blockedExternalLinkWrites: string[] = [];
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.routeWebSocket('**', (webSocket) => webSocket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      if (path.includes('/external-links')) {
        blockedExternalLinkWrites.push(`${request.method()} ${path}`);
      }
      return route.fulfill({ status: 405, json: { detail: 'Read-only external link fixture' } });
    }

    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/auth/me')) body = { id: 901, username: 'Fixture Alice', permissions: [], groups: [] };
    if (path.endsWith('/settings')) body = settingsFixture;
    if (path.endsWith('/storage-usage')) body = storageUsageFixture;
    if (path.endsWith('/external-links')) body = [];
    await route.fulfill({ json: body });
  });

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Add Link', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Add External Link', exact: true })).toBeVisible();
  const form = page.locator('form').filter({ has: page.getByPlaceholder('My Link') });
  return { form, blockedExternalLinkWrites };
}

for (const width of [1440, 390]) {
  test(`Add External Link captions name their inputs and keep local form behavior at ${width}px`, async ({ page }) => {
    const { form, blockedExternalLinkWrites } = await openExternalLinkForm(page, width);
    const name = form.getByLabel('Name *', { exact: true });
    const url = form.getByLabel('URL *', { exact: true });
    await expect(name).toBeVisible();
    await expect(url).toBeVisible();
    await form.getByText('Name *', { exact: true }).click();
    await expect(name).toBeFocused();
    await form.getByText('URL *', { exact: true }).click();
    await expect(url).toBeFocused();

    await name.fill('Fixture Link');
    await url.fill('example.invalid');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByText('URL must start with http:// or https://', { exact: true })).toBeVisible();
    expect(blockedExternalLinkWrites).toEqual([]);
  });

  test(`Open in new tab is a named switch with working checked state at ${width}px`, async ({ page }) => {
    const { form, blockedExternalLinkWrites } = await openExternalLinkForm(page, width);
    const toggle = form.getByRole('switch', { name: 'Open in new tab', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(blockedExternalLinkWrites).toEqual([]);
  });

  test(`External Link close icon has a persistent accessible name at ${width}px`, async ({ page }) => {
    const { blockedExternalLinkWrites } = await openExternalLinkForm(page, width);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Add External Link', exact: true })).toHaveCount(0);
    expect(blockedExternalLinkWrites).toEqual([]);
  });
}
