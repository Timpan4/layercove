import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const colors = [
  ['#ef4444', 'Red'], ['#f97316', 'Orange'], ['#eab308', 'Yellow'],
  ['#22c55e', 'Green'], ['#06b6d4', 'Cyan'], ['#3b82f6', 'Blue'],
  ['#8b5cf6', 'Blue'], ['#ec4899', 'Pink'], ['#6b7280', 'Gray'],
];

const projects = ['Fixture Gears', 'Fixture Bracket'].map((name, index) => ({
  id: 801 + index, name, description: 'Fictional project for accessible controls',
  color: index === 0 ? '#3b82f6' : '#ec4899', status: 'active', priority: 'normal',
  target_count: null, target_parts_count: null, budget: null, tags: null, due_date: null,
  notes: null, parent_id: null, parent_name: null, children: [], attachments: [],
  archive_count: 0, total_items: 0, completed_count: 0, failed_count: 0, queue_count: 0,
  progress_percent: null, archives: [], url: null, cover_image_filename: null,
  is_template: false, template_source_id: null,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
}));

async function openFixture(page: Page, width: number, path = '/projects') {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript(() => localStorage.setItem('auth_token', 'fictional-project-token'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(pathname)) {
        return route.fulfill({ json: { token: 'fictional-token' } });
      }
      writes.push(`${request.method()} ${pathname}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only project fixture' } });
    }
    let body: unknown = [];
    if (pathname.endsWith('/auth/status')) body = { auth_enabled: true, requires_setup: false };
    if (pathname.endsWith('/auth/me')) body = {
      id: 901, username: 'Fixture Alice', groups: [],
      permissions: ['projects:read', 'projects:create', 'projects:update', 'projects:delete'],
    };
    if (pathname.endsWith('/settings')) body = { check_updates: false, currency: 'USD' };
    if (pathname.endsWith('/inventory/colors/map')) body = { colors: {} };
    if (pathname.endsWith('/projects')) body = projects;
    if (/\/projects\/(801|802)$/.test(pathname)) body = projects.find((project) => pathname.endsWith(`/${project.id}`));
    await route.fulfill({ json: body });
  });
  await page.goto(path);
  await expect(page.getByRole('heading', { name: path === '/projects' ? 'Projects' : 'Fixture Gears', exact: true })).toBeVisible();
  return writes;
}

async function openDetailEdit(page: Page) {
  await page.locator('main').getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Edit Project', exact: true })).toBeVisible();
  return page.locator('form');
}

for (const width of [1440, 390]) {
  test(`project menus announce their project and open its edit form at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width);
    for (const project of projects) {
      const actions = page.getByRole('button', { name: `Actions ${project.name}`, exact: true });
      await expect(actions).toBeVisible();
      await actions.focus();
      await actions.press('Enter');
      await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Edit Project', exact: true })).toBeVisible();
      await expect(page.getByPlaceholder('e.g., Voron 2.4 Build')).toHaveValue(project.name);
      await expect(page).toHaveURL(/\/projects$/);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Edit Project', exact: true })).toHaveCount(0);
    }
    expect(writes).toEqual([]);
  });

  test(`detail Back announces and navigates to Projects at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width, '/projects/801');
    const back = page.getByRole('button', { name: 'Back to Projects', exact: true });
    await expect(back).toBeVisible();
    await back.click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fixture Gears', exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });

  test(`all nine project colors have distinct names and remain selectable at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width, '/projects/801');
    const form = await openDetailEdit(page);
    const palette = form.getByText('Color', { exact: true }).locator('..');
    await expect(palette.getByRole('button')).toHaveCount(9);
    await expect(palette).toMatchAriaSnapshot(
      colors.map(([hex, name]) => `- ${JSON.stringify(`button "Color ${name} ${hex}"${hex === '#3b82f6' ? ' [pressed]' : ''}`)}`).join('\n'),
    );
    for (const [hex, name] of colors) {
      const color = form.getByRole('button', { name: `Color ${name} ${hex}`, exact: true });
      await color.click();
      await expect(color).toHaveAttribute('aria-pressed', 'true');
      await expect(palette.getByRole('button', { pressed: true })).toHaveCount(1);
    }
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openDetailEdit(page);
    await expect(page.getByRole('button', { name: 'Color Blue #3b82f6', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(writes).toEqual([]);
  });

  test(`project palette exposes its current selection at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width, '/projects/801');
    const form = await openDetailEdit(page);
    const palette = form.getByText('Color', { exact: true }).locator('..').getByRole('button');
    await expect(palette).toHaveCount(9);
    await expect(palette.nth(5)).toHaveAttribute('aria-pressed', 'true');
    for (const index of [0, 1, 2, 3, 4, 6, 7, 8]) {
      await expect(palette.nth(index)).toHaveAttribute('aria-pressed', 'false');
    }
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(writes).toEqual([]);
  });
}
