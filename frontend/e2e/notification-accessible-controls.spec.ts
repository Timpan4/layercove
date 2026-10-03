import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const fixtureProvider = {
  id: 9301,
  name: 'Fixture Email Provider',
  provider_type: 'email',
  enabled: true,
  config: { smtp_server: 'smtp.fixture.invalid' },
  on_print_start: false,
  on_print_complete: true,
  on_print_failed: true,
  on_print_stopped: false,
  on_print_progress: false,
  on_printer_offline: false,
  on_printer_error: false,
  on_ai_failure_detection: false,
  on_filament_low: false,
  on_maintenance_due: false,
  on_stock_reorder_alert: false,
  on_stock_break_alert: false,
  on_bed_cooled: false,
  on_first_layer_complete: false,
  on_plate_not_empty: false,
  quiet_hours_enabled: true,
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  daily_digest_enabled: true,
  daily_digest_time: '08:00',
  printer_id: null,
  last_success: null,
  last_error: null,
  last_error_at: null,
};

const fixtureTemplates = [
  {
    id: 9401,
    event_type: 'print_complete',
    name: 'Fixture print complete',
    title_template: 'Print complete',
    body_template: 'Fixture printer finished',
    is_default: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 9402,
    event_type: 'print_failed',
    name: 'Fixture print failed',
    title_template: 'Print failed',
    body_template: 'Fixture printer failed',
    is_default: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const providerFields = {
  email: ['SMTP Server', 'SMTP Port', 'Security', 'Authentication', 'Username', 'Password', 'From Email', 'To Email'],
  telegram: ['Bot Token', 'Chat ID'],
  discord: ['Webhook URL'],
  ntfy: ['Server URL', 'Topic', 'Auth Token'],
  pushover: ['User Key', 'App Token', 'Priority'],
  callmebot: ['Phone Number', 'API Key'],
  webhook: ['Webhook URL', 'Payload Format', 'Authorization', 'Title Field Name', 'Message Field Name'],
  homeassistant: ['Home Assistant Service'],
} as const;

const blockedLocalRequests = new Set([
  'POST /api/v1/printers/camera/stream-token',
  'POST /api/v1/auth/ws-token',
  'POST /api/v1/notification-templates/preview',
]);

async function openNotifications(page: Page, width: number) {
  const blockedRequests: Array<{ method: string; path: string; status: number }> = [];
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(() => {
    localStorage.setItem('bambutrack_language', 'en');
    localStorage.setItem('auth_token', 'fictional-notifications-token');
  });
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      blockedRequests.push({ method: request.method(), path, status: 405 });
      return route.fulfill({ status: 405, json: { detail: 'Read-only notification fixture' } });
    }

    let body: unknown = [];
    if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
    if (path === '/api/v1/settings') body = { check_updates: false, notification_language: 'en' };
    if (path === '/api/v1/notifications') body = [fixtureProvider];
    if (path === '/api/v1/notification-templates') body = fixtureTemplates;
    if (path === '/api/v1/notification-templates/variables') {
      body = [
        { event_type: 'print_complete', event_name: 'Print complete', variables: ['printer_name'] },
        { event_type: 'print_failed', event_name: 'Print failed', variables: ['printer_name'] },
      ];
    }
    await route.fulfill({ json: body });
  });

  await page.goto('/settings?tab=notifications');
  await expect(page.locator('#card-providers')).toBeVisible();
  return { blockedRequests };
}

function expectOnlyBlockedLocalRequests(blockedRequests: Array<{ method: string; path: string; status: number }>) {
  expect(blockedRequests.every((request) => request.status === 405)).toBe(true);
  expect(blockedRequests.filter((request) => !blockedLocalRequests.has(`${request.method} ${request.path}`))).toEqual([]);
}

async function unlabeledNativeFields(form: ReturnType<Page['locator']>) {
  return form.locator('input:not([type="hidden"]), select, textarea').evaluateAll((fields) =>
    fields
      .filter((field): field is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
        field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement,
      )
      .filter((field) => field.labels?.length === 0 && !field.getAttribute('aria-label') && !field.getAttribute('aria-labelledby'))
      .map((field) => field.getAttribute('placeholder') || field.getAttribute('type') || field.tagName.toLowerCase()),
  );
}

