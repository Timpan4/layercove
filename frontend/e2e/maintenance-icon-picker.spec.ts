import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const width of [1440, 390]) {
  test(`all maintenance icons stay reachable and retain selection at ${width}px`, async ({ page }, testInfo) => {
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
        permissions: ['maintenance:read', 'maintenance:create', 'maintenance:update', 'printers:read'],
      };
      if (path.endsWith('/settings')) body = { check_updates: false };
      if (path.endsWith('/maintenance/overview')) body = [{
        printer_id: 901, printer_name: 'Fixture Voron', printer_model: null,
        total_print_hours: 0, maintenance_items: [], due_count: 0, warning_count: 0,
      }];
      if (path.endsWith('/maintenance/types')) body = [{
        id: 701, name: 'Fixture type', description: null, default_interval_hours: 100,
        interval_type: 'hours', icon: 'CircleDot', wiki_url: null, is_system: false,
        created_at: '2026-10-01T00:00:00Z',
      }];
      if (path.endsWith('/maintenance/summary')) body = { total_due: 0, total_warning: 0, printers_with_issues: [] };
      await route.fulfill({ json: body });
    });
    await page.goto('/maintenance');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Add Custom Type', exact: true }).click();
    const form = page.locator('form');
    const icons = form.getByText('Icon', { exact: true }).locator('..').getByRole('button');
    await expect(icons).toHaveCount(21);
    const formBounds = await form.boundingBox();
    expect(formBounds).not.toBeNull();
    const mainBounds = await page.locator('main').evaluate((element) => ({
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
    }));
    expect(mainBounds.scrollWidth).toBeLessThanOrEqual(mainBounds.clientWidth);

    const colors = await icons.evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor));
    const selectedColor = colors.find((color) => colors.filter((other) => other === color).length === 1);
    expect(selectedColor).toBeDefined();
    const selectedIndices = () => icons.evaluateAll((buttons, color) => buttons.flatMap((button, index) =>
      getComputedStyle(button).backgroundColor === color ? [index] : []), selectedColor);
    for (let index = 0; index < 21; index++) {
      const button = icons.nth(index);
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(formBounds!.x);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(formBounds!.x + formBounds!.width);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await button.click();
      await expect.poll(selectedIndices).toEqual([index]);
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
    }
    const intervalType = form.getByRole('combobox');
    await expect(intervalType).toHaveValue('hours');
    await intervalType.selectOption('days');
    await expect(intervalType).toHaveValue('days');
    await expect.poll(selectedIndices).toEqual([20]);
    await intervalType.selectOption('hours');
    await expect(intervalType).toHaveValue('hours');
    await expect.poll(selectedIndices).toEqual([20]);
    expect(writes).toEqual([]);
    await testInfo.attach('maintenance-icon-picker', { body: await page.screenshot(), contentType: 'image/png' });
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toHaveCount(0);
    expect(writes).toEqual([]);
  });
}
