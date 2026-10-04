import { expect, test } from './test';

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const printerId = 263;
const diagnosisPath = `/api/v1/printers/${printerId}/camera/diagnose`;
const cameraStopPath = `/api/v1/printers/${printerId}/camera/stop`;
const startupPosts = new Set([
  '/api/v1/auth/ws-token',
  '/api/v1/printers/camera/stream-token',
]);
const diagnosticStageCode = 'FIXTURE_263_STAGE_OK';
const cameraImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/n7sAAAAASUVORK5CYII=',
  'base64',
);

test.use({ serviceWorkers: 'block', locale: 'en-US' });

type CameraDiagnosisFixture = {
  opener: import('@playwright/test').Locator;
  heading: import('@playwright/test').Locator;
  modalPanel: import('@playwright/test').Locator;
  diagnosticRequests: string[];
  initialDiagnosticCount: number;
  blockedWrites: string[];
};

async function openCameraDiagnosis(
  page: import('@playwright/test').Page,
  width: number,
): Promise<CameraDiagnosisFixture> {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript(() => {
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.routeWebSocket((url) => url.origin === appOrigin, (socket) => socket.close());

  const diagnosticRequests: string[] = [];
  const blockedWrites: string[] = [];
  await page.route((url) => url.origin === appOrigin, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && startupPosts.has(path)) {
        return route.fulfill({ json: { token: 'fictional-camera-diagnosis-token' } });
      }
      if (request.method() === 'POST' && path === diagnosisPath) {
        diagnosticRequests.push(`${request.method()} ${path}`);
        return route.fulfill({
          json: {
            printer_id: printerId,
            protocol: 'rtsp',
            port: 8554,
            profile: 'default',
            overall_status: 'ok',
            stages: [
              {
                name: 'tcp_reachable',
                status: 'ok',
                duration_ms: 1,
                code: diagnosticStageCode,
              },
            ],
            summary_code: 'all_ok',
          },
        });
      }
      if (request.method() === 'POST' && path === cameraStopPath) {
        return route.fulfill({ json: { success: true } });
      }

      blockedWrites.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Blocked by camera diagnosis fixture' } });
    }

    if (path.startsWith('/api/v1/')) {
      if (path === `/api/v1/printers/${printerId}/camera/stream`) {
        return route.fulfill({ status: 200, contentType: 'image/png', body: cameraImage });
      }

      let body: unknown = [];
      if (path === '/api/v1/auth/status') {
        body = { auth_enabled: false, requires_setup: false };
      } else if (path === `/api/v1/printers/${printerId}`) {
        body = {
          id: printerId,
          name: 'Fictional camera printer 263',
          model: 'Fictional camera fixture',
          provider: 'bambu',
          is_active: true,
          camera_rotation: 0,
          capabilities: { camera: true },
        };
      } else if (path === `/api/v1/printers/${printerId}/status`) {
        body = { connected: true, state: 'IDLE', chamber_light: false, printable_objects_count: 0 };
      } else if (path === '/api/v1/system/appliance') {
        body = null;
      }
      return route.fulfill({ json: body });
    }

    return route.continue();
  });

  await page.goto(`/camera/${printerId}`);
  await expect(page.getByRole('heading', { name: 'Fictional camera printer 263', exact: true })).toBeVisible();
  await expect.poll(() =>
    page.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
  ).toBe(true);

  const opener = page.getByTitle('Diagnose', { exact: true });
  await expect(opener).toBeVisible();
  await expect(opener).toBeEnabled();

  // Exercise the actual native button activation. The modal intentionally starts
  // its diagnostic on mount, so wait for and track that fixture response.
  await opener.focus();
  const initialDiagnostic = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && new URL(response.url()).origin === appOrigin
    && new URL(response.url()).pathname === diagnosisPath,
  );
  await opener.press('Enter');
  await initialDiagnostic;

  const heading = page.getByRole('heading', { name: 'Camera diagnostic', exact: true });
  await expect(heading).toBeVisible();
  await expect(page.getByText(diagnosticStageCode, { exact: true })).toBeVisible();

  // React StrictMode may replay mount effects in development. Take the baseline
  // only after the real mount result has rendered, then ensure keyboard and
  // dismissal handling add no diagnostic request of their own.
  const initialDiagnosticCount = diagnosticRequests.length;
  const modalPanel = heading.locator('xpath=../../..');

  return { opener, heading, modalPanel, diagnosticRequests, initialDiagnosticCount, blockedWrites };
}

async function expectNoFocusDiagnosticSideEffect(fixture: CameraDiagnosisFixture) {
  expect(fixture.diagnosticRequests).toHaveLength(fixture.initialDiagnosticCount);
  expect(fixture.blockedWrites).toEqual([]);
}

for (const width of [390, 1440]) {
  test(`Camera diagnosis exposes a named modal at ${width}px`, async ({ page }) => {
    const fixture = await openCameraDiagnosis(page, width);

    const dialog = page.getByRole('dialog', { name: 'Camera diagnostic', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expectNoFocusDiagnosticSideEffect(fixture);
  });

  test(`Camera diagnosis moves initial focus inside the overlay at ${width}px`, async ({ page }) => {
    const fixture = await openCameraDiagnosis(page, width);

    await expect.poll(() =>
      fixture.modalPanel.evaluate((panel) => panel.contains(document.activeElement)),
    ).toBe(true);
    await expectNoFocusDiagnosticSideEffect(fixture);
  });

  test(`Camera diagnosis contains Tab and Shift+Tab at both boundaries at ${width}px`, async ({ page }) => {
    const fixture = await openCameraDiagnosis(page, width);
    const modalButtons = fixture.modalPanel.locator('button');
    const firstButton = modalButtons.first();
    const lastButton = modalButtons.last();

    await lastButton.focus();
    await lastButton.press('Tab');
    await expect(firstButton).toBeFocused();

    await firstButton.press('Shift+Tab');
    await expect(lastButton).toBeFocused();
    await expectNoFocusDiagnosticSideEffect(fixture);
  });

  test(`Camera diagnosis Close dismisses and restores focus at ${width}px`, async ({ page }) => {
    const fixture = await openCameraDiagnosis(page, width);

    await fixture.modalPanel.locator('button').last().click();
    await expect(fixture.heading).toBeHidden();
    await expect(fixture.opener).toBeFocused();
    await expectNoFocusDiagnosticSideEffect(fixture);
  });

  test(`Camera diagnosis keeps Escape dismissal and focus restoration at ${width}px`, async ({ page }) => {
    const fixture = await openCameraDiagnosis(page, width);

    await fixture.modalPanel.locator('button').first().focus();
    await page.keyboard.press('Escape');
    await expect(fixture.heading).toBeHidden();
    await expect(fixture.opener).toBeFocused();
    await expectNoFocusDiagnosticSideEffect(fixture);
  });

  test(`Camera diagnosis keeps pointer dismissal and focus restoration at ${width}px`, async ({ page }) => {
    const fixture = await openCameraDiagnosis(page, width);

    await fixture.modalPanel.locator('button').first().focus();
    const backdrop = fixture.heading.locator('xpath=../../../../');
    await backdrop.click({ position: { x: 1, y: 1 } });
    await expect(fixture.heading).toBeHidden();
    await expect(fixture.opener).toBeFocused();
    await expectNoFocusDiagnosticSideEffect(fixture);
  });
}