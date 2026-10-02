import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const printerProfile = 'Voron 2.4 300 0.4 nozzle - my';
const processProfile = '0.20mm Standard @Voron - My';
const vertices = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]];
const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
const cubeStl = `solid cube\n${faces.map((face) => `facet normal 0 0 0\nouter loop\n${face.map((index) => `vertex ${vertices[index].join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid cube\n`;
const profile = (id: number, type: string, display_name: string) => ({
  profile_id: id, revision_id: 10 + id, source: 'orca_cloud', remote_profile_id: `profile-${id}`,
  profile_type: type, display_name, content_hash: 'content', sharing_state: 'shared',
  tombstoned: false, stale: false, compatibility_metadata: type === 'filament' ? { filament_type: 'PLA' } : {},
});
const binding = {
  id: 5, profile_id: 1, printer_id: 1, printer_name: 'Tim Voron', profile_name: printerProfile,
  expected_nozzle_diameter: 0.4, tool_index: 0, default_process_profile_id: 2, default_filament_profile_id: null,
  enforcement_state: 'shadow', is_active: true, confirmed_at: null,
  readiness: { state: 'blocked', reason_codes: ['default_unavailable'] },
  nozzle: { status: 'confirmed', diameter: 0.4, tool_index: 0 },
};

async function installFixture(page: Page, width: number) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && ['/api/v1/auth/ws-token', '/api/v1/printers/camera/stream-token'].includes(path)) {
        return route.fulfill({ json: { token: 'fixture-token' } });
      }
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only readiness fixture' } });
    }
    if (path.endsWith('/library/files/42/download')) {
      return route.fulfill({ contentType: 'application/octet-stream', body: cubeStl });
    }
    let body: unknown = [];
    const contract = {
      contract_version: '1', engine: { name: 'OrcaSlicer', version: '2.4.2', commit: 'pinned' },
      image_identity: { digest: `sha256:${'b'.repeat(64)}` }, schema_hash: 'a'.repeat(64),
      capabilities: { process_schema: true, model_state: true, progress: true, cancel: false }, supported_scopes: ['global', 'object'],
      pages: [], options: [], scopes: {}, samples: {},
    };
    const profiles = [profile(1, 'printer', printerProfile), profile(2, 'process', processProfile), profile(3, 'filament', 'Generic PLA')];
    const file = { id: 42, filename: 'cube.stl', file_type: 'stl', file_size: 1024, folder_id: null, thumbnail_path: null, print_count: 0, duplicate_count: 0, created_at: '2026-10-02T00:00:00Z', tags: [] };
    if (path.endsWith('/auth/status')) body = { auth_enabled: false, requires_setup: false };
    if (path.endsWith('/settings')) body = { check_updates: false, use_slicer_api: true };
    if (path.includes('/slicer/') && /capabilities|schema/.test(path)) body = contract;
    if (path.endsWith('/slicer/catalog/profiles')) body = profiles;
    if (path.endsWith('/slicer/catalog/bindings')) body = [binding];
    if (path.endsWith('/classification')) body = {
      selected_printer: profiles.slice(1).map((item) => ({ ...item,
        classification: { group: 'selected_printer', compatibility: 'match', readiness: 'ready', reason_codes: [], reason_details: [], selectable: true, auto_selectable: true, acknowledgement_required: false },
      })), other_installed_printers: [], unclassified: [], incompatible: [],
    };
    if (path.endsWith('/preferences/5')) body = [{ id: 1, key: 'filament_profile', value: { profile_id: 3 } }];
    if (path.endsWith('/slicer/profiles/process')) body = { preset_type: 'process', source: 'orca_cloud', id: 'profile-2', values: {} };
    if (path.endsWith('/printers')) body = [{ id: 1, name: 'Tim Voron', model: null, provider: 'moonraker', is_active: true, capabilities: { camera: false, ams: false } }];
    if (/\/printers\/1\/status$/.test(path)) body = { connected: true, state: 'IDLE', vt_tray: [], ams: [], temperatures: { nozzle: 27, bed: 24 } };
    if (path.endsWith('/library/files')) body = [file];
    if (path.endsWith('/library/files/42')) body = file;
    if (path.endsWith('/library/stats')) body = { total_files: 1, total_folders: 0, total_size_bytes: 1024 };
    if (path.endsWith('/library/trash')) body = { total: 0, items: [] };
    if (path.endsWith('/files/42/plates')) body = { file_id: 42, filename: 'cube.stl', is_multi_plate: false, plates: [] };
    if (path.endsWith('/filament-requirements')) body = { filaments: [] };
    if (path.endsWith('/revisions/11')) body = { id: 11, profile_id: 1, review_state: 'approved', content_hash: 'bed', content: { printable_area: ['0x0', '300x0', '300x300', '0x300'], printable_height: '300' } };
    await route.fulfill({ json: body });
  });
  return writes;
}

