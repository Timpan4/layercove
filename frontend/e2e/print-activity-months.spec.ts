import { test, expect } from './test';

const records = [
  { id: 1, created_at: '2026-03-29T12:00:00Z' },
  { id: 2, created_at: '2026-03-29T13:00:00Z' },
  { id: 3, created_at: '2026-04-01T12:00:00Z' },
  { id: 4, created_at: '2026-04-19T12:00:00Z' },
  { id: 5, created_at: '2026-05-01T12:00:00Z' },
  { id: 6, created_at: '2026-10-01T12:00:00Z' },
  { id: 7, created_at: '2026-10-25T12:00:00Z' },
];
const statistics = {
  total_prints: 7, successful_prints: 7, failed_prints: 0, cancelled_prints: 0,
  total_print_time_hours: 7, total_filament_grams: 70, total_cost: 2,
  prints_by_filament_type: { PLA: 7 }, prints_by_printer: {},
  average_time_accuracy: null, time_accuracy_by_printer: null,
  total_energy_kwh: 0, total_energy_cost: 0,
};

test.use({ serviceWorkers: 'block', timezoneId: 'UTC', locale: 'en-US' });
for (const width of [1440, 390]) {
  for (const day of ['2026-10-01', '2026-10-25']) {
    test(`Print Activity months stay distinct on ${day} at ${width}px`, async ({ page }, testInfo) => {
      const writes: string[] = [];
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.clock.setFixedTime(new Date(day + 'T12:00:00Z'));
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
          return route.fulfill({ status: 405, json: { detail: 'Read-only month-label fixture' } });
        }
        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { check_updates: false };
        if (path === '/api/v1/archives/stats') body = statistics;
        if (path === '/api/v1/archives/slim') body = records;
        if (path.endsWith('/analysis/failures')) body = { period_days: 30, total_prints: 7, failed_prints: 0, failure_rate: 0, failures_by_reason: {}, failures_by_filament: {}, failures_by_printer: {}, failures_by_hour: {}, recent_failures: [], trend: [] };
        await route.fulfill({ json: body });
      });
      await page.goto('/stats');
      const card = page.getByRole('heading', { name: 'Print Activity', exact: true }).locator('..').locator('..').locator('..');
      await expect(card.getByRole('button', { name: 'Size: 1/2 - Click to cycle', exact: true })).toBeVisible();
      const firstMonth = day === '2026-10-01' ? 'Mar' : 'Apr';
      const months = day === '2026-10-01' ? ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'] : ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
      await expect(card.getByText(firstMonth, { exact: true })).toBeVisible();
      if (day === '2026-10-01') {
        await expect(card.getByTitle('3/29/2026: 2 prints', { exact: true })).toBeVisible();
        await expect(card.getByTitle('4/1/2026: 1 print', { exact: true })).toBeVisible();
        await expect(card.getByTitle('10/1/2026: 1 print', { exact: true })).toBeVisible();
        await expect(card.getByTitle('10/25/2026: 1 print', { exact: true })).toHaveCount(0);
      } else {
        await expect(card.getByTitle('4/19/2026: 1 print', { exact: true })).toBeVisible();
        await expect(card.getByTitle('5/1/2026: 1 print', { exact: true })).toBeVisible();
        await expect(card.getByTitle('10/25/2026: 1 print', { exact: true })).toBeVisible();
        await expect(card.getByTitle('3/29/2026: 2 prints', { exact: true })).toHaveCount(0);
      }
      const cells = await card.locator('[title]').evaluateAll((elements) => elements.map((element) => element.getAttribute('title')).filter((title) => title?.match(/: \d+ prints?$/)));
      await testInfo.attach('unchanged-activity-days', { body: JSON.stringify(cells), contentType: 'application/json' });
      await card.scrollIntoViewIfNeeded();
      const anchors = Object.fromEntries(months.map((month) => {
        const monthIndex = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(month) + 1;
        const firstDay = month === firstMonth ? (day === '2026-10-01' ? 29 : 19) : 1;
        const count = month === 'Mar' ? 2 : ['Apr', 'May', 'Oct'].includes(month) ? 1 : 0;
        return [month, `${monthIndex}/${firstDay}/2026: ${count} print${count === 1 ? '' : 's'}`];
      }));
      const bounds = await card.evaluate((card, { months, anchors }) => {
        const rectangle = (element: Element) => { const box = element.getBoundingClientRect(); return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }; };
        const labels = months.map((month) => {
          const element = Array.from(card.querySelectorAll('div')).find((element) => element.childElementCount === 0 && element.textContent === month)!;
          const range = document.createRange();
          range.selectNodeContents(element);
          const box = range.getBoundingClientRect();
          const cell = Array.from(card.querySelectorAll('[title]')).find((element) => element.getAttribute('title') === anchors[month])!;
          return { month, left: box.left, right: box.right, top: box.top, bottom: box.bottom, firstWeekLeft: cell.getBoundingClientRect().left };
        });
        return { card: rectangle(card), labels };
      }, { months, anchors });
      await testInfo.attach('month-label-bounds', { body: JSON.stringify(bounds, null, 2), contentType: 'application/json' });
      await testInfo.attach('print-activity-widget', { body: await card.screenshot(), contentType: 'image/png' });
      expect(bounds.labels.map((label) => label.month)).toEqual(months);
      for (let i = 0; i < bounds.labels.length; i++) {
        const label = bounds.labels[i];
        expect(label.left, label.month + ' inside left edge').toBeGreaterThanOrEqual(bounds.card.left);
        expect(label.right, label.month + ' inside right edge').toBeLessThanOrEqual(bounds.card.right);
        for (const previous of bounds.labels.slice(0, i)) {
          const overlaps = label.left < previous.right && label.right > previous.left && label.top < previous.bottom && label.bottom > previous.top;
          expect(overlaps, previous.month + '/' + label.month + ' overlap').toBe(false);
        }
      }
      for (const label of [...bounds.labels].reverse()) {
        expect(label.left, label.month + ' stays above its first displayed week').toBe(label.firstWeekLeft);
      }
      expect(writes).toEqual([]);
    });
  }
}
