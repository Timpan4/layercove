import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const modelUrl = 'https://makerworld.com/en/models/1400373';
const resolvedModel = {
  model_id: 1400373, profile_id: null, already_imported_library_ids: [],
  design: { title: 'Fictional seed starter', designCreator: { name: 'Fictional designer' } },
  instances: [
    { id: 901, profileId: 991, title: 'Fictional 9-cell plate', materialCnt: 1, needAms: false, compatibility: { devProductName: 'P1S' }, otherCompatibility: [{ devProductName: 'X1C' }] },
    { id: 902, profileId: 992, title: 'Fictional 12-cell plate', materialCnt: 2, needAms: true, compatibility: { devProductName: 'A1' }, otherCompatibility: [{ devProductName: 'A1 mini' }] },
  ],
};

async function installFixture(page: Page, width: number, canDownload: boolean) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fixture-token' } });
      if (request.method() === 'POST' && path.endsWith('/makerworld/resolve')) return route.fulfill({ json: resolvedModel });
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only MakerWorld fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false, preferred_slicer: 'orcaslicer', use_slicer_api: false };
    if (path.endsWith('/makerworld/status')) body = { has_cloud_token: canDownload, can_download: canDownload };
    if (path.endsWith('/library/folders')) body = [{ id: 91, name: 'Fictional writable folder', children: [], is_external: false, external_readonly: false }, { id: 92, name: 'Fictional read-only folder', children: [], is_external: true, external_readonly: true }];
    await route.fulfill({ json: body });
  });
  await page.goto('/makerworld');
  await page.getByPlaceholder(/https:\/\/makerworld\.com/).fill(modelUrl);
  await page.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fictional seed starter', exact: true })).toBeVisible();
  return writes;
}

for (const width of [1280, 390]) {
  for (const canDownload of [false, true]) {
    test(`MakerWorld plate actions fit at ${width}px with downloads ${canDownload ? 'enabled' : 'cloud-gated'}`, async ({ page }) => {
      const writes = await installFixture(page, width, canDownload);
      for (const name of ['Fictional 9-cell plate', 'Fictional 12-cell plate']) {
        const card = page.getByText(name, { exact: true }).locator('../../..');
        const bounds = (await card.boundingBox())!;
        for (const action of ['Save', 'Save & Slice in OrcaSlicer']) {
          const button = card.getByRole('button', { name: action, exact: true });
          if (canDownload) await expect(button).toBeEnabled();
          else await expect(button).toBeDisabled();
          const actionBounds = (await button.boundingBox())!;
          expect.soft(actionBounds.x, `${name}: ${action} starts inside the card`).toBeGreaterThanOrEqual(bounds.x);
          expect.soft(actionBounds.x + actionBounds.width, `${name}: ${action} ends inside the card`).toBeLessThanOrEqual(bounds.x + bounds.width);
          expect.soft(actionBounds.x + actionBounds.width, `${name}: ${action} stays inside the viewport`).toBeLessThanOrEqual(width);
        }
        await expect(card.getByText(/Sliced for/)).toBeVisible();
        await expect(card.getByText(/Also marked compatible/)).toBeVisible();
        if (width === 1280) {
          const save = (await card.getByRole('button', { name: 'Save', exact: true }).boundingBox())!;
          const slice = (await card.getByRole('button', { name: 'Save & Slice in OrcaSlicer', exact: true }).boundingBox())!;
          expect(save.y).toBe(slice.y);
        }
      }
      const overflow = await page.locator('main').evaluate((main) => ({ scroll: main.scrollWidth, client: main.clientWidth }));
      expect(overflow.scroll, 'main content has no horizontal page overflow').toBeLessThanOrEqual(overflow.client);
      expect(writes).toEqual([]);
    });
  }

  test(`MakerWorld fields have persistent native labels at ${width}px`, async ({ page }) => {
    const writes = await installFixture(page, width, false);
    const url = page.getByLabel('MakerWorld URL', { exact: true });
    const destination = page.getByLabel('Import to file manager', { exact: true });
    expect.soft(await url.count(), 'URL input has a persistent native label').toBe(1);
    expect.soft(await destination.count(), 'destination has a native label').toBe(1);
    if (await url.count() !== 1 || await destination.count() !== 1) return;
    await expect(url).toHaveValue(modelUrl);
    await page.locator('label').filter({ hasText: /^MakerWorld URL$/ }).click();
    await expect(url).toBeFocused();
    await page.locator('label').filter({ hasText: /^Import to file manager$/ }).click();
    await expect(destination).toBeFocused();
    await expect(destination.locator('option')).toHaveText(['MakerWorld (default)', 'Fictional writable folder']);
    await destination.selectOption('91');
    await expect(destination).toHaveValue('91');
    expect(writes).toEqual([]);
  });
}