for (const width of [1280, 390]) {
  for (const context of ['Quick Slice', 'workbench']) {
    test(`${context} explains required material confirmation at ${width}px`, async ({ page }) => {
      const writes = await installFixture(page, width);
      if (context === 'Quick Slice') {
        await page.goto('/files');
        await page.getByRole('button', { name: 'Actions: cube.stl', exact: true }).click();
        await page.getByRole('button', { name: 'Quick slice', exact: true }).press('Enter');
      } else {
        await page.goto('/slicer/workbench?library_file=42');
        if (width === 390) await page.getByRole('button', { name: 'settings', exact: true }).click();
      }
      await page.getByRole('combobox', { name: 'Physical printer', exact: true }).selectOption('1');
      await page.getByRole('combobox', { name: 'Exact slicer binding', exact: true }).selectOption('5');
      const slice = page.getByRole('button', { name: context === 'Quick Slice' ? 'Slice' : 'Slice plate', exact: true });
      await expect(page.getByText('Filament material is unverified. Check the loaded material and confirm before slicing.', { exact: true })).toBeVisible();
      await expect(page.getByText(/Readiness:|material_unverified|acknowledgement_required/)).toHaveCount(0);
      await expect(slice).toBeDisabled();
      await expect(page.getByRole('combobox', { name: 'Exact slicer binding', exact: true })).toHaveValue('5');
      await expect(page.getByRole('option', { name: `${printerProfile} · 0.4 mm · tool 0`, exact: true })).toBeAttached();
      if (context === 'workbench') {
        await expect(page.getByText('Editor loaded', { exact: true })).toBeVisible();
        await expect(page.getByText('Ready', { exact: true })).toHaveCount(0);
      }
      await page.getByRole('checkbox', { name: /Confirm filament materials/ }).check();
      await expect(slice).toBeEnabled();
      expect(writes).toEqual([]);
    });
  }

  test(`bindings explain unavailable defaults without changing the Voron setup at ${width}px`, async ({ page }) => {
    const writes = await installFixture(page, width);
    await page.goto('/#slicer-binding-1');
    const card = page.getByTestId('binding-5');
    await expect(card.getByText('Choose available process and filament defaults in printer bindings.', { exact: true })).toBeVisible();
    await expect(card.getByText(/default_unavailable|^blocked$/)).toHaveCount(0);
    await expect(card.getByText(printerProfile, { exact: true })).toBeVisible();
    await expect(card.getByText('0.4 mm · tool 0', { exact: true })).toBeVisible();
    await expect(card.getByRole('combobox', { name: `Process default for ${printerProfile}`, exact: true })).toHaveValue('2');
    await expect(card.getByRole('combobox', { name: `Filament default for ${printerProfile}`, exact: true })).toHaveValue('');
    await expect(card.getByRole('combobox', { name: `Rollout for ${printerProfile}`, exact: true })).toHaveValue('shadow');
    expect(writes).toEqual([]);
  });
}
