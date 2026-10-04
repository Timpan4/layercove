import type { Page } from '@playwright/test';
import { test as base, expect } from './test';

type Fixture = {
  blockedWrites: string[];
};

const test = base.extend<Fixture>({
  blockedWrites: async ({ page }, use, testInfo) => {
    const blockedWrites: string[] = [];
    const appOrigin = new URL(testInfo.project.use.baseURL!).origin;

    try {
      await page.addInitScript(() => {
        localStorage.setItem('bambutrack_language', 'en');
        localStorage.setItem('bambuddy_appliance_locale_consumed', '1');
        localStorage.removeItem('bambusy-stats-timeframe');
        localStorage.removeItem('bambusy-dashboard-layout-v2');

        const writes: string[] = [];
        Object.defineProperty(window, '__statsMetricStorageWrites', { value: writes });
        for (const method of ['setItem', 'removeItem', 'clear'] as const) {
          Storage.prototype[method] = function (...args: string[]) {
            // StatsPage syncs its default all-time range on mount. Keep that fixture-only
            // initialization from changing local storage while rejecting other writes.
            if (method === 'setItem' && this === localStorage && args[0] === 'bambusy-stats-timeframe' && args[1] === '{"preset":"all-time"}') return;
            writes.push(`${method} ${args.join(' ')}`);
          };
        }
      });
      await page.routeWebSocket(() => true, (socket) => socket.close());
      await page.route((url) => url.origin === appOrigin && url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/\/+$/, '');
        if (request.method() !== 'GET') {
          if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
            return route.fulfill({ json: { token: 'fictional-token' } });
          }
          blockedWrites.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 405, json: { detail: 'Read-only statistics metric fixture' } });
        }

        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { language: 'en', check_updates: false, currency: 'USD' };
        if (path === '/api/v1/printers') body = printers;
        if (path === '/api/v1/archives/stats') body = statistics;
        if (path === '/api/v1/archives/slim') body = archives;
        if (path.endsWith('/analysis/failures')) body = failureAnalysis;
        return route.fulfill({ status: 200, json: body });
      });

      await use(blockedWrites);
    } finally {
      const storageWrites = await page.evaluate(() =>
        (window as Window & { __statsMetricStorageWrites?: string[] }).__statsMetricStorageWrites ?? [],
      ).catch(() => ['storage write guard unavailable']);
      expect.soft(blockedWrites).toEqual([]);
      expect.soft(storageWrites).toEqual([]);
    }
  },
});

test.use({ serviceWorkers: 'block', locale: 'en-US', timezoneId: 'UTC' });

const printers = [
  { id: 901, name: 'Fictional Printer One', model: 'Fixture', enabled: true },
  { id: 902, name: 'Fictional Printer Two', model: 'Fixture', enabled: true },
];

const statistics = {
  total_prints: 3,
  successful_prints: 3,
  failed_prints: 0,
  cancelled_prints: 0,
  total_print_time_hours: 3,
  total_filament_grams: 90,
  total_cost: 3,
  prints_by_filament_type: { PLA: 2, PETG: 1 },
  prints_by_printer: { '901': 2, '902': 1 },
  average_time_accuracy: null,
  time_accuracy_by_printer: null,
  total_energy_kwh: 0,
  total_energy_cost: 0,
};

