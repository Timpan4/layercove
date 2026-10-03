import { test, expect } from './test';

test.use({ serviceWorkers: 'block', hasTouch: true });

const names = [
  'Voron_Design_Cube_0.20mm_PLA_Standard_Profile_Calibration_front_left_plate.gcode.3mf',
  'Voron_Design_Cube_0.20mm_PLA_Standard_Profile_Calibration_back_right_plate.gcode.3mf',
];

for (const width of [1440, 390]) {
  for (const grouped of [false, true]) {
    test(`History reveals similar filenames at ${width}px in ${grouped ? 'batch' : 'standalone'} rows without printing`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const writes: string[] = [];
      await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/\/$/, '');
        if (request.method() !== 'GET') {
          // These read-only token requests never reach a backend or camera.
          if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
            await route.fulfill({ json: { token: 'fictional-token' } });
            return;
          }
          writes.push(`${request.method()} ${path}`);
          await route.fulfill({ status: 405, json: { detail: 'Read-only History fixture' } });
          return;
        }
        let body: unknown = [];
        if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
        if (path.endsWith('/settings')) body = { check_updates: false };
        if (path === '/api/v1/queue') body = names.map((name, index) => ({
          id: index + 1, printer_id: null, printer_name: 'Tim Voron', archive_id: null,
          library_file_id: index + 1, library_file_name: name, position: index + 1,
          status: index === 0 ? 'failed' : 'skipped', error_message: index === 0 ? 'Filament ran out' : 'Earlier job failed',
          batch_id: grouped ? 169 : null, batch_name: grouped ? 'Cube calibration batch' : null,
          filament_color: 'FF0000FF', filament_used_grams: 24, filament_type: 'PLA',
          print_time_seconds: 3600, created_by_username: 'operator',
          created_at: '2026-10-02T07:00:00Z', completed_at: '2026-10-02T09:00:00Z',
        }));
        await route.fulfill({ json: body });
      });
      await page.goto('/queue');
      await page.getByRole('button', { name: 'History 2', exact: true }).click();
      if (grouped) await page.getByRole('button', { name: /Cube calibration batch/ }).click();

      for (const [index, name] of names.entries()) {
        const disclosure = page.locator('summary').filter({ hasText: name });
        await expect(disclosure).toBeVisible();
        if (index === 0) {
          await disclosure.focus();
          await disclosure.press('Enter');
        } else if (width === 390) {
          const bounds = await disclosure.boundingBox();
          expect(bounds).not.toBeNull();
          await page.touchscreen.tap(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
        } else {
          await disclosure.click();
        }
        const visibleName = disclosure;
        await expect(visibleName).toHaveText(name);
        expect(await visibleName.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const bounds = element.getBoundingClientRect();
          return {
            fullTextFits: element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
            linesWithinViewport: [...range.getClientRects()].every((line) => line.left >= 0 && line.right <= innerWidth),
            wraps: range.getClientRects().length > 1,
            containerFits: bounds.left >= 0 && bounds.right <= innerWidth,
          };
        })).toEqual({ fullTextFits: true, linesWithinViewport: true, wraps: true, containerFits: true });
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await disclosure.press('Enter');
      }
      await expect(page.getByText('Filament ran out', { exact: true })).toBeVisible();
      await expect(page.getByText('Earlier job failed', { exact: true })).toBeVisible();
      await expect(page.locator('span').filter({ hasText: /^Failed$/ })).toBeVisible();
      await expect(page.locator('span').filter({ hasText: /^Skipped$/ })).toBeVisible();
      await expect(page.getByText('Tim Voron', { exact: true })).toHaveCount(2);
      await expect(page.getByText('24g PLA', { exact: true })).toHaveCount(2);
      await expect(page.getByText('operator', { exact: true })).toHaveCount(2);
      expect(writes).toEqual([]);
    });
  }
}
