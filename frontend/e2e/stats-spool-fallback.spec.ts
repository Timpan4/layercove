import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

interface StatsFixture {
  archiveGrams: number;
  spools: unknown[];
  smartPlugs: unknown[];
  authEnabled?: boolean;
  // HTTP status for the spools request; the default fulfils it with `spools`.
  spoolsStatus?: number;
  // No archived prints at all, as on a fresh install that only tracks spools.
  noArchives?: boolean;
}

const archiveStats = (totalFilamentGrams: number) => ({
  total_prints: 2, successful_prints: 2, failed_prints: 0, cancelled_prints: 0,
  total_print_time_hours: 3, total_filament_grams: totalFilamentGrams, total_cost: 0,
  prints_by_filament_type: {}, prints_by_printer: { '1': 2 }, average_time_accuracy: null,
  time_accuracy_by_printer: null, total_energy_kwh: 0, total_energy_cost: 0,
});

// Bambu prints archived without a 3MF carry no filament weight. Otherwise the
// archive grams are split across the two prints, as the trend cards sum them.
const archivedPrints = (archiveGrams: number) => [1, 2].map((id) => ({
  id, created_at: '2026-10-01T10:00:00Z', started_at: '2026-10-01T10:00:00Z',
  completed_at: '2026-10-01T11:00:00Z', print_name: `Bambu print ${id}`, status: 'completed',
  printer_id: 1, filament_type: 'PLA', filament_color: '#00FF00', filament_used_grams: archiveGrams / 2,
  actual_time_seconds: 3600, print_time_seconds: 3600, cost: 0, quantity: 1,
}));

const spool = (weightUsed: number, archivedAt: string | null = null, material = 'PLA') => ({
  id: 1, material, brand: 'Bambu Lab', color_name: 'Black', rgba: '000000FF',
  label_weight: 1000, weight_used: weightUsed, weight_used_baseline: 0,
  archived_at: archivedAt, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});

async function openStats(page: Page, fixture: StatsFixture) {
  const authEnabled = fixture.authEnabled === true;
  await page.addInitScript((authEnabled: boolean) => {
    localStorage.removeItem('bambusy-stats-timeframe');
    if (authEnabled) localStorage.setItem('auth_token', 'fictional-spool-token');
  }, authEnabled);
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      return route.fulfill({ status: 405, json: { detail: 'Read-only spool fallback fixture' } });
    }
    let body: unknown = [];
    if (path === '/api/v1/auth/status') body = { auth_enabled: authEnabled, requires_setup: false };
    if (path === '/api/v1/auth/me') body = { id: 901, username: 'Fixture Alice', permissions: ['stats:read', 'stats:filter_by_user', 'archives:read_all'], groups: [] };
    if (path === '/api/v1/users') body = [{ id: 901, username: 'Fixture Alice' }, { id: 902, username: 'Fixture Bob' }];
    if (path === '/api/v1/settings') body = { check_updates: false };
    if (path === '/api/v1/archives/stats') {
      body = fixture.noArchives
        ? { ...archiveStats(0), total_prints: 0, successful_prints: 0, total_print_time_hours: 0, prints_by_printer: {} }
        : archiveStats(fixture.archiveGrams);
    }
    if (path === '/api/v1/archives/slim') body = fixture.noArchives ? [] : archivedPrints(fixture.archiveGrams);
    if (path === '/api/v1/archives/analysis/failures') body = {
      period_days: 30, total_prints: 0, outcome_prints: 0, failed_prints: 0,
      failure_rate: 0, failures_by_reason: {}, failures_by_filament: {},
      failures_by_printer: {}, failures_by_hour: {}, recent_failures: [], trend: [],
    };
    if (path === '/api/v1/inventory/spools') {
      if (fixture.spoolsStatus !== undefined) {
        return route.fulfill({ status: fixture.spoolsStatus, json: { detail: 'Fixture denied the spools request' } });
      }
      body = fixture.spools;
    }
    if (path === '/api/v1/smart-plugs') body = fixture.smartPlugs;
    await route.fulfill({ json: body });
  });
  await page.goto('/stats');
  await expect(page.getByRole('heading', { name: 'Statistics', exact: true })).toBeVisible();
  await expect(page.getByText('Filament Used', { exact: true })).toBeVisible();
  // Let the spool and smart-plug queries settle before asserting on their absence.
  await page.waitForLoadState('networkidle');
}