const archives = [
  {
    id: 901,
    created_at: '2026-10-02T10:00:00Z',
    started_at: '2026-10-02T10:00:00Z',
    completed_at: '2026-10-02T12:00:00Z',
    print_name: 'Fictional Benchy',
    status: 'completed',
    printer_id: 901,
    filament_type: 'PLA',
    filament_color: '#00AE42',
    filament_used_grams: 30,
    actual_time_seconds: 7200,
    print_time_seconds: 7200,
    cost: 1,
    quantity: 1,
  },
  {
    id: 902,
    created_at: '2026-10-03T14:00:00Z',
    started_at: '2026-10-03T14:00:00Z',
    completed_at: '2026-10-03T16:00:00Z',
    print_name: 'Fictional Vase',
    status: 'completed',
    printer_id: 901,
    filament_type: 'PLA',
    filament_color: '#3B82F6',
    filament_used_grams: 40,
    actual_time_seconds: 7200,
    print_time_seconds: 7200,
    cost: 1,
    quantity: 1,
  },
  {
    id: 903,
    created_at: '2026-10-04T08:00:00Z',
    started_at: '2026-10-04T08:00:00Z',
    completed_at: '2026-10-04T09:00:00Z',
    print_name: 'Fictional Bracket',
    status: 'completed',
    printer_id: 902,
    filament_type: 'PETG',
    filament_color: '#F59E0B',
    filament_used_grams: 20,
    actual_time_seconds: 3600,
    print_time_seconds: 3600,
    cost: 1,
    quantity: 1,
  },
];

const failureAnalysis = {
  period_days: 30,
  total_prints: 3,
  outcome_prints: 3,
  failed_prints: 0,
  failure_rate: 0,
  failures_by_reason: {},
  failures_by_filament: {},
  failures_by_printer: {},
  failures_by_hour: {},
  recent_failures: [],
  trend: [],
};

const charts = [
  { name: 'Prints by Printer', metrics: ['Weight', 'Prints', 'Time'] },
  { name: 'Print Habits', metrics: ['Weight', 'Prints', 'Time'] },
  { name: 'By Material', metrics: ['Weight', 'Prints', 'Time'] },
  { name: 'Color Distribution', metrics: ['Weight', 'Prints'] },
] as const;

async function openStats(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.clock.setFixedTime(new Date('2026-10-04T12:00:00Z'));
  await page.goto('/stats');

  // Wait for the real Stats page and its chart headings before checking controls.
  for (const chart of charts) {
    await expect(page.getByRole('heading', { name: chart.name, exact: true })).toBeVisible();
  }
}

for (const width of [390, 1440]) {
  for (const chart of charts) {
    test(`the ${chart.name} metric controls are named at ${width}px`, async ({ page, blockedWrites }) => {
      void blockedWrites;
      await openStats(page, width);

      const heading = page.getByRole('heading', { name: chart.name, exact: true });
      const group = page.getByRole('group', { name: chart.name, exact: true });
      await expect(heading).toBeVisible();
      await expect(group).toHaveCount(1);
      await expect(group.getByRole('button')).toHaveText([...chart.metrics]);
    });

    test(`the ${chart.name} metric controls expose keyboard selection at ${width}px`, async ({ page, blockedWrites }) => {
      void blockedWrites;
      await openStats(page, width);

      // Keep this state test independent of the group-name baseline above.
      const heading = page.getByRole('heading', { name: chart.name, exact: true });
      const chartCard = heading.locator('..').locator('..');
      const buttons = chart.metrics.map((metric) => chartCard.getByRole('button', { name: metric, exact: true }));
      await expect(chartCard.getByRole('button')).toHaveText([...chart.metrics]);
      await expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
      for (const button of buttons.slice(1)) await expect(button).toHaveAttribute('aria-pressed', 'false');

      const enterMetric = chart.metrics[1];
      await chartCard.getByRole('button', { name: enterMetric, exact: true }).press('Enter');
      await expect(chartCard.getByRole('button', { name: enterMetric, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(chartCard.getByRole('button', { name: 'Weight', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await expect(chartCard.locator('button[aria-pressed="true"]')).toHaveCount(1);

      const spaceMetric = chart.metrics.length === 3 ? chart.metrics[2] : 'Weight';
      await chartCard.getByRole('button', { name: spaceMetric, exact: true }).press('Space');
      await expect(chartCard.getByRole('button', { name: spaceMetric, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(chartCard.getByRole('button', { name: enterMetric, exact: true })).toHaveAttribute('aria-pressed', 'false');
      await expect(chartCard.locator('button[aria-pressed="true"]')).toHaveCount(1);
    });
  }
}
