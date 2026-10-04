import { test, expect } from './test';
import type { Locator, Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', locale: 'en-US', colorScheme: 'light' });

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const allowedStartupPosts = new Set([
  'POST /api/v1/auth/ws-token',
  'POST /api/v1/printers/camera/stream-token',
]);

const printers = [
  {
    id: 1,
    name: 'Fixture Voron',
    provider: 'moonraker',
    model: 'Voron 2.4',
    location: 'Fixture lab',
    is_active: true,
    auto_archive: false,
    nozzle_count: 1,
    external_camera_enabled: false,
    capabilities: {
      camera: false,
      ams: false,
      start_print: false,
      extruder_temperature: false,
      bed_temperature: false,
      chamber_temperature: false,
    },
  },
  {
    id: 2,
    name: 'Fixture Bambu',
    provider: 'bambu',
    model: 'P1S',
    location: 'Fixture lab',
    is_active: true,
    auto_archive: false,
    nozzle_count: 1,
    external_camera_enabled: false,
    capabilities: { camera: false, ams: false, start_print: false },
  },
];

const statuses: Record<number, Record<string, unknown>> = {
  1: {
    connected: true,
    state: 'IDLE',
    progress: 0,
    remaining_time: 0,
    current_print: null,
    gcode_file: null,
    vt_tray: [],
    ams: [],
    temperatures: { nozzle: 27.2, bed: 24.3, chamber: 25.4 },
  },
  2: {
    connected: true,
    state: 'IDLE',
    progress: 0,
    remaining_time: 0,
    current_print: null,
    gcode_file: null,
    vt_tray: [],
    ams: [],
    temperatures: { nozzle: 28, bed: 23 },
  },
};

function rgbFromHex(token: string) {
  const match = token.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!match) throw new Error(`Expected a six-digit theme color token, received ${token}`);
  return `rgb(${match.slice(1).map((channel) => Number.parseInt(channel, 16)).join(', ')})`;
}

async function openCommandDeck(page: Page, width: number) {
  const blockedWrites: string[] = [];
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript(() => {
    localStorage.setItem('theme-mode', 'dark');
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.routeWebSocket((url) => url.origin === appOrigin && url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route((url) => url.origin === appOrigin, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      const requestKey = `${request.method()} ${path}`;
      if (allowedStartupPosts.has(requestKey)) {
        return route.fulfill({ json: { token: 'fictional-command-deck-token' } });
      }
      blockedWrites.push(requestKey);
      return route.fulfill({ status: 405, json: { detail: 'Read-only command deck theme fixture' } });
    }

    if (!path.startsWith('/api/')) return route.continue();

    let body: unknown = [];
    if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
    if (path === '/api/v1/settings') body = { language: 'en', check_updates: false };
    if (path === '/api/v1/printers') body = printers;
    const statusMatch = path.match(/^\/api\/v1\/printers\/(\d+)\/status$/);
    if (statusMatch) body = statuses[Number(statusMatch[1])] ?? {};
    return route.fulfill({ json: body });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Command deck', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inspect Fixture Voron', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspect Fixture Voron', exact: true })).toHaveAttribute('aria-current', 'true');
  return blockedWrites;
}

async function switchMode(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name, exact: true }).click();
}

// Read actual computed paints. The installed light palette defines the page,
// raised surface and inset surface colors. Accept those existing colors, with
// existing transparency, rather than inventing a brightness or contrast gate.
async function expectLightSurface(surface: Locator) {
  const result = await surface.evaluate((element) => {
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const colors = [style.backgroundColor, ...style.backgroundImage.matchAll(/rgba?\([^)]*\)/g)].map((value) => typeof value === 'string' ? value : value[0]);
    const paints = colors.flatMap((value) => {
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      if (channels.length < 3 || channels[3] === 0) return [];
      return [`rgb(${channels.slice(0, 3).join(', ')})`];
    });
    return {
      paints,
      palette: ['--bg-primary', '--bg-secondary', '--bg-tertiary'].map((token) => root.getPropertyValue(token).trim()),
    };
  });
  const palette = result.palette.map(rgbFromHex);
  for (const paint of result.paints) {
    expect.soft(palette, 'Rendered paint should use the installed light surface palette').toContain(paint);
  }
}

