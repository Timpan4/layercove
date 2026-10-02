import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const readings = [
  { name: 'unsupported Voron', provider: 'moonraker', model: 'Voron', connected: true, door_open: false, label: null },
  { name: 'Voron description is not a sensor capability', provider: 'moonraker', model: 'X1C', connected: true, door_open: false, label: null },
  { name: 'Bambu without a door sensor', provider: 'bambu', model: 'P1S', connected: true, door_open: false, label: null },
  { name: 'missing reading', provider: 'bambu', model: 'X1C', connected: true, label: null },
  { name: 'disconnected printer', provider: 'bambu', model: 'X1C', connected: false, door_open: false, label: null },
  { name: 'known open door', provider: 'bambu', model: 'X1C', connected: true, door_open: true, label: 'Door open' },
  { name: 'known closed door', provider: 'bambu', model: 'X1C', connected: true, door_open: false, label: 'Door closed' },
];

for (const width of [1280, 390]) {
  for (const reading of readings) {
    test(`${reading.name} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const unexpectedWrites: string[] = [];
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/\/$/, '');
        if (request.method() !== 'GET') {
          if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
            return route.fulfill({ json: { token: 'fixture-token' } });
          }
          unexpectedWrites.push(`${request.method()} ${path}`);
          return route.fulfill({ status: 405, json: { detail: 'Read-only door telemetry fixture' } });
        }
        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { check_updates: false };
        if (path === '/api/v1/printers') body = [{
          id: 1, name: 'Test printer', provider: reading.provider, model: reading.model,
          is_active: true, capabilities: { camera: false, ams: false },
        }];
        if (path === '/api/v1/printers/1/status') body = {
          connected: reading.connected, state: 'IDLE', vt_tray: [], ams: [],
          temperatures: { nozzle: 27, bed: 24 },
          ...('door_open' in reading ? { door_open: reading.door_open } : {}),
        };
        return route.fulfill({ json: body });
      });
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Inspect Test printer', exact: true }))
        .toContainText(reading.connected ? 'Live telemetry' : 'Reconnect to view telemetry');
      if (reading.label) {
        await expect(page.getByText(reading.label, { exact: true })).toBeVisible();
        await expect(page.getByText(reading.door_open ? 'Door closed' : 'Door open', { exact: true })).toHaveCount(0);
      } else {
        await expect(page.getByText('Door closed', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Door open', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Enclosure door open', { exact: true })).toHaveCount(0);
      }
      expect(unexpectedWrites).toEqual([]);
    });
  }
}
