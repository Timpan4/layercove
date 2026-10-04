import { expect, test } from './test';

const appOrigin = new URL(process.env.LAYERCOVE_URL || 'http://localhost:8001').origin;
const printerId = 265;
const cameraId = 2651;
const cameraStopPath = `/api/v1/printers/${printerId}/camera/stop`;
const startupPosts = new Set([
  '/api/v1/auth/ws-token',
  '/api/v1/printers/camera/stream-token',
]);

test.use({ serviceWorkers: 'block', locale: 'en-US' });

const moonrakerCamera = {
  id: cameraId,
  printer_id: printerId,
  source: 'moonraker',
  source_uid: 'fixture-camera-2651',
  name: 'Fictional Voron camera',
  location: null,
  service: 'mjpegstreamer',
  camera_type: 'mjpeg',
  source_enabled: true,
  enabled: true,
  is_primary: true,
  rotation: 0,
  sort_order: 0,
  available: true,
  supported_live: true,
  snapshot_available: true,
  history: false,
  first_seen_at: '2026-10-01T00:00:00Z',
  last_seen_at: '2026-10-01T00:00:00Z',
  missing_since: null,
};

async function openCamera(page: import('@playwright/test').Page, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript(() => {
    localStorage.setItem('bambutrack_language', 'en');
  });
  await page.routeWebSocket((url) => url.origin === appOrigin, (socket) => socket.close());

  const nonGetRequests: string[] = [];
  const cameraGetPaths: string[] = [];
  let releaseSnapshot: (() => void) | undefined;
  let snapshotRequested: (() => void) | undefined;
  const snapshotRequest = new Promise<void>((resolve) => {
    snapshotRequested = resolve;
  });
  const snapshotBarrier = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });

  await page.route((url) => url.origin === appOrigin, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && startupPosts.has(path)) {
        return route.fulfill({ json: { token: 'fictional-camera-mode-token' } });
      }
      if (request.method() === 'POST' && path === cameraStopPath) {
        return route.fulfill({ json: { success: true } });
      }
      nonGetRequests.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Blocked by camera mode fixture' } });
    }

    if (/^\/api\/v1\/printers\/\d+\/(?:camera|cameras\/\d+)\/(?:stream|snapshot)$/.test(path)) {
      cameraGetPaths.push(path);
      if (path.endsWith('/snapshot')) {
        snapshotRequested?.();
        await snapshotBarrier;
      }
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/n7sAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    }

    let body: unknown = [];
    if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
    if (path === `/api/v1/printers/${printerId}`) {
      body = {
        id: printerId,
        name: 'Fictional Voron',
        model: 'Voron 2.4',
        provider: 'moonraker',
        is_active: true,
        camera_rotation: 0,
        capabilities: { camera: true },
      };
    }
    if (path === `/api/v1/printers/${printerId}/cameras`) body = [moonrakerCamera];
    if (path === `/api/v1/printers/${printerId}/status`) {
      body = { connected: true, state: 'IDLE', chamber_light: false, printable_objects_count: 0 };
    }
    return route.fulfill({ json: body });
  });

  await page.goto(`/camera/${printerId}`);
  const live = page.getByRole('button', { name: 'Live', exact: true });
  const snapshot = page.getByRole('button', { name: 'Snapshot', exact: true });
  await expect(page.getByRole('heading', { name: 'Fictional Voron', exact: true })).toBeVisible();
  await expect(live).toBeVisible();
  await expect(snapshot).toBeVisible();
  await expect.poll(() => page.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(live).toBeEnabled();
  await expect(snapshot).toBeEnabled();

  return {
    live,
    snapshot,
    nonGetRequests,
    cameraGetPaths,
    snapshotRequest,
    releaseSnapshot: () => releaseSnapshot?.(),
  };
}

for (const width of [390, 1440]) {
  test(`Camera mode buttons have a named group at ${width}px`, async ({ page }) => {
    const fixture = await openCamera(page, width);

    await expect.soft(page.getByRole('group', { name: 'Camera mode', exact: true })).toBeVisible();

    expect(fixture.cameraGetPaths).toContain(`/api/v1/printers/${printerId}/cameras/${cameraId}/stream`);
    expect(fixture.nonGetRequests.filter((request) => !startupPosts.has(request.replace(/^\w+ /, '')) && request !== `POST ${cameraStopPath}`)).toEqual([]);
  });

  test(`Camera mode reports its selected buttons and supports Enter and Space at ${width}px`, async ({ page }) => {
    const fixture = await openCamera(page, width);

    await expect.soft(fixture.live).toHaveAttribute('aria-pressed', 'true');
    await expect.soft(fixture.snapshot).toHaveAttribute('aria-pressed', 'false');

    await fixture.snapshot.focus();
    await fixture.snapshot.press('Enter');
    await fixture.snapshotRequest;
    await expect(fixture.live).toBeDisabled();
    await expect(fixture.snapshot).toBeDisabled();
    fixture.releaseSnapshot();
    await expect.poll(() => page.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect(fixture.snapshot).toBeEnabled();
    await expect.soft(fixture.snapshot).toHaveAttribute('aria-pressed', 'true');
    await expect.soft(fixture.live).toHaveAttribute('aria-pressed', 'false');

    await fixture.live.focus();
    const nextStreamRequest = page.waitForRequest((request) => request.method() === 'GET'
      && new URL(request.url()).pathname === `/api/v1/printers/${printerId}/cameras/${cameraId}/stream`);
    await fixture.live.press('Space');
    await nextStreamRequest;
    await expect.poll(() => page.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await expect.soft(fixture.live).toHaveAttribute('aria-pressed', 'true');
    await expect.soft(fixture.snapshot).toHaveAttribute('aria-pressed', 'false');

    expect(fixture.cameraGetPaths).toContain(`/api/v1/printers/${printerId}/cameras/${cameraId}/stream`);
    expect(fixture.cameraGetPaths).toContain(`/api/v1/printers/${printerId}/cameras/${cameraId}/snapshot`);
    expect(fixture.nonGetRequests.filter((request) => !startupPosts.has(request.replace(/^\w+ /, '')) && request !== `POST ${cameraStopPath}`)).toEqual([]);
  });
}
