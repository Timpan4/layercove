import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

async function openFixture(page: Page, width: number) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript(() => localStorage.setItem('auth_token', 'fictional-settings-token'));
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
        return route.fulfill({ json: { token: 'fictional-token' } });
      }
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only settings fixture' } });
    }

    let body: unknown = [];
    if (path.endsWith('/auth/status')) body = { auth_enabled: true, requires_setup: false };
    if (path.endsWith('/auth/me')) body = {
      id: 901, username: 'Fixture Settings', groups: [],
      permissions: [
        'settings:read', 'settings:update', 'printers:read', 'smart_plugs:read', 'smart_plugs:create',
        'library:purge', 'archives:purge',
      ],
    };
    if (path.endsWith('/settings')) body = {
      language: 'en', date_format: 'system', time_format: 'system', currency: 'USD',
      ha_enabled: true, ha_url: 'https://ha.example.invalid', ha_token: 'fixture-token',
      mqtt_broker: 'mqtt.example.invalid', auto_archive: true, save_thumbnails: true,
      capture_finish_photo: false, default_filament_cost: 20, energy_cost_per_kwh: 0.25,
      library_disk_warning_gb: 5,
    };
    if (path.endsWith('/archive-purge-settings')) body = { enabled: false, days: 30, purge_stats: false };
    if (path.endsWith('/library/trash/settings')) body = {
      retention_days: 30, auto_purge_enabled: false, auto_purge_days: 90,
      auto_purge_include_never_printed: false,
    };
    if (path.endsWith('/printers')) body = [];
    if (path.endsWith('/system/storage-usage')) body = {
      categories: [], other_breakdown: [], roots: [], total_bytes: 0,
      total_formatted: '0 B', scan_errors: 0,
    };
    if (path.endsWith('/smart-plugs/ha/entities')) body = [{
      entity_id: 'switch.fixture_plug', friendly_name: 'Fixture Plug', state: 'off',
    }];
    if (path.endsWith('/smart-plugs/ha/sensors')) body = [
      { entity_id: 'sensor.fixture_power', friendly_name: 'Fixture Power', state: '42', unit_of_measurement: 'W' },
      { entity_id: 'sensor.fixture_energy_today', friendly_name: 'Fixture Energy Today', state: '1.2', unit_of_measurement: 'kWh' },
      { entity_id: 'sensor.fixture_energy_total', friendly_name: 'Fixture Energy Total', state: '12.5', unit_of_measurement: 'kWh' },
    ];
    await route.fulfill({ json: body });
  });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible();
  return writes;
}

async function expectVisibleControlsHaveVisibleLabels(container: ReturnType<Page['locator']>) {
  const unlabeled = await container.locator('input:visible, select:visible, textarea:visible').evaluateAll((controls) =>
    controls.filter((control) => {
      const input = control as HTMLInputElement;
      const hasVisibleCaption = Array.from(input.labels ?? []).some((label) => label.textContent?.trim());
      return !hasVisibleCaption && !input.getAttribute('aria-label');
    }).map((control) => ({
      tag: control.tagName,
      id: (control as HTMLInputElement).id,
      type: (control as HTMLInputElement).type,
      placeholder: (control as HTMLInputElement).placeholder,
      labels: Array.from((control as HTMLInputElement).labels ?? []).map((label) => label.textContent),
    })),
  );
  expect(unlabeled).toEqual([]);
}

for (const width of [1440, 390]) {
  test(`General settings visible controls use native visible labels at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width);
    await expectVisibleControlsHaveVisibleLabels(page.locator('main'));
    await expect(page.getByRole('textbox', { name: 'Search settings', exact: true })).toHaveAttribute('placeholder', 'Search settings…');
    for (const [mode, group] of [['Dark', 'Dark Mode'], ['Light', 'Light Mode']] as const) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      for (const field of ['Background', 'Accent', 'Style']) {
        await expect(page.getByRole('combobox', { name: `${group} ${field}`, exact: true })).toHaveCount(1);
      }
    }
    expect(writes).toEqual([]);
  });

  test(`every Smart Plug provider control uses native visible labels at ${width}px`, async ({ page }) => {
    const writes = await openFixture(page, width);
    await page.getByRole('button', { name: 'Smart Plugs', exact: false }).click();
    await page.getByRole('button', { name: 'Add Smart Plug', exact: true }).click();
    const form = page.locator('form');

    for (const provider of ['Tasmota', 'HA', 'MQTT', 'REST']) {
      if (provider !== 'Tasmota') await form.getByRole('button', { name: provider, exact: true }).click();
      if (provider === 'HA') {
        const entitySearch = form.getByRole('textbox', { name: /Select Entity/ });
        await expect(entitySearch).toBeVisible();
        await entitySearch.click();
        await form.getByRole('button', { name: /Fixture Plug/ }).click();
        await expect(form.getByText('Power Sensor (W)', { exact: true })).toBeVisible();
      }

      if (provider === 'MQTT') {
        for (const group of ['Power Monitoring', 'Energy Monitoring', 'State Monitoring']) {
          await expect(form.getByRole('textbox', { name: new RegExp(`${group}.*Topic`, 'i') })).toHaveCount(1);
          await expect(form.getByRole('textbox', { name: new RegExp(`${group}.*JSON Path`, 'i') })).toHaveCount(1);
        }
        await expect(form.getByRole('textbox', { name: 'Topic', exact: true })).toHaveCount(0);
        await expect(form.getByRole('textbox', { name: 'JSON Path', exact: true })).toHaveCount(0);
        await expect(form.getByRole('textbox', { name: /Power Monitoring.*Multiplier/i })).toHaveCount(1);
        await expect(form.getByRole('textbox', { name: /Energy Monitoring.*Multiplier/i })).toHaveCount(1);
        await expect(form.getByRole('textbox', { name: /State Monitoring.*On Value/i })).toHaveCount(1);
      }

      if (provider === 'REST') {
        for (const [group, field] of [
          ['Control', 'On URL'], ['Control', 'Off URL'],
          ['State Monitoring', 'Status URL'], ['State Monitoring', 'JSON Path'],
          ['Energy Monitoring', 'Power URL'], ['Energy Monitoring', 'Power JSON Path'],
          ['Energy Monitoring', 'Power Multiplier'], ['Energy Monitoring', 'Energy URL'],
          ['Energy Monitoring', 'Energy JSON Path'], ['Energy Monitoring', 'Energy Multiplier'],
        ]) {
          await expect(form.getByRole('textbox', { name: new RegExp(`${group}.*${field}`, 'i') })).toHaveCount(1);
        }
        await expect(form.getByRole('textbox', { name: 'URL', exact: true })).toHaveCount(0);
        await expect(form.getByRole('textbox', { name: 'Path', exact: true })).toHaveCount(0);
        await expect(form.getByRole('textbox', { name: 'Multiplier', exact: true })).toHaveCount(0);
      }

      const powerAlerts = form.getByRole('checkbox', { name: 'Power Alerts', exact: true });
      if (!(await powerAlerts.isChecked())) {
        await form.getByText('Power Alerts', { exact: true }).click();
      }
      await expect(powerAlerts).toBeChecked();
      if (provider !== 'MQTT') {
        const schedule = form.getByRole('checkbox', { name: 'Daily Schedule', exact: true });
        if (!(await schedule.isChecked())) {
          await form.getByText('Daily Schedule', { exact: true }).click();
        }
        await expect(schedule).toBeChecked();
      }
      await expectVisibleControlsHaveVisibleLabels(form);
    }
    expect(writes).toEqual([]);
  });
}
