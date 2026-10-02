import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const iconNames = [
  'Droplet', 'Flame', 'Ruler', 'Sparkles', 'Square', 'Cable', 'Wrench',
  'Calendar', 'Timer', 'Cog', 'Fan', 'Zap', 'Wind', 'Thermometer',
  'Layers', 'Box', 'Target', 'RefreshCw', 'Settings', 'Filter', 'CircleDot',
];

async function openFixture(page: Page, width: number, deniedPermission?: string) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript(() => localStorage.setItem('auth_token', 'fictional-maintenance-token'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
        return route.fulfill({ json: { token: 'fictional-token' } });
      }
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only maintenance fixture' } });
    }
    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: true, requires_setup: false };
    if (path.endsWith('/auth/me')) body = {
      id: 901, username: 'Fixture Alice', groups: [],
      permissions: ['maintenance:read', 'maintenance:create', 'maintenance:update', 'maintenance:delete', 'printers:read']
        .filter((permission) => permission !== deniedPermission),
    };
    if (path.endsWith('/settings')) body = { check_updates: false };
    if (path.endsWith('/maintenance/overview')) body = [
      { id: 901, name: 'Fixture Voron A', hours: 123.4, enabled: true },
      { id: 902, name: 'Fixture Voron B', hours: 456.7, enabled: false },
    ].map((printer) => ({
      printer_id: printer.id, printer_name: printer.name, printer_model: null,
      total_print_hours: printer.hours, due_count: 0, warning_count: 0,
      maintenance_items: [{
        id: printer.id + 100, printer_id: printer.id, printer_name: printer.name,
        maintenance_type_id: 701, maintenance_type_name: 'Fixture Nozzle', maintenance_type_icon: 'Wrench',
        enabled: printer.enabled, interval_hours: 100, interval_type: 'hours',
        current_hours: printer.hours, hours_since_maintenance: 20, hours_until_due: 80,
        days_since_maintenance: null, days_until_due: null, is_due: false, is_warning: false,
        last_performed_at: null, wiki_url: null,
      }],
    }));
    if (path.endsWith('/maintenance/types')) body = [{
      id: 701, name: 'Fixture Nozzle', description: null, default_interval_hours: 100,
      interval_type: 'hours', icon: 'Wrench', wiki_url: null, is_system: true,
      created_at: '2026-10-01T00:00:00Z',
    }];
    if (path.endsWith('/maintenance/summary')) body = { total_due: 0, total_warning: 0, printers_with_issues: [] };
    await route.fulfill({ json: body });
  });
  await page.goto('/maintenance');
  await expect(page.getByRole('heading', { name: 'Fixture Voron A', exact: true })).toBeVisible();
  return writes;
}

async function openCreateForm(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add Custom Type', exact: true }).click();
  return page.locator('form');
}

