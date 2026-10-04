import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const file = {
  id: 259,
  filename: 'fictional-displayed-name-part.stl',
  file_type: 'stl',
  file_size: 1024,
  folder_id: null,
  thumbnail_path: null,
  print_name: 'Fictional displayed part',
  print_count: 0,
  duplicate_count: 0,
  created_at: '2026-10-01T00:00:00Z',
  tags: [],
};

async function openFiles(page: Page, width: number, writes: string[]) {
  const appOrigin = new URL(test.info().project.use.baseURL!).origin;
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('bambutrack_language', 'en');
    localStorage.setItem('bambuddy_appliance_locale_consumed', '1');
    localStorage.setItem('library-view-mode', 'grid');
  });
  await page.routeWebSocket(() => true, (socket) => socket.close());
  await page.route((url) => url.origin === appOrigin && url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/+$/, '');
    if (request.method() !== 'GET') {
      // Startup token requests are fictional and never reach a backend or camera.
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
        return route.fulfill({ json: { token: 'fictional-token' } });
      }
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only File Manager fixture' } });
    }

    const body = path.endsWith('/auth/status') ? { auth_enabled: false, requires_setup: false }
      : path.endsWith('/settings') ? { language: 'en', check_updates: false, use_slicer_api: false }
      : path.endsWith('/library/files') ? [file]
      : path.endsWith('/library/folders') ? []
      : path.endsWith('/library/stats') ? { total_files: 1, total_folders: 0, total_size_bytes: file.file_size }
      : path.endsWith('/library/trash') ? { total: 0, items: [] }
      : [];
    return route.fulfill({ status: 200, json: body });
  });

  await page.goto('/files');
  await expect(page.getByRole('heading', { name: file.print_name, exact: true })).toBeVisible();
}

for (const width of [390, 1440]) {
  test(`grid selection checkbox uses the displayed file name for keyboard selection at ${width}px`, async ({ page }) => {
    const writes: string[] = [];
    try {
      await openFiles(page, width, writes);
      const checkbox = page.getByRole('checkbox');
      await expect(checkbox).toBeVisible();
      await expect(checkbox).not.toBeChecked();
      await expect(checkbox, 'selection checkbox accessible name should match the visible print name')
        .toHaveAccessibleName(file.print_name!);
      await checkbox.focus();
      await expect(checkbox).toBeFocused();
      await page.keyboard.press('Space');
      await expect(checkbox).toBeChecked();
      await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
      await page.keyboard.press('Space');
      await expect(checkbox).not.toBeChecked();
      await expect(page.getByText('1 selected', { exact: true })).toHaveCount(0);
    } finally {
      expect(writes).toEqual([]);
    }
  });

  test(`grid checkbox pointer selection stays independent from Actions at ${width}px`, async ({ page }) => {
    const writes: string[] = [];
    try {
      await openFiles(page, width, writes);
      const checkbox = page.getByRole('checkbox');
      const selected = page.getByText('1 selected', { exact: true });
      await expect(checkbox).toBeVisible();
      await checkbox.click();
      await expect(checkbox).toBeChecked();
      await expect(selected).toBeVisible();
      await checkbox.click();
      await expect(checkbox).not.toBeChecked();
      await expect(selected).toHaveCount(0);

      const actions = page.getByRole('button', { name: `Actions: ${file.print_name}`, exact: true });
      await actions.press('Enter');
      await expect(actions).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
      await expect(selected).toHaveCount(0);
      await actions.press('Enter');
      await expect(actions).toHaveAttribute('aria-expanded', 'false');
      await expect(selected).toHaveCount(0);
    } finally {
      expect(writes).toEqual([]);
    }
  });
}