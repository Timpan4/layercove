import { test, expect } from './test';
import type { Locator } from '@playwright/test';

async function axisGeometry(header: Locator, scrollToTick?: number) {
  return header.evaluate((element, index) => {
    const axis = element.parentElement!.lastElementChild!;
    const walker = document.createTreeWalker(axis, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      if (/^\d+ (AM|PM)$/.test(walker.currentNode.textContent!.trim())) nodes.push(walker.currentNode as Text);
    }
    if (index !== undefined) nodes[index].parentElement!.scrollIntoView({ block: 'nearest', inline: 'center' });
    const ticks = nodes.map((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      return { label: node.textContent!.trim(), left: box.left, right: box.right };
    });
    let scroller = axis.parentElement!;
    while (!['auto', 'scroll', 'hidden'].includes(getComputedStyle(scroller).overflowX)) {
      scroller = scroller.parentElement!;
    }
    const clip = scroller.getBoundingClientRect();
    const track = axis.getBoundingClientRect();
    return {
      ticks,
      axis: { left: track.left, width: track.width, right: track.right },
      printerLeft: element.getBoundingClientRect().left,
      printerRight: element.getBoundingClientRect().right,
      clipLeft: clip.left + scroller.clientLeft,
      clipRight: clip.left + scroller.clientLeft + scroller.clientWidth,
      overflow: getComputedStyle(scroller).overflowX,
      scrollable: scroller.scrollWidth > scroller.clientWidth,
      scrollLeft: scroller.scrollLeft,
      pageWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  }, scrollToTick);
}


test.use({ serviceWorkers: 'block', locale: 'en-US', timezoneId: 'Europe/Stockholm' });

for (const width of [1440, 390]) {
  test.describe(`overnight timeline range at ${width}px`, () => {
    let writes: string[];
    test.beforeEach(async ({ page }) => {
      writes = [];
      await page.setViewportSize({ width, height: 844 });
      await page.clock.setFixedTime(new Date('2026-10-01T07:23:00Z'));
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/\/$/, '');
        if (request.method() === 'POST' && (path.endsWith('/auth/ws-token') || path.endsWith('/camera/stream-token'))) {
          return route.fulfill({ json: { token: 'fictional-stream-token' } });
        }
        if (request.method() !== 'GET') {
          writes.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 405, json: { detail: 'Read-only fixture' } });
        }
        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { check_updates: false };
        if (path === '/api/v1/printers') body = [{ id: 170, name: 'Fixture Voron', model: 'Voron', is_active: true }];
        // Fictional committed jobs render time-aligned bars. Every API write is denied.
        if (path === '/api/v1/queue') body = [
          { id: 170, printer_id: 170, archive_id: null, position: 1,
            status: 'completed', created_at: '2026-09-30T10:00:00Z' },
          ...[
            ['Fictional morning', '2026-10-01T09:00:00Z'],
            ['Fictional afternoon', '2026-10-01T15:00:00Z'],
            ['Fictional overnight', '2026-10-02T05:00:00Z'],
          ].map(([archive_name, scheduled_time], index) => ({
            id: 171 + index, printer_id: 170, archive_id: null, position: index + 1,
            status: 'pending', archive_name, scheduled_time, print_time_seconds: 7200,
            created_at: '2026-09-30T10:00:00Z',
          })),
        ];
        await route.fulfill({ json: body });
      });
      await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
      await page.goto('/queue');
      await page.getByRole('button', { name: 'Timeline', exact: true }).click();
    });

    test.afterEach(() => { expect(writes).toEqual([]); });


    test('all two-hour labels are readable and the complete 24-hour axis is reachable', async ({ page }) => {
      const header = page.getByText('Printer', { exact: true });
      const geometry = await axisGeometry(header);
      console.log('TIMELINE_AXIS_MEASURE', JSON.stringify({ width, ...geometry }));
      expect(geometry.ticks.map((tick) => tick.label)).toEqual([
        '9 AM', '11 AM', '1 PM', '3 PM', '5 PM', '7 PM', '9 PM',
        '11 PM', '1 AM', '3 AM', '5 AM', '7 AM', '9 AM',
      ]);
      for (let index = 1; index < geometry.ticks.length; index++) {
        expect.soft(geometry.ticks[index].left, `tick ${index} overlaps its predecessor`)
          .toBeGreaterThanOrEqual(geometry.ticks[index - 1].right);
      }
      if (geometry.scrollable) expect.soft(['auto', 'scroll']).toContain(geometry.overflow);
      if (geometry.overflow === 'hidden') {
        expect.soft(geometry.ticks.at(-1)!.right, 'final label clips beyond the time range').toBeLessThanOrEqual(geometry.clipRight);
      }
      expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.pageWidth);
      for (let index = 0; index < geometry.ticks.length; index++) {
        const reached = await axisGeometry(header, index);
        expect.soft(reached.printerLeft, 'printer column remains visible throughout the range').toBeGreaterThanOrEqual(reached.clipLeft);
        expect.soft(reached.ticks[index].left, `tick ${index} hidden behind printer column`)
          .toBeGreaterThanOrEqual(reached.printerRight);
        expect.soft(reached.ticks[index].right, `tick ${index} clipped at right edge`)
          .toBeLessThanOrEqual(reached.clipRight);
      }
    });

    test('scheduled bars, time grid and NOW retain the same coordinates while scrolling', async ({ page }) => {
      const header = page.getByText('Printer', { exact: true });
      for (const [name, startTick, endTick] of [
        ['Fictional morning', 1, 2], ['Fictional afternoon', 4, 5], ['Fictional overnight', 11, 12],
      ] as const) {
        const bar = page.getByRole('button', { name: new RegExp(`^${name}`) });
        await expect(bar).toBeVisible();
        await axisGeometry(header, startTick);
        const geometry = await axisGeometry(header);
        const row = await bar.evaluate((button) => {
          const lane = button.parentElement!;
          const track = lane.getBoundingClientRect();
          const job = button.getBoundingClientRect();
          const printer = lane.previousElementSibling!.getBoundingClientRect();
          const grid = [...lane.children].filter((child) => getComputedStyle(child).borderLeftWidth !== '0px'
            && child.tagName === 'DIV').map((line) => line.getBoundingClientRect().left);
          const now = [...lane.parentElement!.parentElement!.querySelectorAll('div')].find((node) =>
            node.style.left !== '' && getComputedStyle(node).pointerEvents === 'none'
            );
          return {
            jobLeft: job.left, jobRight: job.right, trackLeft: track.left, trackWidth: track.width,
            printerLeft: printer.left, printerRight: printer.right, grid, nowLeft: now?.getBoundingClientRect().left,
          };
        });
        // Compare rendered CSS pixel columns, including native subpixel layout rounding.
        expect(Math.round(row.trackLeft)).toBe(Math.round(geometry.axis.left));
        expect(Math.round(row.trackWidth)).toBe(Math.round(geometry.axis.width));
        expect(row.grid).toHaveLength(13);
        const labelInset = geometry.ticks[0].left - geometry.axis.left;
        for (let index = 0; index < geometry.ticks.length - 1; index++) {
          expect(Math.round(geometry.ticks[index].left - labelInset)).toBe(Math.round(row.grid[index]));
        }
        expect(Math.round(row.jobLeft)).toBe(Math.round(row.grid[startTick]));
        // The existing 32px minimum keeps short jobs selectable even on a compressed baseline.
        expect(Math.round(row.jobRight)).toBe(Math.round(Math.max(row.grid[endTick], row.jobLeft + 32)));
        expect(Math.round(row.grid[12])).toBe(Math.round(geometry.axis.right));
        expect(Math.round(row.printerRight)).toBe(Math.round(geometry.printerRight));
        expect(row.nowLeft).toBeDefined();
        expect(Math.round(row.nowLeft!)).toBe(Math.round(geometry.axis.left + geometry.axis.width * (23 / 60 / 24)));
      }
    });

    for (const window of [
      { name: 'initial', action: null, text: 'Thu, Oct 1, 09:00 AM → Fri, Oct 2, 09:00 AM' },
      { name: 'back', action: 'Back 12 hours', text: 'Wed, Sep 30, 09:00 PM → Thu, Oct 1, 09:00 PM' },
      { name: 'forward', action: 'Forward 12 hours', text: 'Thu, Oct 1, 09:00 PM → Fri, Oct 2, 09:00 PM' },
    ]) {
      test(`${window.name} window displays both days without clipping its controls`, async ({ page }) => {
        if (window.action) await page.getByTitle(window.action, { exact: true }).click();
        const range = page.getByText(window.text, { exact: true });
        await expect(range).toBeVisible();
        const bounds = await range.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        for (const title of ['Back 12 hours', 'Forward 12 hours']) {
          const button = page.getByTitle(title, { exact: true });
          await expect(button).toBeVisible();
          const box = await button.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        }
        if (window.action) {
          await page.getByRole('button', { name: 'Now', exact: true }).click();
          await expect(page.getByText('Thu, Oct 1, 09:00 AM → Fri, Oct 2, 09:00 AM', { exact: true })).toBeVisible();
        }
      });
    }
  });
}
