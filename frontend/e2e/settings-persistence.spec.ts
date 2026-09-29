import { expect, test } from './test';

// A setting changed in the UI must reach the database and survive a reload.
test('date format change persists across reload', async ({ page, request }) => {
  // A fresh install redirects to /setup until first-run setup completes.
  const statusResponse = await request.get('/api/v1/auth/status');
  expect(statusResponse.ok()).toBe(true);
  const status = await statusResponse.json();
  if (status.requires_setup) {
    expect((await request.post('/api/v1/auth/setup', { data: { auth_enabled: false } })).ok()).toBe(true);
  } else {
    expect(status.auth_enabled, 'Use an isolated server with authentication disabled').toBe(false);
  }
  const original = (await (await request.get('/api/v1/settings')).json()).date_format ?? 'system';
  const target = original === 'iso' ? 'eu' : 'iso';

  try {
    await page.goto('/settings');
    const dateFormat = page.locator('select').filter({ has: page.locator('option[value="iso"]') });

    const saved = page.waitForResponse(
      (r) => r.url().includes('/api/v1/settings') && ['PUT', 'PATCH'].includes(r.request().method()) && r.ok(),
    );
    await dateFormat.selectOption(target);
    await saved;

    await page.reload();
    await expect(dateFormat).toHaveValue(target);
    expect((await (await request.get('/api/v1/settings')).json()).date_format).toBe(target);
  } finally {
    expect((await request.patch('/api/v1/settings', { data: { date_format: original } })).ok()).toBe(true);
  }
});
