import { test, expect } from './test';

test.use({ serviceWorkers: 'block' });

for (const mode of ['light', 'dark']) {
  test(`History outcomes have readable text in ${mode} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript((theme) => localStorage.setItem('theme-mode', theme), mode);
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
      let body: unknown = [];
      if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
      if (path.endsWith('/settings')) body = { check_updates: false };
      if (path === '/api/v1/queue') body = ['completed', 'failed', 'skipped', 'cancelled'].map((status, index) => ({
        id: index + 1, printer_id: null, archive_id: null, library_file_id: index + 1,
        library_file_name: `${status} cube`, position: index + 1, status,
        created_at: '2026-10-02T07:00:00Z', completed_at: '2026-10-02T09:00:00Z',
      }));
      await route.fulfill({ json: body });
    });
    await page.goto('/queue');
    await page.getByRole('button', { name: 'History 4', exact: true }).click();

    for (const outcome of ['Completed', 'Failed', 'Skipped', 'Cancelled']) {
      const label = page.locator('span').filter({ hasText: new RegExp(`^${outcome}$`) });
      await expect(label).toBeVisible();
      const contrast = await label.evaluate((element) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d')!;
        const rgba = (color: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const luminance = (rgb: number[]) => {
          const linear = rgb.slice(0, 3).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        };
        const foreground = luminance(rgba(getComputedStyle(element).color));
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          const background = rgba(getComputedStyle(ancestor).backgroundColor);
          if (background[3] === 255) {
            const behind = luminance(background);
            return (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05);
          }
        }
        throw new Error('No opaque background found for History outcome');
      });
      // WCAG 2.2 SC1.4.3, normal text: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
      expect(contrast, `${outcome} text contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