for (const width of [1440, 390]) {
  test(`Status switches name the task and printer, retaining checked and disabled states at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width, 'maintenance:update');
    await page.getByRole('button', { name: 'Expand', exact: true }).first().click();
    await page.getByRole('button', { name: 'Expand', exact: true }).click();
    const switches = page.getByRole('switch');
    await expect(switches).toHaveCount(2);
    for (const [index, printer] of ['Fixture Voron A', 'Fixture Voron B'].entries()) {
      const toggle = switches.nth(index);
      await expect.soft(toggle).toHaveAccessibleName(`Enable Fixture Nozzle, ${printer}`);
      await expect(toggle).toHaveAttribute('aria-checked', index === 0 ? 'true' : 'false');
      await expect(toggle).toBeDisabled();
    }
    expect(writes).toEqual([]);
  });

  test(`hours editors have printer labels and preserve the baseline on Escape and Cancel at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width);
    for (const [printer, hours] of [['Fixture Voron A', '123'], ['Fixture Voron B', '457']]) {
      const display = page.getByRole('button', { name: `${hours} hours Total Print Time`, exact: true });
      await display.click();
      const input = page.getByRole('spinbutton', { name: `Edit Print Hours, ${printer}`, exact: true });
      await expect(input).toHaveValue(hours);
      await expect(input).toHaveAttribute('min', '0');
      await expect(input).toHaveAttribute('step', '1');
      await input.fill('789');
      await input.press('Escape');
      await expect(display).toBeVisible();
      await display.click();
      await expect(input).toHaveValue(hours);
      await input.fill('987');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(display).toBeVisible();
    }
    expect(writes).toEqual([]);
  });

  test(`create interval type uses its visible label at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width);
    const form = await openCreateForm(page);
    const intervalType = form.getByRole('combobox', { name: 'Interval Type', exact: true });
    await expect(intervalType).toHaveValue('hours');
    await intervalType.selectOption('days');
    await expect(intervalType).toHaveValue('days');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(writes).toEqual([]);
  });

  test(`create interval value follows its visible hours or days label at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width);
    const form = await openCreateForm(page);
    await expect(form.getByRole('spinbutton', { name: 'Interval (hours)', exact: true })).toHaveValue('100');
    await form.getByRole('combobox').selectOption('days');
    const days = form.getByRole('spinbutton', { name: 'Interval (calendar days)', exact: true });
    await expect(days).toHaveValue('30');
    await expect(days).toHaveAttribute('min', '1');
    await days.fill('45');
    await expect(days).toHaveValue('45');
    await form.getByRole('combobox').selectOption('hours');
    await expect(form.getByRole('spinbutton', { name: 'Interval (hours)', exact: true })).toHaveValue('100');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(writes).toEqual([]);
  });

  test(`all create icons have names and expose the selected choice at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width);
    const form = await openCreateForm(page);
    const icons = form.getByText('Icon', { exact: true }).locator('..').getByRole('button');
    await expect(icons).toHaveCount(21);
    await expect(form.getByText('Icon', { exact: true }).locator('..')).toMatchAriaSnapshot(
      iconNames.map((name) => `- button "Icon ${name}"${name === 'Wrench' ? ' [pressed]' : ''}`).join('\n'),
    );
    for (const [index, name] of iconNames.entries()) {
      await expect(icons.nth(index)).toHaveAttribute('aria-pressed', name === 'Wrench' ? 'true' : 'false');
    }
    for (const name of iconNames) {
      const icon = form.getByRole('button', { name: `Icon ${name}`, exact: true });
      await icon.click();
      await expect(icon).toHaveAttribute('aria-pressed', 'true');
      await expect(form.getByRole('button', { pressed: true })).toHaveCount(1);
    }
    await form.getByRole('combobox').selectOption('days');
    await expect(form.getByRole('button', { name: 'Icon CircleDot', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await form.getByRole('combobox').selectOption('hours');
    await expect(form.getByRole('button', { name: 'Icon CircleDot', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(writes).toEqual([]);
  });

  test(`system delete names its task and retains confirmation Cancel at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const deleteTask = page.getByRole('button', { name: 'Delete Fixture Nozzle', exact: true });
    await expect(deleteTask).toBeVisible();
    await deleteTask.click();
    const confirmation = page.getByRole('heading', { name: 'Delete default maintenance task?', exact: true });
    await expect(confirmation).toBeVisible();
    await expect(page.getByText('Are you sure you want to delete the default maintenance task "Fixture Nozzle"?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete Fixture Nozzle', exact: true })).toBeVisible();
    expect(writes).toEqual([]);
  });

  test(`system delete keeps its task name and permission tooltip while disabled at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width, 'maintenance:delete');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const deleteTask = page.getByRole('button', { name: 'Delete Fixture Nozzle', exact: true });
    await expect(deleteTask).toBeDisabled();
    await expect(deleteTask).toHaveAttribute('title', 'You do not have permission to delete maintenance types');
    expect(writes).toEqual([]);
  });
}