for (const width of [1440, 390]) {
  test(`notification provider fields have associated labels at ${width}px`, async ({ page }) => {
    const { blockedRequests } = await openNotifications(page, width);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const form = page.locator('form');
    const typeSelect = form.locator('select').first();

    for (const [type, labels] of Object.entries(providerFields)) {
      await typeSelect.selectOption(type);
      for (const label of labels) await expect(form.getByText(label, { exact: false })).toBeVisible();
      await expect(form.getByRole('group', { name: /^Configuration:/ })).toBeVisible();
      expect(await unlabeledNativeFields(form), `${type} fields`).toEqual([]);

      if (type === 'webhook') {
        await form.locator('select').nth(1).selectOption('slack');
        await expect(form.getByText('Title Field Name', { exact: true })).toHaveCount(0);
        await expect(form.getByText('Message Field Name', { exact: true })).toHaveCount(0);
        await form.locator('select').nth(1).selectOption('generic');
        await expect(form.getByText('Title Field Name', { exact: true })).toBeVisible();
        await expect(form.getByText('Message Field Name', { exact: true })).toBeVisible();
      }
    }

    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Event Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editForm = page.locator('form');
    expect(await unlabeledNativeFields(editForm), 'edit provider fields').toEqual([]);
    await expect(editForm.getByRole('group', { name: /^Configuration:/ })).toBeVisible();
    expect((await readSwitchStates(editForm)).map(({ name }) => name)).toEqual(
      addProviderSwitches.map(({ name }) => name.replace('Add Notification Provider', 'Edit Notification Provider')),
    );

    expectOnlyBlockedLocalRequests(blockedRequests);
  });

  test(`notification provider switch and template pencil actions are named at ${width}px`, async ({ page }) => {
    const { blockedRequests } = await openNotifications(page, width);
    const providerCard = page.getByRole('heading', { name: fixtureProvider.name, exact: true })
      .locator('..').locator('..').locator('..').locator('..');
    const providerSwitch = providerCard.getByRole('switch', { name: `Enabled: ${fixtureProvider.name}`, exact: true });
    await expect(providerSwitch).toBeVisible();
    await page.getByRole('button', { name: 'Event Settings', exact: true }).click();
    await expect(providerSwitch).toHaveCount(2);

    const templateColumn = page.locator('#card-templates').locator('..');
    for (const template of fixtureTemplates) {
      await expect(templateColumn.getByRole('button', { name: `Edit Template: ${template.name}`, exact: true })).toBeVisible();
    }
    expectOnlyBlockedLocalRequests(blockedRequests);
  });

  test(`notification template fields have associated labels at ${width}px`, async ({ page }) => {
    const { blockedRequests } = await openNotifications(page, width);
    await page.getByText(fixtureTemplates[0].name, { exact: true }).click();
    const form = page.locator('form');
    expect(await unlabeledNativeFields(form)).toEqual([]);
    expectOnlyBlockedLocalRequests(blockedRequests);
  });
}

const addProviderSwitches = [
  { name: 'Add Notification Provider: Quiet Hours (Do Not Disturb)', checked: false },
  { name: 'Add Notification Provider: Daily Digest', checked: false },
  { name: 'Add Notification Provider: Print Events: Start', checked: false },
  { name: 'Add Notification Provider: Print Events: Complete', checked: true },
  { name: 'Add Notification Provider: Print Events: Failed', checked: true },
  { name: 'Add Notification Provider: Print Events: Stopped', checked: true },
  { name: 'Add Notification Provider: Print Events: Progress', checked: false },
  { name: 'Add Notification Provider: Print Events: Bed Cooled', checked: false },
  { name: 'Add Notification Provider: Print Events: First Layer Complete', checked: false },
  { name: 'Add Notification Provider: Printer Status: Offline', checked: false },
  { name: 'Add Notification Provider: Printer Status: Error', checked: false },
  { name: 'Add Notification Provider: Printer Status: AI Failure Detection', checked: false },
  { name: 'Add Notification Provider: Printer Status: Low Filament', checked: false },
  { name: 'Add Notification Provider: Printer Status: Maintenance', checked: false },
  { name: 'Add Notification Provider: Inventory Alerts: Reorder Alert', checked: false },
  { name: 'Add Notification Provider: Inventory Alerts: Stock Break Alert', checked: false },
] as const;

const providerCardSwitches = [
  { name: `Enabled: ${fixtureProvider.name}`, checked: true },
  { name: `Enabled: ${fixtureProvider.name}`, checked: true },
  { name: 'Print Events: Print Started', checked: false },
  { name: 'Print Events: Plate Not Empty', checked: false },
  { name: 'Print Events: Print Completed', checked: true },
  { name: 'Print Events: Bed Cooled', checked: false },
  { name: 'Print Events: First Layer Complete', checked: false },
  { name: 'Print Events: Missing Spool Assignment', checked: false },
  { name: 'Print Events: Print Failed', checked: true },
  { name: 'Print Events: Print Stopped', checked: false },
  { name: 'Print Events: Progress Milestones', checked: false },
  { name: 'Printer Status: Printer Offline', checked: false },
  { name: 'Printer Status: Printer Error', checked: false },
  { name: 'Printer Status: AI Failure Detection', checked: false },
  { name: 'Printer Status: Low Filament', checked: false },
  { name: 'Printer Status: Maintenance Due', checked: false },
  { name: 'AMS Alarms: AMS Humidity High', checked: false },
  { name: 'AMS Alarms: AMS Temperature High', checked: false },
  { name: 'AMS-HT Alarms: AMS-HT Humidity High', checked: false },
  { name: 'AMS-HT Alarms: AMS-HT Temperature High', checked: false },
  { name: 'Inventory Alerts: Reorder Alert', checked: false },
  { name: 'Inventory Alerts: Stock Break Alert', checked: false },
  { name: 'Print Queue: Job Added', checked: false },
  { name: 'Print Queue: Job Assigned', checked: false },
  { name: 'Print Queue: Job Started', checked: false },
  { name: 'Print Queue: Job Waiting', checked: true },
  { name: 'Print Queue: Job Skipped', checked: true },
  { name: 'Print Queue: Job Failed', checked: true },
  { name: 'Print Queue: Queue Complete', checked: false },
  { name: `${fixtureProvider.name}: Quiet Hours`, checked: true },
  { name: `${fixtureProvider.name}: Daily Digest`, checked: true },
] as const;

