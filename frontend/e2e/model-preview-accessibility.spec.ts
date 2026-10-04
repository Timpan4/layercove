import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const filename = 'Voron_Design_Cube_v8.STL';
const cubeStl = `solid cube
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid cube`;

async function openPreview(page: import('@playwright/test').Page, width: number) {
  const blockedWrites: string[] = [];
  const nonLoopbackRequests: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-model-preview-token');
    localStorage.setItem('bambutrack_language', 'en');
    localStorage.setItem('library-view-mode', 'list');
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      nonLoopbackRequests.push(request.url());
      return route.fulfill({ status: 403, body: 'Only loopback fixtures are allowed' });
    }
    const path = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/printers/camera/stream-token', '/api/v1/auth/ws-token'].includes(path)) {
        return route.fulfill({ json: { token: 'fictional-stream-token' } });
      }
      blockedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only preview fixture' } });
    }
    if (path.endsWith('/auth/status')) return route.fulfill({ json: { auth_enabled: false, requires_setup: false } });
    if (path.endsWith('/settings')) return route.fulfill({ json: { check_updates: false, use_slicer_api: false } });
    if (path.endsWith('/slicer/capabilities')) return route.fulfill({ json: { capabilities: { process_schema: false } } });
    if (path.endsWith('/library/files')) return route.fulfill({ json: [{
      id: 42, filename, file_type: 'stl', file_size: cubeStl.length,
      folder_id: null, thumbnail_path: null, print_name: null, print_count: 0,
      duplicate_count: 0, created_at: '2026-10-01T00:00:00Z', tags: [],
    }] });
    if (path.endsWith('/library/stats')) return route.fulfill({ json: { total_files: 1, total_folders: 0, total_size_bytes: cubeStl.length } });
    if (path.endsWith('/library/trash')) return route.fulfill({ json: { total: 0, items: [] } });
    if (path.endsWith('/library/files/42/download')) return route.fulfill({
      status: 200, contentType: 'model/stl', body: cubeStl,
    });
    return route.fulfill({ status: 404, json: { detail: `No fixture for ${path}` } });
  });

  await page.goto('/files');
  const opener = page.getByTitle('3D Preview', { exact: true });
  await expect(opener).toBeVisible();
  await opener.click();
  await expect(page.locator('button:has(svg.lucide-zoom-in)')).toBeVisible();
  return { opener, blockedWrites, nonLoopbackRequests };
}

for (const width of [390, 1440]) {
  test(`STL preview actions have meaningful names at ${width}px`, async ({ page }) => {
    const { blockedWrites, nonLoopbackRequests } = await openPreview(page, width);
    for (const name of ['Close preview', 'Zoom in', 'Zoom out', 'Reset view', 'Enter fullscreen']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
    expect(blockedWrites).toEqual([]);
    expect(nonLoopbackRequests).toEqual([]);
  });

  test(`STL preview is a named modal that contains focus, closes on Escape, and restores its opener at ${width}px`, async ({ page }) => {
    const { opener, blockedWrites, nonLoopbackRequests } = await openPreview(page, width);
    const dialog = page.getByRole('dialog', { name: filename, exact: true });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    const buttons = dialog.locator('button:not([disabled])');
    const firstButton = buttons.first();
    const lastButton = buttons.last();
    await firstButton.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(lastButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(firstButton).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(blockedWrites).toEqual([]);
    expect(nonLoopbackRequests).toEqual([]);
  });
}
