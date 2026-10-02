import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function accessiblePrintersLink(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    return nodes.some((node) => !node.ignored && node.role?.value === 'link' && node.name?.value === 'Printers');
  } finally {
    await session.detach();
  }
}

async function installFixture(page: Page, width = 390, populated = false) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
        return route.fulfill({ json: { token: 'fixture-token' } });
      }
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only navigation fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false };
    if (path.endsWith('/library/stats')) body = { total_files: 0, total_folders: 0, total_size_bytes: 0 };
    if (populated && path.endsWith('/library/files')) body = [{
      id: 1, filename: 'fictional-cube.stl', file_type: 'stl', file_size: 1024,
      folder_id: null, thumbnail_path: null, print_name: null, print_count: 0,
      duplicate_count: 0, created_at: '2026-10-02T00:00:00Z', tags: [],
    }];
    if (populated && path.endsWith('/library/stats')) body = { total_files: 1, total_folders: 0, total_size_bytes: 1024 };
    if (path.endsWith('/library/trash')) body = { total: 0, items: [] };
    await route.fulfill({ json: body });
  });
  await page.goto('/files');
  await expect(page.getByRole('button', { name: 'New Folder', exact: true })).toBeVisible();
  return writes;
}

test('closed phone drawer excludes hidden links from Tab and accessibility navigation', async ({ page }) => {
  const writes = await installFixture(page);
  const opener = page.getByRole('button', { name: 'Open menu', exact: true });
  await opener.focus();
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('aside')))).toBe(false);
  await expect.poll(() => accessiblePrintersLink(page)).toBe(false);
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  expect(writes).toEqual([]);
});

test('Escape closes the open phone drawer from a main input and preserves outside focus', async ({ page }) => {
  const writes = await installFixture(page, 390, true);
  const search = page.getByPlaceholder('Search files...', { exact: true });
  await expect(search).toBeVisible();
  const opener = page.getByRole('button', { name: 'Open menu', exact: true });
  await opener.click();
  await expect(opener).toHaveAttribute('aria-expanded', 'true');
  await search.focus();
  await page.keyboard.press('Escape');
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  await expect(search).toBeFocused();
  await expect.poll(() => accessiblePrintersLink(page)).toBe(false);
  expect(writes).toEqual([]);
});

for (const close of ['Escape', 'backdrop', 'navigation'] as const) {
  test(`open phone drawer stays usable and returns focus after ${close}`, async ({ page }) => {
    const writes = await installFixture(page);
    const opener = page.getByRole('button', { name: 'Open menu', exact: true });
    await opener.click();
    await page.keyboard.press('Tab');
    const printers = page.getByRole('link', { name: 'Printers', exact: true });
    await expect(printers).toBeFocused();
    expect(await accessiblePrintersLink(page)).toBe(true);
    if (close === 'Escape') await page.keyboard.press('Escape');
    if (close === 'backdrop') {
      const drawer = await page.locator('aside').boundingBox();
      const viewport = page.viewportSize()!;
      await page.mouse.click((drawer!.x + drawer!.width + viewport.width) / 2, drawer!.height / 2);
    }
    if (close === 'navigation') {
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/$/);
    }
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => accessiblePrintersLink(page)).toBe(false);
    expect(writes).toEqual([]);
  });
}

test('desktop sidebar remains keyboard accessible', async ({ page }) => {
  const writes = await installFixture(page, 1280);
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toHaveCount(0);
  const printers = page.getByRole('link', { name: 'Printers', exact: true });
  await expect(printers).toBeVisible();
  await printers.focus();
  await expect(printers).toBeFocused();
  expect(await accessiblePrintersLink(page)).toBe(true);
  expect(writes).toEqual([]);
});

test('resize restores focus from hidden navigation and preserves outside focus', async ({ page }) => {
  const writes = await installFixture(page, 1280);
  const printers = page.getByRole('link', { name: 'Printers', exact: true });
  await printers.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  const opener = page.getByRole('button', { name: 'Open menu', exact: true });
  await expect(opener).toBeFocused();
  await expect.poll(() => accessiblePrintersLink(page)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 844 });
  const outside = page.getByRole('button', { name: 'New Folder', exact: true });
  await outside.focus();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(outside).toBeFocused();
  await expect(opener).not.toBeFocused();
  await opener.click();
  await expect(printers).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(printers).toBeVisible();
  await printers.focus();
  await expect(printers).toBeFocused();
  expect(writes).toEqual([]);
});