async function captureDarkAppearance(page: Page) {
  return page.evaluate(() => {
    const colors = (element: Element) => {
      const style = getComputedStyle(element);
      return { backgroundImage: style.backgroundImage, backgroundColor: style.backgroundColor, color: style.color };
    };
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing theme surface: ${selector}`);
      return colors(element);
    };
    const contentText = [];
    for (const surface of document.querySelectorAll('article[aria-label="Inspect Fixture Bambu"], section.lc-glass')) {
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.textContent?.trim() && node.parentElement) {
          contentText.push({ text: node.textContent, ...colors(node.parentElement) });
        }
      }
    }
    return {
      filter: read('main > div.lc-glass'),
      card: read('article[aria-label="Inspect Fixture Bambu"]'),
      detail: read('section.lc-glass'),
      search: read('main > div.lc-glass input[type="search"]'),
      cardName: read('article[aria-label="Inspect Fixture Bambu"] h2'),
      detailName: read('section.lc-glass h1'),
      readyChip: read('article[aria-label="Inspect Fixture Bambu"] h2 + span'),
      primaryAction: read('section.lc-glass header button'),
      filterControls: Array.from(document.querySelectorAll('main > div.lc-glass select, main > div.lc-glass button'), colors),
      contentText,
    };
  });
}

for (const width of [390, 1440]) {
  test(`production Command Deck follows light and dark theme at ${width}px`, async ({ page }) => {
    const blockedWrites = await openCommandDeck(page, width);
    await page.getByRole('button', { name: 'Inspect Fixture Bambu', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Inspect Fixture Bambu', exact: true })).toHaveAttribute('aria-current', 'true');
    const darkAppearance = await captureDarkAppearance(page);
    await switchMode(page, 'Switch to light mode');
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(245, 245, 245)');
    const lightTokens = await page.evaluate(() => ({
      page: getComputedStyle(document.body).backgroundColor,
      surface: getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim(),
      primaryText: getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim(),
      mutedText: getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim(),
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    }));
    expect(lightTokens.page).toBe('rgb(245, 245, 245)');
    expect(lightTokens.surface).toBe('#ffffff');
    expect(lightTokens.primaryText).toBe('#1a1a1a');
    expect(lightTokens.mutedText).toBe('#6b6b6b');
    expect(lightTokens.accent).toBe('#00ae42');

    // The input, state text and primary inspect action expose the affected text
    // families. Text and action colors are checked against existing tokens.
    const search = page.locator('main > div.lc-glass input[type="search"]');
    await expect(search).toBeVisible();
    expect.soft(await search.evaluate((element) => getComputedStyle(element).color)).toBe(rgbFromHex(lightTokens.primaryText));
    await expectLightSurface(page.locator('main > div.lc-glass'));
    await expectLightSurface(page.locator('article[aria-label="Inspect Fixture Bambu"]'));
    await expectLightSurface(page.locator('section.lc-glass'));
    await expectLightSurface(search);
    const filterControls = ['Status', 'Location', 'Sort'].map((name) => page.getByRole('combobox', { name, exact: true }));
    filterControls.push(page.getByRole('button', { name: 'Hide offline', exact: true }));
    for (const control of filterControls) {
      await expect(control).toBeVisible();
      expect.soft(await control.evaluate((element) => getComputedStyle(element).color)).toBe(rgbFromHex(lightTokens.primaryText));
      await expectLightSurface(control);
    }

    const card = page.getByRole('button', { name: 'Inspect Fixture Bambu', exact: true });
    for (const text of ['Nozzle', 'Bed', 'Filament']) {
      const caption = card.getByText(text, { exact: true });
      await expect(caption).toBeVisible();
      expect.soft(await caption.evaluate((element) => getComputedStyle(element).color))
        .toBe(rgbFromHex(lightTokens.mutedText));
    }
    // These job and telemetry values come from the fictional idle printer.
    for (const text of ['No active job', '28°C', '23°C', 'External']) {
      const content = card.getByText(text, { exact: true });
      await expect(content).toBeVisible();
      expect.soft(await content.evaluate((element) => getComputedStyle(element).color))
        .toBe(rgbFromHex(lightTokens.primaryText));
    }
    expect.soft(await card.getByRole('heading', { name: 'Fixture Bambu', exact: true }).evaluate((element) => getComputedStyle(element).color))
      .toBe(rgbFromHex(lightTokens.primaryText));
    await expect(card.getByText('Ready for next job', { exact: true })).toBeVisible();
    expect.soft(await card.getByText('Ready for next job', { exact: true }).evaluate((element) => getComputedStyle(element).color))
      .toBe(rgbFromHex(lightTokens.mutedText));
    const readyChip = card.locator('h2').locator('..').getByText('Ready', { exact: true });
    await expect(readyChip).toBeVisible();
    // The state label follows the existing light text palette; its separate
    // colored status dot can retain the printer-state color.
    expect.soft([rgbFromHex(lightTokens.primaryText), rgbFromHex(lightTokens.mutedText)])
      .toContain(await readyChip.evaluate((element) => getComputedStyle(element).color));
    expect.soft(await card.getByText('Inspect', { exact: true }).evaluate((element) => getComputedStyle(element).color))
      .toBe(rgbFromHex(lightTokens.accent));

    const detail = page.locator('section.lc-glass');
    const detailState = detail.locator('header').getByText('Ready', { exact: true });
    await expect(detailState).toBeVisible();
    expect.soft([rgbFromHex(lightTokens.primaryText), rgbFromHex(lightTokens.mutedText)])
      .toContain(await detailState.evaluate((element) => getComputedStyle(element).color));
    const detailProgress = detail.getByText('0%', { exact: true });
    await expect(detailProgress).toBeVisible();
    expect.soft(await detailProgress.evaluate((element) => getComputedStyle(element).color))
      .toBe(rgbFromHex(lightTokens.primaryText));
    for (const text of ['No active job', '28°', '23°', 'Online', 'Choose a file to print', 'No action needed']) {
      const content = detail.getByText(text, { exact: true });
      await expect(content).toBeVisible();
      expect.soft(await content.evaluate((element) => getComputedStyle(element).color))
        .toBe(rgbFromHex(lightTokens.primaryText));
    }
    expect.soft(await detail.getByText('Next best action', { exact: true }).evaluate((element) => getComputedStyle(element).color))
      .toBe(rgbFromHex(lightTokens.mutedText));
    await expect(detail.getByRole('heading', { name: 'Fixture Bambu', exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Open controls', exact: true })).toBeVisible();
    expect.soft(await detail.getByRole('heading', { name: 'Fixture Bambu', exact: true }).evaluate((element) => getComputedStyle(element).color))
      .toBe(rgbFromHex(lightTokens.primaryText));
    const primaryActionColors = await detail.getByRole('button', { name: 'Open controls', exact: true }).evaluate((element) => {
      const style = getComputedStyle(element);
      return { foreground: style.color, background: style.backgroundColor };
    });
    expect.soft(primaryActionColors.foreground).toBe(rgbFromHex(lightTokens.primaryText));
    expect.soft(primaryActionColors.background).toBe(rgbFromHex(lightTokens.accent));

    await switchMode(page, 'Switch to system mode');
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('theme-mode'))).toBe('system');
    await switchMode(page, 'Switch to dark mode');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(lightTokens.page);
    await expect(page.getByRole('button', { name: 'Inspect Fixture Bambu', exact: true })).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => captureDarkAppearance(page)).toEqual(darkAppearance);
    expect(blockedWrites).toEqual([]);
  });
}
