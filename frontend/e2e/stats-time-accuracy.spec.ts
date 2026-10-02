import { test, expect } from './test';

const longName = 'Fictional Voron printer with a long workshop name';
const printers = [
  { id: 901, name: longName, model: 'Voron 2.4', enabled: true },
  { id: 902, name: 'Tim Voron', model: 'Voron 2.4', enabled: true },
  { id: 903, name: 'Fixture P1S', model: 'P1S', enabled: true },
];
const stats = {
  total_prints: 3, successful_prints: 3, failed_prints: 0, cancelled_prints: 0,
  total_print_time_hours: 3, total_filament_grams: 30, total_cost: 1,
  prints_by_filament_type: { PLA: 3 }, prints_by_printer: { '901': 1, '902': 1, '903': 1 },
  average_time_accuracy: 105, time_accuracy_by_printer: { '901': 111, '902': 98, '903': 106 },
  total_energy_kwh: 0, total_energy_cost: 0,
};

test.use({ serviceWorkers: 'block' });
for (const width of [1440, 390]) {
  for (const size of [1, 2, 4]) {
    test(`Time Accuracy fits size ${size} at ${width}px`, async ({ page }, testInfo) => {
      const writes: string[] = [];
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.addInitScript(() => {
        localStorage.removeItem('bambusy-dashboard-layout-v2');
        localStorage.removeItem('bambusy-stats-timeframe');
      });
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/\/$/, '');
        if (request.method() !== 'GET') {
          if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) return route.fulfill({ json: { token: 'fictional-token' } });
          writes.push(request.method() + ' ' + path);
          return route.fulfill({ status: 405, json: { detail: 'Read-only geometry fixture' } });
        }
        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { check_updates: false };
        if (path === '/api/v1/printers') body = printers;
        if (path === '/api/v1/archives/stats') body = stats;
        if (path.endsWith('/analysis/failures')) body = { period_days: 30, total_prints: 3, failed_prints: 0, failure_rate: 0, failures_by_reason: {}, failures_by_filament: {}, failures_by_printer: {}, failures_by_hour: {}, recent_failures: [], trend: [] };
        await route.fulfill({ json: body });
      });
      await page.goto('/stats');
      const heading = page.getByRole('heading', { name: 'Time Accuracy', exact: true });
      const card = heading.locator('..').locator('..').locator('..');
      await expect(card.getByText('111%', { exact: true })).toBeVisible();
      if (size >= 2) await card.getByRole('button', { name: 'Size: 1/4 - Click to cycle', exact: true }).click();
      if (size === 4) await card.getByRole('button', { name: 'Size: 1/2 - Click to cycle', exact: true }).click();
      await expect(card.getByRole('button', { name: `Size: ${size === 1 ? '1/4' : size === 2 ? '1/2' : 'Full'} - Click to cycle`, exact: true })).toBeVisible();
      await card.scrollIntoViewIfNeeded();
      const bounds = await card.evaluate((card, longName) => {
        const rect = (element: Element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; };
        const cardBox = rect(card);
        const percentages = ['111%', '98%', '106%'].map((text) => {
          const value = Array.from(card.querySelectorAll('span')).find((span) => span.textContent === text)!;
          const range = document.createRange();
          range.selectNodeContents(value);
          const glyphs = range.getBoundingClientRect();
          return { value: text, left: glyphs.left, right: glyphs.right, name: rect(value.previousElementSibling!) };
        });
        return { card: cardBox, gauge: rect(card.querySelector('svg:has(circle)')!), percentages, longName: rect(Array.from(card.querySelectorAll('span')).find((span) => span.textContent === longName)!) };
      }, longName);
      await testInfo.attach('time-accuracy-bounds', { body: JSON.stringify(bounds, null, 2), contentType: 'application/json' });
      await testInfo.attach('time-accuracy-widget', { body: await card.screenshot(), contentType: 'image/png' });
      expect(bounds.gauge.left).toBeGreaterThanOrEqual(bounds.card.left);
      expect(bounds.gauge.right).toBeLessThanOrEqual(bounds.card.right);
      for (const value of bounds.percentages) {
        expect(value.left, value.value + ' left edge').toBeGreaterThanOrEqual(bounds.card.left);
        expect(value.right, value.value + ' full text right edge').toBeLessThanOrEqual(bounds.card.right);
        expect(value.name.width, value.value + ' printer name remains visible').toBeGreaterThan(0);
        expect(value.name.left).toBeGreaterThanOrEqual(bounds.card.left);
        expect(value.name.right).toBeLessThanOrEqual(value.left);
      }
      expect(bounds.longName.right).toBeLessThanOrEqual(bounds.card.right);
      expect(writes).toEqual([]);
    });
  }
}
