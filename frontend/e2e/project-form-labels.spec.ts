import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const project = {
  id: 801, name: 'Fixture Gears', description: 'Fictional project for form labels',
  color: '#3b82f6', status: 'active', priority: 'normal',
  target_count: 7, target_parts_count: 12, budget: 12.5, tags: 'fixture, gears',
  due_date: '2026-12-01T00:00:00Z', url: 'https://example.invalid/fixture',
  notes: null, parent_id: null, parent_name: null, children: [], attachments: [],
  archive_count: 0, total_items: 0, completed_count: 0, failed_count: 0, queue_count: 0,
  progress_percent: null, archives: [], cover_image_filename: null,
  is_template: false, template_source_id: null,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
};

const projectFields = [
  { label: 'Name', initial: 'Fixture Gears', changed: 'Fixture Updated', kind: 'input', attributes: { required: '' } },
  { label: 'Description', initial: 'Fictional project for form labels', changed: 'Local description', kind: 'input' },
  { label: 'URL', initial: 'https://example.invalid/fixture', changed: 'https://example.invalid/updated', kind: 'input', attributes: { type: 'url', maxlength: '2048' } },
  { label: 'Target Plates', initial: '7', changed: '9', kind: 'input', attributes: { min: '1' } },
  { label: 'Target Parts', initial: '12', changed: '15', kind: 'input', attributes: { min: '1' } },
  { label: 'Tags (comma-separated)', initial: 'fixture, gears', changed: 'local, labels', kind: 'input' },
  { label: 'Due Date', initial: '2026-12-01', changed: '2026-12-02', kind: 'input', attributes: { type: 'date' } },
  { label: 'Priority', initial: 'normal', changed: 'high', kind: 'select' },
  { label: 'Budget', initial: '12.5', changed: '24.75', kind: 'input', attributes: { min: '0', step: '0.01' } },
  { label: 'Status', initial: 'active', changed: 'archived', kind: 'select' },
];

async function openFixture(page: Page, width: number) {
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
    if (pathname.endsWith('/projects')) body = [project];
    if (pathname.endsWith('/projects/801')) body = project;
    await route.fulfill({ json: body });
  });
  await page.goto('/projects/801');
  await expect(page.getByRole('heading', { name: 'Fixture Gears', exact: true })).toBeVisible();
  return writes;
}

async function openEdit(page: Page) {
  await page.locator('main').getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Edit Project', exact: true })).toBeVisible();
  return page.locator('form');
}

for (const width of [1440, 390]) {
  for (const field of projectFields) {
    test(`Edit Project ${field.label} has a persistent native label at ${width}px`, async ({ page }) => {
      const writes = await openFixture(page, width);
      const form = await openEdit(page);
      const caption = form.getByText(field.label, { exact: true });
      await expect(caption).toBeVisible();
      const input = form.getByLabel(field.label, { exact: true });
      await expect(input).toHaveValue(field.initial);
      await caption.click();
      await expect(input).toBeFocused();
      for (const [name, value] of Object.entries(field.attributes ?? {})) {
        await expect(input).toHaveAttribute(name, value);
      }
      if (field.kind === 'select') await input.selectOption(field.changed);
      else await input.fill(field.changed);
      await expect(input).toHaveValue(field.changed);
      await expect(caption).toBeVisible();
      await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(form).toHaveCount(0);
      await openEdit(page);
      await expect(page.getByLabel(field.label, { exact: true })).toHaveValue(field.initial);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(writes).toEqual([]);
    });
  }

  for (const field of [
    { label: 'Qty', initial: '1', changed: '3', attribute: 'min', attributeValue: '1' },
    { label: 'Price ($)', initial: '', changed: '4.25', attribute: 'step', attributeValue: '0.01' },
  ]) {
    test(`Add Part ${field.label} has a persistent visible native label at ${width}px`, async ({ page }) => {
      const writes = await openFixture(page, width);
      await page.getByRole('button', { name: 'Add Part', exact: true }).click();
      const form = page.locator('form');
      const caption = form.getByText(field.label, { exact: true });
      await expect.soft(caption).toBeVisible();
      const input = form.getByLabel(field.label, { exact: true });
      await expect(input).toHaveValue(field.initial);
      await caption.click();
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute(field.attribute, field.attributeValue);
      await input.fill(field.changed);
      await expect(input).toHaveValue(field.changed);
      await expect(caption).toBeVisible();
      await form.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(form).toHaveCount(0);
      expect(writes).toEqual([]);
    });
  }
}
