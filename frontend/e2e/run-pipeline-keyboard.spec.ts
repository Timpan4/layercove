import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', locale: 'en-US' });

const filename = 'fixture-issue260-cube.stl';
const pipelineName = 'Fictional issue260 pipeline';
const eligibilityPath = '/api/v1/slicer-pipelines/260/check-eligibility';
const runPath = '/api/v1/slicer-pipelines/260/run';
const eligibilityRejection = {
  ok: false,
  target_kind: 'specific_printer',
  target_printer_id: 260,
  target_printer_name: 'Fictional printer 260',
  target_model_class: null,
  issues: [{ kind: 'printer_offline', slot_index: null, expected: null, actual: null }],
  printer_reports: [],
};

const pageFixtures = new WeakMap<Page, ReturnType<typeof installReadOnlyFixture>>();

function installReadOnlyFixture(page: Page, appOrigin: string) {
  const blockedWrites: string[] = [];
  let releaseEligibility!: () => void;
  let signalEligibility!: () => void;
  const eligibilityGate = new Promise<void>((resolve) => { releaseEligibility = resolve; });
  const eligibilityStarted = new Promise<void>((resolve) => { signalEligibility = resolve; });

  const routeSetup = Promise.all([
    page.routeWebSocket(/.*/, (socket: { close: () => void }) => socket.close()),
    page.route((url) => url.origin === appOrigin && url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/\/$/, '');
      if (request.method() !== 'GET') {
        if (request.method() === 'POST' && (path === '/api/v1/auth/ws-token' || path === '/api/v1/printers/camera/stream-token')) {
          await route.fulfill({ json: { token: 'fictional-issue260-token' } });
          return;
        }
        blockedWrites.push(`${request.method()} ${path}`);
        if (request.method() === 'POST' && path === eligibilityPath) {
          signalEligibility();
          await eligibilityGate;
          await route.fulfill({ json: eligibilityRejection });
          return;
        }
        await route.fulfill({ status: 405, json: { detail: 'Read-only issue260 browser fixture' } });
        return;
      }

      let body: unknown = [];
      if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
      if (path === '/api/v1/settings') body = { check_updates: false, use_slicer_api: true, pipeline_max_copies: 50 };
      if (path === '/api/v1/slicer/capabilities') body = { capabilities: { process_schema: false } };
      if (path === '/api/v1/library/files') body = [{
        id: 260,
        filename,
        file_type: 'stl',
        file_size: 2048,
        folder_id: null,
        thumbnail_path: null,
        print_name: null,
        print_count: 0,
        duplicate_count: 0,
        created_at: '2026-10-04T00:00:00Z',
        tags: [],
      }];
      if (path === '/api/v1/library/stats') body = { total_files: 1, total_folders: 0, total_size_bytes: 2048 };
      if (path === '/api/v1/library/trash') body = { total: 0, items: [] };
      if (path === '/api/v1/slicer-pipelines') body = { pipelines: [{
        id: 260,
        name: pipelineName,
        description: null,
        printer_preset: { id: 260, name: 'Fictional printer preset' },
        process_preset: { id: 260, name: 'Fictional process preset' },
        filament_presets: [],
        bed_type: null,
        target_kind: 'specific_printer',
        target_printer_id: 260,
        target_model_class: null,
        fanout_strategy: 'max_parallel',
        created_by: null,
        created_at: '2026-10-04T00:00:00Z',
        updated_at: '2026-10-04T00:00:00Z',
      }] };
      if (path === '/api/v1/printers') body = [{ id: 260, name: 'Fictional printer 260' }];
      await route.fulfill({ json: body });
    }),
  ]);

  return { blockedWrites, eligibilityStarted, releaseEligibility, routeSetup };
}

async function openPipelinePicker(page: Page) {
  const actionsTrigger = page.getByRole('button', { name: `Actions: ${filename}`, exact: true });
  await expect(actionsTrigger).toBeVisible();
  await actionsTrigger.click();
  await page.getByRole('button', { name: 'Run with pipeline', exact: true }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Run with pipeline', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: pipelineName, exact: false })).toBeVisible();
  await expect(dialog.getByRole('spinbutton', { name: 'Copies', exact: true })).toHaveValue('1');
  return { actionsTrigger, dialog };
}

for (const width of [1440, 390]) {
  test.describe(`Run with pipeline keyboard behavior at ${width}px`, () => {
    test.beforeEach(async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        localStorage.setItem('bambutrack_language', 'en');
        localStorage.setItem('bambuddy_appliance_locale_consumed', '1');
      });
      const fixture = installReadOnlyFixture(page, new URL(testInfo.project.use.baseURL!).origin);
      pageFixtures.set(page, fixture);
      await fixture.routeSetup;
      await page.goto('/files');
      await expect(page.getByRole('heading', { name: 'File Manager', exact: true })).toBeVisible();
    });

    test.afterEach(async ({ page }) => {
      const fixture = pageFixtures.get(page)!;
      fixture.releaseEligibility();
      await page.unrouteAll({ behavior: 'wait' });
      expect.soft(fixture.blockedWrites.filter((request) => request !== `POST ${eligibilityPath}`)).toEqual([]);
    });

    test('opens the named picker with focus inside from the File Manager actions menu', async ({ page }) => {
      const { dialog } = await openPipelinePicker(page);
      await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
      await expect(dialog.getByRole('spinbutton', { name: 'Copies', exact: true })).toHaveValue('1');
      await expect(dialog.getByRole('button', { name: pipelineName, exact: false })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Report a Bug', exact: true })).toBeVisible();
    });

    test('contains Tab and Shift+Tab within the idle picker', async ({ page }) => {
      const { dialog } = await openPipelinePicker(page);
      const first = dialog.getByRole('button', { name: 'Close', exact: true });
      const last = dialog.getByRole('button', { name: pipelineName, exact: false });
      await last.focus();
      await page.keyboard.press('Tab');
      await expect.poll(() => first.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.keyboard.press('Shift+Tab');
      await expect.poll(() => last.evaluate((element) => document.activeElement === element)).toBe(true);
      await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    });

    test('Escape closes the idle picker and restores focus to the File Manager actions trigger', async ({ page }) => {
      const { actionsTrigger, dialog } = await openPipelinePicker(page);
      await dialog.getByRole('spinbutton', { name: 'Copies', exact: true }).focus();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => actionsTrigger.evaluate((element) => document.activeElement === element)).toBe(true);
      await expect(page.getByRole('button', { name: 'Run with pipeline', exact: true })).toHaveCount(0);
    });

    test('keeps dismissal blocked while eligibility is pending without dispatching a run', async ({ page }) => {
      const fixture = pageFixtures.get(page)!;
      const { dialog } = await openPipelinePicker(page);
      const eligibilityResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === eligibilityPath,
      );
      try {
        await dialog.getByRole('button', { name: pipelineName, exact: false }).click();
        await fixture.eligibilityStarted;
        await expect(dialog.getByText('Loading…', { exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
        await dialog.click({ position: { x: 1, y: 1 } });
        await expect(dialog).toBeVisible();
      } finally {
        fixture.releaseEligibility();
      }
      const response = await eligibilityResponse;
      expect(response.status()).toBe(200);
      expect(fixture.blockedWrites).toContain(`POST ${eligibilityPath}`);
      expect(fixture.blockedWrites).not.toContain(`POST ${runPath}`);
      expect(fixture.blockedWrites.filter((request) => /\/(?:run|slice|print)(?:\/|$)/.test(request))).toEqual([]);
    });
  });
}
