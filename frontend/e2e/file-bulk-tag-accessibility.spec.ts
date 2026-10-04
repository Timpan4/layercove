import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const files = Array.from({ length: 9 }, (_, index) => ({
  id: index + 1,
  filename: `fictional-part-${index + 1}.stl`,
  file_type: 'stl',
  file_size: 1024,
  folder_id: null,
  thumbnail_path: null,
  print_name: null,
  print_count: 0,
  duplicate_count: 0,
  created_at: '2026-10-01T00:00:00Z',
  tags: [],
}));

const tags = [{ id: 41, name: 'Fictional tag', file_count: 0 }];

async function openBulkTags(page: Page, language: 'en' | 'de', width: number, count: 1 | 9) {
  const writes: string[] = [];
  const appOrigin = new URL(test.info().project.use.baseURL!).origin;
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript((locale) => {
    localStorage.setItem('bambutrack_language', locale);
    localStorage.setItem('bambuddy_appliance_locale_consumed', '1');
    localStorage.setItem('library-view-mode', 'grid');
  }, language);
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
      : path.endsWith('/settings') ? { language, check_updates: false, use_slicer_api: false }
      : path.endsWith('/library/files') ? files
      : path.endsWith('/library/folders') ? []
      : path.endsWith('/library/stats') ? { total_files: files.length, total_folders: 0, total_size_bytes: files.length * 1024 }
      : path.endsWith('/library/trash') ? { total: 0, items: [] }
      : path.endsWith('/library/tags') ? tags
      : [];
    return route.fulfill({ status: 200, json: body });
  });

  await page.goto('/files');
  await expect(page.getByText(files[8].filename, { exact: true })).toBeVisible();
  if (count === 1) {
    // The current grid card has no keyboard selection control (#259, separate).
    // Pointer selection only sets up the bulk tagging dialog being tested.
    await page.getByText(files[0].filename, { exact: true }).click();
  } else {
    // The label is visually hidden on mobile; locate its actual parent button.
    await page.locator('button').filter({
      has: page.getByText(language === 'en' ? 'Select All' : 'Alle auswählen', { exact: true }),
    }).click();
  }
  const tag = page.getByTitle(language === 'en'
    ? 'Add or remove tags on every selected file.'
    : 'Tags für alle ausgewählten Dateien hinzufügen oder entfernen.', { exact: true });
  await expect(tag).toBeEnabled();
  await tag.click();
  // The known broken title must not prevent independent keyboard baselines.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Fictional tag', { exact: true })).toBeVisible();
  return { dialog, tag, writes };
}

for (const language of ['en', 'de'] as const) {
  for (const width of [390, 1440]) {
    for (const count of [1, 9] as const) {
      test(`bulk tagging has count-aware title for ${count} files in ${language} at ${width}px`, async ({ page }) => {
        const { dialog, writes } = await openBulkTags(page, language, width, count);
        try {
          const title = language === 'en'
            ? count === 1 ? 'Tag 1 selected file' : 'Tag 9 selected files'
            : count === 1 ? '1 ausgewählte Datei taggen' : '9 ausgewählte Dateien taggen';
          await expect(dialog).toHaveAccessibleName(title);
          await expect(dialog.getByRole('heading')).toHaveText(title);
        } finally {
          expect(writes).toEqual([]);
        }
      });
    }

    test(`bulk tagging takes initial focus in ${language} at ${width}px`, async ({ page }) => {
      const { dialog, writes } = await openBulkTags(page, language, width, 9);
      try {
        await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      } finally {
        expect(writes).toEqual([]);
      }
    });

    for (const direction of ['Tab', 'Shift+Tab'] as const) {
      test(`bulk tagging contains ${direction} at its boundary in ${language} at ${width}px`, async ({ page }) => {
        const { dialog, writes } = await openBulkTags(page, language, width, 9);
        const close = dialog.getByRole('button', { name: language === 'en' ? 'Close' : 'Schließen', exact: true });
        const cancel = dialog.getByRole('button', { name: language === 'en' ? 'Cancel' : 'Abbrechen', exact: true });
        try {
          await (direction === 'Tab' ? cancel : close).focus();
          await page.keyboard.press(direction);
          await expect(direction === 'Tab' ? close : cancel).toBeFocused();
        } finally {
          expect(writes).toEqual([]);
        }
      });
    }

    for (const dismissal of ['Escape', 'Cancel'] as const) {
      test(`bulk tagging restores its trigger after ${dismissal} in ${language} at ${width}px`, async ({ page }) => {
        const { dialog, tag, writes } = await openBulkTags(page, language, width, 9);
        const cancel = dialog.getByRole('button', { name: language === 'en' ? 'Cancel' : 'Abbrechen', exact: true });
        try {
          await cancel.focus();
          if (dismissal === 'Escape') await page.keyboard.press('Escape');
          else await cancel.click();
          await expect(dialog).not.toBeVisible();
          await expect(tag).toBeFocused();
        } finally {
          expect(writes).toEqual([]);
        }
      });
    }
  }
}
