import type { Page } from '@playwright/test';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

async function openQueueDispatch(page: Page, width: number) {
  const writes: string[] = [];
  const externalRequests: string[] = [];
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'fictional-queue-label-session');
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      externalRequests.push(request.url());
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only queue settings fixture' } });
    }
    const body = path.endsWith('/auth/status') ? { auth_enabled: true, requires_setup: false }
      : path.endsWith('/auth/me') ? {
        id: 198, username: 'Fictional Queue Admin', is_admin: true, is_active: true,
        groups: [], permissions: ['settings:read', 'settings:update', 'printers:read'],
      }
      : path.endsWith('/settings') ? {
        language: 'en', date_format: 'system', time_format: 'system', currency: 'USD',
        preferred_slicer: 'bambu_studio', open_in_slicer: null, use_slicer_api: false,
        require_plate_clear: false, default_bed_levelling: true, default_flow_cali: false,
        default_vibration_cali: true, default_layer_inspect: false, default_timelapse: false,
        default_nozzle_offset_cali: true,
        gcode_snippets: JSON.stringify({ 'Fictional Printer': { start_gcode: 'G28', end_gcode: 'M400' } }),
      }
      : path.endsWith('/printers') ? [{ id: 198, name: 'Fictional Printer', model: 'Fictional Printer', nozzle_count: 1 }]
      : [];
    return route.fulfill({ json: body });
  });
  await page.goto('/settings?tab=queue&sub=dispatch', { waitUntil: 'commit' });
  await expect(page.getByRole('heading', { name: 'Default Print Options', exact: true })).toBeVisible();
  return { writes, externalRequests };
}

for (const width of [390, 1440]) {
  test(`queue dispatch controls have visible native captions at ${width}px`, async ({ page }) => {
    const { writes, externalRequests } = await openQueueDispatch(page, width);
    const captions = [
      'Bed Levelling', 'Flow Calibration', 'Vibration Calibration',
      'First Layer Inspection', 'Timelapse', 'Require plate-clear confirmation',
      'Preferred Slicer', 'Open in Slicer', 'Use Slicer API', 'Start G-code', 'End G-code',
    ];

    const missingCaptions: string[] = [];
    for (const caption of captions) {
      const control = page.getByLabel(caption, { exact: true });
      if (await control.count() !== 1) {
        missingCaptions.push(caption);
      } else {
        await expect(control).toBeVisible();
      }
    }
    expect(missingCaptions).toEqual([]);
    await expect(page.locator('#card-gcode')).toContainText('Fictional Printer');
    expect(writes.filter((request) => ![
      'POST /api/v1/printers/camera/stream-token',
      'POST /api/v1/auth/ws-token',
    ].includes(request))).toEqual([]);
    expect(externalRequests).toEqual([]);
  });
}
