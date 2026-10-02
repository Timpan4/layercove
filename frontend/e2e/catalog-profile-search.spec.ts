import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
const target = 'Voron 2.4 300 0.4 nozzle - my';
const profile = (id: number, display_name: string) => ({
  profile_id: id, revision_id: id + 100, latest_revision_id: id + 100, active_revision_id: id + 100,
  active: true, review_state: 'approved', source: 'standard', account_id: 1, account_name: 'Fictional shared catalog',
  remote_profile_id: `profile-${id}`, profile_type: 'printer', display_name, content_hash: `hash-${id}`,
  compatibility_metadata: {}, tombstoned: false, stale: false, sharing_state: 'shared',
});
const profiles = [...Array.from({ length: 50 }, (_, index) => profile(index + 1, `Alpha profile ${String(index + 1).padStart(2, '0')}`)), profile(51, target)];

async function installFixture(page: Page) {
  const writes: string[] = [];
  const revisions: number[] = [];
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fixture-token' } });
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only catalog search fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false };
    if (path.endsWith('/slicer/catalog/profiles')) {
      const query = (url.searchParams.get('search') ?? '').trim().toLowerCase();
      const visible = profiles.filter((item) => item.display_name.toLowerCase().includes(query));
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? visible.length);
      body = visible.slice(offset, offset + limit);
    }
    const revisionMatch = path.match(/\/profiles\/(\d+)\/revisions$/);
    if (revisionMatch) {
      const id = Number(revisionMatch[1]);
      revisions.push(id);
      body = [{ id: id + 100, content_hash: `hash-${id}`, review_state: 'approved', active: true, created_at: '2026-10-02T00:00:00Z' }];
    }
    return route.fulfill({ json: body });
  });
  return { writes, revisions };
}

for (const width of [1280, 390]) {
  test(`catalog name search reaches profiles outside the current page at ${width}px`, async ({ page }) => {
    const fixture = await installFixture(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/profiles');
    await page.getByRole('button', { name: 'Shared catalog', exact: true }).click();
    const catalog = page.getByLabel('Shared Profiles catalog administration', { exact: true });
    await expect(catalog.getByRole('article', { name: 'Alpha profile 01', exact: true })).toBeVisible();
    await catalog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(catalog.getByRole('article', { name: 'Alpha profile 26', exact: true })).toBeVisible();
    fixture.revisions.length = 0;
    const search = catalog.getByRole('searchbox', { name: 'Search catalog profiles', exact: true });
    await search.fill('  vOrOn  ');
    const row = catalog.getByRole('article', { name: target, exact: true });
    await expect(row).toBeVisible();
    await expect(row.getByText('Revision 151', { exact: true })).toBeVisible();
    await expect(catalog.getByRole('article')).toHaveCount(1);
    expect(fixture.revisions).toEqual([51]);
    await search.fill('not-a-profile');
    await expect(catalog.getByText('No catalog profiles match your search.', { exact: true })).toBeVisible();
    await expect(catalog.getByRole('article')).toHaveCount(0);
    await catalog.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(search).toHaveValue('');
    await expect(catalog.getByRole('article', { name: 'Alpha profile 01', exact: true })).toBeVisible();
    await expect(catalog.getByText('Page 1', { exact: true })).toBeVisible();
    await catalog.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(catalog.getByRole('article', { name: 'Alpha profile 26', exact: true })).toBeVisible();
    expect(fixture.writes).toEqual([]);
  });
}

