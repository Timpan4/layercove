import { test, expect } from './test';

const cases = [
  { name: 'mixed outcomes', total: 20, outcomes: 18, failed: 10, rate: '55.6' },
  { name: 'one failure and cancellations', total: 3, outcomes: 1, failed: 1, rate: '100.0' },
  { name: 'only cancellations', total: 3, outcomes: 0, failed: 0, rate: '0.0' },
];

test.use({ serviceWorkers: 'block' });
for (const width of [1440, 390]) {
  for (const fixture of cases) {
    test(`Failure Analysis names its denominator for ${fixture.name} at ${width}px`, async ({ page }, testInfo) => {
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
          return route.fulfill({ status: 405, json: { detail: 'Read-only failure denominator fixture' } });
        }
        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { check_updates: false };
        if (path === '/api/v1/archives/stats') body = {
          total_prints: fixture.total, successful_prints: fixture.outcomes - fixture.failed,
          failed_prints: fixture.failed, cancelled_prints: fixture.total - fixture.outcomes,
          total_print_time_hours: 0, total_filament_grams: 0, total_cost: 0,
          prints_by_filament_type: {}, prints_by_printer: {},
          average_time_accuracy: null, time_accuracy_by_printer: null,
          total_energy_kwh: 0, total_energy_cost: 0,
        };
        if (path.endsWith('/analysis/failures')) body = {
          period_days: 30, total_prints: fixture.total, outcome_prints: fixture.outcomes,
          failed_prints: fixture.failed, failure_rate: Number(fixture.rate),
          failures_by_reason: { bed_adhesion: fixture.failed }, failures_by_filament: {},
          failures_by_printer: {}, failures_by_hour: {}, recent_failures: [], trend: [],
        };
        await route.fulfill({ json: body });
      });
      await page.goto('/stats');
      const card = page.getByRole('heading', { name: 'Failure Analysis', exact: true }).locator('..').locator('..').locator('..');
      await expect(card.getByText(`${fixture.rate}%`, { exact: true })).toBeVisible();
      const caption = card.getByText(`Failed: ${fixture.failed} / ${fixture.outcomes} completed or failed prints`, { exact: true });
      const explanation = card.getByText('Cancelled, stopped and skipped prints are excluded.', { exact: true });
      await expect(caption).toBeVisible();
      await expect(explanation).toBeVisible();
      await expect(card.getByText(`${fixture.failed} / ${fixture.total} prints failed`, { exact: true })).toHaveCount(0);
      for (const size of ['1/4', '1/2', 'Full']) {
        await expect(card.getByRole('button', { name: `Size: ${size} - Click to cycle`, exact: true })).toBeVisible();
        await card.scrollIntoViewIfNeeded();
        const bounds = await card.evaluate((element) => {
          const cardBox = element.getBoundingClientRect();
          const texts = Array.from(element.querySelectorAll('div, p')).filter((node) => node.childElementCount === 0 && (node.textContent?.startsWith('Failed:') || node.textContent === 'Cancelled, stopped and skipped prints are excluded.'));
          return { left: cardBox.left, right: cardBox.right, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, texts: texts.map((node) => {
            const range = document.createRange(); range.selectNodeContents(node);
            return Array.from(range.getClientRects()).map((rect) => ({ left: rect.left, right: rect.right }));
          }) };
        });
        await testInfo.attach(`failure-denominator-${size.replace('/', '-')}`, { body: await card.screenshot(), contentType: 'image/png' });
        expect(bounds.scrollWidth, `${size} card content fits without clipping`).toBeLessThanOrEqual(bounds.clientWidth);
        for (const lines of bounds.texts) for (const line of lines) {
          expect(line.left).toBeGreaterThanOrEqual(bounds.left);
          expect(line.right).toBeLessThanOrEqual(bounds.right);
        }
        if (size !== 'Full') await card.getByRole('button', { name: `Size: ${size} - Click to cycle`, exact: true }).click();
      }
      expect(writes).toEqual([]);
    });
  }
}
