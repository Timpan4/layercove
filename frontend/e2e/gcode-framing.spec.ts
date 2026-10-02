import type { PerspectiveCamera, Scene, Vector3 } from 'three';
import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

const gcode = ['G90', 'M82', 'G0 X40 Y50 Z0.28', 'G1 X60 Y50 E1', 'G1 X60 Y70 E2', 'G1 X40 Y70 E3', 'G1 X40 Y50 E4', 'G0 Z10', 'G1 X60 Y50 E5', 'G1 X60 Y70 E6', 'G1 X40 Y70 E7', 'G1 X40 Y50 E8', ''].join('\n');
const secondGcode = ['G90', 'M82', 'G0 X200 Y210 Z0.28', 'G1 X210 Y210 E1', 'G1 X210 Y220 E2', 'G1 X200 Y220 E3', 'G1 X200 Y210 E4', ''].join('\n');

interface ViewerWindow extends Window {
  THREE: typeof import('three');
  myScene?: Scene;
  myCameraControls?: { _camera: PerspectiveCamera; getTarget(): Vector3 };
  BambuddyPrettyGCode: { loadLibraryFile(id: number): void };
}

async function installViewer(page: import('@playwright/test').Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/gcode')) {
      await route.fulfill({ contentType: 'text/plain', body: url.pathname.includes('/78/') ? secondGcode : gcode });
      return;
    }
    const body = url.pathname.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
      : url.pathname.endsWith('/library/files/77') ? { id: 77, filename: 'off-center-cube.gcode' }
      : url.pathname.includes('/plugin/') ? { orbitWhenIdle: false, showMirror: false, showNozzle: false }
      : [];
    await route.fulfill({ json: body });
  });
}

async function isToolpathFramed(frame: import('@playwright/test').Frame, bounds = { x: [40, 60], y: [50, 70], z: [0.28, 10] }) {
  return frame.evaluate((bounds) => {
    const viewer = window as unknown as ViewerWindow;
    const camera = viewer.myCameraControls?._camera;
    const object = viewer.myScene?.getObjectByName('gcode');
    if (!camera || !object?.children.length) return false;
    // Project the fixture's extrusion bounds, not the fat-line base mesh.
    for (const x of bounds.x) {
      for (const y of bounds.y) {
        for (const z of bounds.z) {
          const projected = new viewer.THREE.Vector3(x, y, z).project(camera);
          if (![projected.x, projected.y, projected.z].every(Number.isFinite)
            || Math.abs(projected.x) >= 1 || Math.abs(projected.y) >= 1 || Math.abs(projected.z) >= 1) return false;
        }
      }
    }
    return true;
  }, bounds);
}

for (const width of [1280, 390]) {
  test(`standalone preview fits the off-center toolpath when opened and reset at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installViewer(page);
    await page.goto('/gcode-viewer/?library_file=77');
    const iframe = page;
    await expect(iframe.getByText('off-center-cube.gcode', { exact: true })).toBeVisible();
    const frame = page.mainFrame();
    await expect.poll(() => isToolpathFramed(frame)).toBe(true);
    await iframe.locator('#mycanvas').dragTo(iframe.locator('#mycanvas'), {
      sourcePosition: { x: 100, y: 100 }, targetPosition: { x: 200, y: 200 },
    });
    await iframe.getByRole('button', { name: 'Reset view', exact: true }).click();
    await expect.poll(() => isToolpathFramed(frame)).toBe(true);
    const target = await frame.evaluate(() => {
      const center = (window as unknown as ViewerWindow).myCameraControls!.getTarget();
      return { x: center.x, y: center.y };
    });
    expect(target).toEqual({ x: 50, y: 60 });
    await frame.evaluate(() => (window as unknown as ViewerWindow).BambuddyPrettyGCode.loadLibraryFile(78));
    await expect.poll(async () => frame.evaluate(() => {
      const center = (window as unknown as ViewerWindow).myCameraControls!.getTarget();
      return { x: center.x, y: center.y };
    })).toEqual({ x: 205, y: 215 });
    await expect.poll(() => isToolpathFramed(frame, { x: [200, 210], y: [210, 220], z: [0.28] })).toBe(true);
  });
}
