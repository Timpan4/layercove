import { test, expect } from './test';

test.use({ serviceWorkers: 'block', locale: 'en-US' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:18125').origin;
const allowedStartupPosts = new Set([
  'POST /api/v1/printers/camera/stream-token',
  'POST /api/v1/auth/ws-token',
]);

const filamentTargets = [
  ['PA-CF', 55], ['PA', 50], ['PC', 50], ['PC-FR', 50],
  ['ABS', 45], ['ASA', 45], ['PETG-CF', 40], ['PETG', 0],
  ['PLA', 0], ['TPU', 0], ['PVA', 0], ['Other / unmapped', 0],
] as const;

for (const width of [390, 1440]) {
  test(`Workflow preheat controls expose their captions at ${width}px`, async ({ page }) => {
    const writes: string[] = [];
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.addInitScript(() => localStorage.setItem('bambutrack_language', 'en'));
    await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== appOrigin) {
        return route.abort();
      }
      return route.continue();
    });
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/\/+$/, '');
      if (request.method() !== 'GET') {
        writes.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 405, json: { detail: 'Read-only Workflow fixture' } });
      }

      const body = path.endsWith('/auth/status')
        ? { auth_enabled: false, requires_setup: false }
        : path.endsWith('/settings')
          ? {
            language: 'en', date_format: 'system', time_format: 'system', currency: 'USD',
            preheat_enabled: false, preheat_max_wait_seconds: 900, preheat_soak_seconds: 300,
            preheat_filament_targets: '',
          }
          : [];
      return route.fulfill({ json: body });
    });

    await page.goto('/settings?tab=queue&sub=dispatch');
    const card = page.locator('#card-preheat');
    await expect(card.getByRole('heading', { name: 'Preheat & Heat Soak', exact: true })).toBeVisible();

    const filamentNames = filamentTargets.map(([filament]) => `${filament} °C`);
    const expectedControls = [
      { role: 'checkbox' as const, name: 'Enable preheat & soak' },
      { role: 'spinbutton' as const, name: 'Max wait (seconds)' },
      { role: 'spinbutton' as const, name: 'Soak (seconds)' },
      ...filamentNames.map((name) => ({ role: 'spinbutton' as const, name })),
    ];
    const missingNames = await Promise.all(expectedControls.map(async ({ role, name }) =>
      (await card.getByRole(role, { name, exact: true }).count()) === 0 ? name : null,
    ));
    expect(missingNames.filter(Boolean)).toEqual([]);

    const enabled = card.getByRole('checkbox', { name: 'Enable preheat & soak', exact: true });
    await expect(enabled).toBeVisible();
    await expect(enabled).not.toBeChecked();

    for (const [caption, value, min, max] of [
      ['Max wait (seconds)', '900', '60', '3600'],
      ['Soak (seconds)', '300', '0', '1800'],
    ]) {
      const field = card.getByRole('spinbutton', { name: caption, exact: true });
      await expect(field).toBeVisible();
      await expect(field).toBeDisabled();
      await expect(field).toHaveValue(value);
      await expect(field).toHaveAttribute('min', min);
      await expect(field).toHaveAttribute('max', max);
    }

    for (const [filament, value] of filamentTargets) {
      const caption = `${filament} °C`;
      const field = card.getByRole('spinbutton', { name: caption, exact: true });
      await expect(field).toBeVisible();
      await expect(field).toBeDisabled();
      await expect(field).toHaveValue(String(value));
      await expect(field).toHaveAttribute('min', '0');
      await expect(field).toHaveAttribute('max', '60');
    }

    expect(writes.filter((write) => !allowedStartupPosts.has(write))).toEqual([]);
  });
}