async function applyCustomRange(page: Page) {
  await page.getByRole('button', { name: 'All Time', exact: true }).click();
  await page.getByRole('button', { name: 'Custom Range', exact: true }).click();
  await page.getByLabel('From', { exact: true }).fill('2026-10-01');
  await page.getByLabel('To', { exact: true }).fill('2026-10-31');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForLoadState('networkidle');
}

async function filterByUser(page: Page, username: string) {
  await page.getByRole('button', { name: 'All Users', exact: true }).click();
  await page.getByRole('button', { name: username, exact: true }).click();
  await page.waitForLoadState('networkidle');
}

// Quick Stats tiles: the label's parent holds the label, the value and any caption.
const tile = (page: Page, label: string) => page.getByText(label, { exact: true }).locator('xpath=..');
// Filament Trends cards: the caption sits below the header row, so use the card.
const card = (page: Page, label: string) => page.getByText(label, { exact: true }).locator('xpath=../..');
// By Material's header is an h4 inside the card's header row.
const byMaterial = (page: Page) => page.getByRole('heading', { name: 'By Material', exact: true }).locator('xpath=../..');

test.describe('Statistics filament fallback to spool tracking', () => {
  test('shows spool consumption with a caption when archives report no filament weight', async ({ page }) => {
    await openStats(page, {
      archiveGrams: 0,
      spools: [spool(500), spool(340, '2026-09-01T00:00:00Z')],
      smartPlugs: [],
    });

    const filament = tile(page, 'Filament Used');
    await expect(filament).toContainText('840g');
    await expect(filament).toContainText('from spool tracking');

    // Spool counters include prints that were never archived, so no per-print average, time
    // series or color split can be derived from them.
    const average = card(page, 'Avg per Print');
    await expect(average).toContainText('Not tracked');
    await expect(average).not.toContainText('420g');
    await expect(page.getByRole('heading', { name: 'Usage Over Time', exact: true }).locator('xpath=..')).toContainText('Not tracked');
    await expect(page.getByRole('heading', { name: 'Color Distribution', exact: true }).locator('xpath=../..')).toContainText('Not tracked');
  });

  test('shows the spool total and material split when no print was archived', async ({ page }) => {
    await openStats(page, {
      archiveGrams: 0,
      spools: [spool(500), spool(340, '2026-09-01T00:00:00Z', 'PETG')],
      smartPlugs: [],
      noArchives: true,
    });

    await expect(tile(page, 'Filament Used')).toContainText('840g');
    await expect(card(page, 'Period Filament')).toContainText('840g');
    const materials = byMaterial(page);
    await expect(materials).toContainText('500g');
    await expect(materials).toContainText('340g');
  });

  test('shows Not tracked instead of 0g when neither archives nor spools report filament', async ({ page }) => {
    await openStats(page, { archiveGrams: 0, spools: [spool(0)], smartPlugs: [] });

    const filament = tile(page, 'Filament Used');
    await expect(filament).toContainText('Not tracked');
    await expect(filament).not.toContainText('0g');
    await expect(filament).not.toContainText('from spool tracking');

    const average = card(page, 'Avg per Print');
    await expect(average).toContainText('Not tracked');
    await expect(average).not.toContainText('0g');
  });

  test('keeps the archive total and omits the caption when archives report filament', async ({ page }) => {
    await openStats(page, { archiveGrams: 5500, spools: [spool(840)], smartPlugs: [] });

    const filament = tile(page, 'Filament Used');
    await expect(filament).toContainText('5.5kg');
    await expect(filament).not.toContainText('from spool tracking');
  });

  test('keeps Period Filament and By Material on archive weight when archives report filament', async ({ page }) => {
    await openStats(page, { archiveGrams: 5500, spools: [spool(840)], smartPlugs: [] });

    const period = card(page, 'Period Filament');
    await expect(period).toContainText('5.5kg');
    await expect(period).not.toContainText('from spool tracking');

    const materials = byMaterial(page);
    await expect(materials).toContainText('5.5kg');
    await expect(materials).not.toContainText('from spool tracking');
  });

  test('shows Period Filament and By Material from spool consumption when archives report no weight', async ({ page }) => {
    await openStats(page, {
      archiveGrams: 0,
      spools: [spool(500), spool(340, '2026-09-01T00:00:00Z', 'PETG')],
      smartPlugs: [],
    });

    const period = card(page, 'Period Filament');
    await expect(period).toContainText('840g');
    await expect(period).toContainText('from spool tracking');

    const materials = byMaterial(page);
    await expect(materials).toContainText('PLA');
    await expect(materials).toContainText('500g');
    await expect(materials).toContainText('PETG');
    await expect(materials).toContainText('340g');
    await expect(materials).toContainText('from spool tracking');
  });

  test('shows Not tracked in Period Filament and By Material when neither source reports filament', async ({ page }) => {
    await openStats(page, { archiveGrams: 0, spools: [spool(0)], smartPlugs: [] });

    const period = card(page, 'Period Filament');
    await expect(period).toContainText('Not tracked');
    await expect(period).not.toContainText('0g');
    await expect(period).not.toContainText('for this range');

    const materials = byMaterial(page);
    await expect(materials).toContainText('Not tracked');
    await expect(materials).not.toContainText('PLA');
    await expect(materials).not.toContainText('from spool tracking');
  });

  test('shows Unavailable instead of Not tracked when the spools cannot be read', async ({ page }) => {
    await openStats(page, { archiveGrams: 0, spools: [], smartPlugs: [], spoolsStatus: 403 });

    await expect(tile(page, 'Filament Used')).toContainText('Unavailable');
    await expect(card(page, 'Avg per Print')).toContainText('Unavailable');
    await expect(card(page, 'Period Filament')).toContainText('Unavailable');
    await expect(page.getByText('Not tracked', { exact: true })).toHaveCount(0);
  });

  test('shows Not tracked for this range instead of the all-time spool total under a custom range', async ({ page }) => {
    await openStats(page, {
      archiveGrams: 0,
      spools: [spool(500), spool(340, '2026-09-01T00:00:00Z', 'PETG')],
      smartPlugs: [],
    });
    await applyCustomRange(page);

    const filament = tile(page, 'Filament Used');
    await expect(filament).toContainText('Not tracked for this range');
    await expect(filament).not.toContainText('840g');
    await expect(filament).not.toContainText('from spool tracking');

    await expect(card(page, 'Avg per Print')).toContainText('Not tracked for this range');
    await expect(card(page, 'Period Filament')).toContainText('Not tracked for this range');

    const materials = byMaterial(page);
    await expect(materials).toContainText('Not tracked for this range');
    await expect(materials).not.toContainText('from spool tracking');
  });

  test('shows Not tracked for this range instead of the all-time spool total under a user filter', async ({ page }) => {
    await openStats(page, { archiveGrams: 0, spools: [spool(840)], smartPlugs: [], authEnabled: true });
    await filterByUser(page, 'Fixture Alice');

    const filament = tile(page, 'Filament Used');
    await expect(filament).toContainText('Not tracked for this range');
    await expect(filament).not.toContainText('840g');
    await expect(filament).not.toContainText('from spool tracking');

    await expect(card(page, 'Period Filament')).toContainText('Not tracked for this range');
  });
});

test.describe('Statistics energy tiles', () => {
  test('hides Energy Used and Energy Cost when no smart plug is configured', async ({ page }) => {
    await openStats(page, { archiveGrams: 5500, spools: [], smartPlugs: [] });

    await expect(page.getByText('Energy Used', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Energy Cost', { exact: true })).toHaveCount(0);
  });

  test('keeps Energy Used and Energy Cost when a smart plug exists, even at zero', async ({ page }) => {
    await openStats(page, {
      archiveGrams: 5500,
      spools: [],
      smartPlugs: [{ id: 1, name: 'Printer plug', plug_type: 'tasmota', enabled: true }],
    });

    await expect(tile(page, 'Energy Used')).toContainText('0.000 kWh');
    await expect(tile(page, 'Energy Cost')).toBeVisible();
  });
});