async function readSwitchStates(container: ReturnType<Page['locator']>) {
  return container.getByRole('switch').evaluateAll((switches) =>
    switches.map((control) => ({
      name: control.getAttribute('aria-label'),
      checked: control.getAttribute('aria-checked'),
      disabled: control.hasAttribute('disabled'),
    })),
  );
}

for (const width of [1440, 390]) {
  test(`all visible notification settings controls have names and preserve state at ${width}px`, async ({ page }) => {
    const { blockedRequests } = await openNotifications(page, width);

    const notificationLanguage = page.getByRole('combobox', { name: 'Notification Language', exact: true });
    const bedCooledThreshold = page.getByRole('spinbutton', { name: 'Bed Cooled Threshold', exact: true });
    const userNotifications = page.getByRole('checkbox', { name: 'User Notifications', exact: true });
    const templateFilter = page.getByRole('textbox', { name: 'Filter templates…', exact: true });
    expect.soft(await notificationLanguage.count(), 'Notification Language accessible name').toBe(1);
    expect.soft(await bedCooledThreshold.count(), 'Bed Cooled Threshold accessible name').toBe(1);
    expect.soft(await userNotifications.count(), 'User Notifications accessible name').toBe(1);
    expect.soft(await templateFilter.count(), 'template filter accessible name').toBe(1);
    await expect.soft(page.locator('main select').first()).toHaveValue('en');
    await expect.soft(page.locator('main input[type="number"]')).toHaveValue('35');
    await expect.soft(page.locator('main input[type="checkbox"]')).toBeChecked();
    await expect.soft(page.locator('main input[type="checkbox"]')).toBeDisabled();
    await expect.soft(templateFilter).toHaveValue('');

    const providerCard = page.getByRole('heading', { name: fixtureProvider.name, exact: true })
      .locator('..').locator('..').locator('..').locator('..');
    await page.getByRole('button', { name: 'Event Settings', exact: true }).click();
    const observedCardSwitches = await readSwitchStates(providerCard);
    expect.soft(observedCardSwitches, 'expanded provider switches names, checked and disabled states').toEqual(
      providerCardSwitches.map(({ name, checked }) => ({ name, checked: String(checked), disabled: false })),
    );
    expect.soft(await providerCard.getByRole('button', {
      name: `Delete Notification Provider: ${fixtureProvider.name}`,
      exact: true,
    }).count(), 'expanded provider delete action name').toBe(1);

    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    const addHeading = page.getByRole('heading', { name: 'Add Notification Provider', exact: true });
    const addModal = addHeading.locator('..').locator('..');
    expect.soft(await addModal.getByRole('button', { name: 'Close', exact: true }).count(), 'Add Provider Close action name').toBe(1);
    const observedAddSwitches = await readSwitchStates(addModal);
    expect.soft(observedAddSwitches, 'Add Provider switches names, checked and disabled states').toEqual(
      addProviderSwitches.map(({ name, checked }) => ({ name, checked: String(checked), disabled: false })),
    );
    const quietHoursSwitch = addModal.getByRole('switch', {
      name: 'Add Notification Provider: Quiet Hours (Do Not Disturb)', exact: true,
    });
    const dailyDigestSwitch = addModal.getByRole('switch', {
      name: 'Add Notification Provider: Daily Digest', exact: true,
    });
    if (await quietHoursSwitch.count() === 1) await quietHoursSwitch.click();
    if (await dailyDigestSwitch.count() === 1) await dailyDigestSwitch.click();
    if (await quietHoursSwitch.count() === 1) {
      await expect.soft(addModal.getByLabel('Start', { exact: true })).toBeVisible();
      await expect.soft(addModal.getByLabel('End', { exact: true })).toBeVisible();
    }
    if (await dailyDigestSwitch.count() === 1) {
      await expect.soft(addModal.getByLabel('Send digest at', { exact: true })).toBeVisible();
    }
    await addModal.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByText(fixtureTemplates[0].name, { exact: true }).click();
    const templateHeading = page.getByRole('heading', { name: `Edit Template: ${fixtureTemplates[0].name}`, exact: true });
    const templateEditor = templateHeading.locator('..').locator('..');
    expect.soft(await templateEditor.getByRole('button', { name: 'Close', exact: true }).count(), 'template editor Close action name').toBe(1);

    expectOnlyBlockedLocalRequests(blockedRequests);
  });
}
