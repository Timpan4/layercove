import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { useSlicerWorkbench } from '../../features/slicer-workbench/useSlicerWorkbench';

const trackJob = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/SliceJobTrackerContext', () => ({
  useSliceJobTracker: () => ({ trackJob, jobStates: {} }),
}));

const schemaHash = 'a'.repeat(64);
const capabilities: Awaited<ReturnType<typeof api.getSlicerCapabilities>> = {
  contract_version: '1',
  engine: { name: 'OrcaSlicer', version: '2.4.2', commit: '8500fcdccaa10b5099ac20d252af3a7c560046f1' },
  image_identity: { digest: `sha256:${'b'.repeat(64)}` },
  schema_hash: schemaHash,
  capabilities: { process_schema: true, model_state: false, progress: true, cancel: false },
  supported_scopes: ['global'],
};
const schema: Awaited<ReturnType<typeof api.getSlicerProcessSchema>> = {
  ...capabilities,
  pages: [],
  options: [],
  scopes: {},
  samples: {},
};
const binding = {
  id: 5,
  printer_id: 1,
  printer_name: 'P1S',
  profile_id: 1,
  profile_name: 'P1S 0.4',
  expected_nozzle_diameter: 0.4,
  tool_index: 0,
  default_process_profile_id: 10,
  default_filament_profile_id: null,
  enforcement_state: 'shadow',
  is_active: true,
  confirmed_at: null,
  readiness: { state: 'ready', reason_codes: [] },
  nozzle: { status: 'confirmed', diameter: 0.4, tool_index: 0 },
} as const;
const classified = (id: number, type: 'process' | 'filament', name: string) => ({
  profile_id: id,
  revision_id: id,
  profile_type: type,
  display_name: name,
  source: 'local',
  account_id: 1,
  account_name: null,
  stale: false,
  classification: {
    group: 'selected_printer',
    compatibility: 'match',
    readiness: 'ready',
    reason_codes: [],
    reason_details: [],
    selectable: true,
    auto_selectable: true,
    acknowledgement_required: false,
  },
});
const groups = {
  selected_printer: [
    classified(10, 'process', 'Embedded process'),
    classified(20, 'filament', 'PLA profile'),
    classified(21, 'filament', 'PETG profile'),
  ],
  other_installed_printers: [],
  unclassified: [],
  incompatible: [],
};
const profile = (id: number, type: 'printer' | 'process' | 'filament', material?: string) => ({
  profile_id: id,
  revision_id: id,
  source: 'local',
  account_id: 1,
  account_name: null,
  remote_profile_id: `${type}-${id}`,
  profile_type: type,
  display_name: type === 'process' ? 'Embedded process' : `${type} ${id}`,
  content_hash: `${id}`,
  compatibility_metadata: material ? { filament_type: material } : {},
  tombstoned: false,
  stale: false,
  sharing_state: 'shared',
});

function plates() {
  return {
    file_id: 42,
    filename: 'catalog.3mf',
    is_multi_plate: true,
    embedded_process: 'Embedded process',
    plates: [
      {
        index: 1,
        name: 'PLA plate',
        objects: ['Cube'],
        object_ids: ['1'],
        has_thumbnail: false,
        thumbnail_url: null,
        print_time_seconds: null,
        filament_used_grams: null,
        filaments: [{ slot_id: 1, type: 'PLA', color: '', used_grams: 1, used_meters: 0.3 }],
      },
      {
        index: 2,
        name: 'PETG plate',
        objects: ['Bracket'],
        object_ids: ['2'],
        has_thumbnail: false,
        thumbnail_url: null,
        print_time_seconds: null,
        filament_used_grams: null,
        filaments: [{ slot_id: 1, type: 'PETG', color: '', used_grams: 2, used_meters: 0.6 }],
      },
    ],
  };
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

async function chooseTarget(result: { current: ReturnType<typeof useSlicerWorkbench> }) {
  await waitFor(() => expect(result.current.catalogSelection.activePrinters).toHaveLength(1));
  act(() => result.current.catalogSelection.setPrinterId(1));
  await waitFor(() => expect(result.current.catalogSelection.activeBindings).toHaveLength(1));
  act(() => result.current.catalogSelection.setBindingId(5));
}

beforeEach(() => {
  vi.spyOn(api, 'getSlicerCapabilities').mockResolvedValue(capabilities);
  vi.spyOn(api, 'getSlicerProcessSchema').mockResolvedValue(schema);
  vi.spyOn(api, 'getLibraryFile').mockResolvedValue({ id: 42, filename: 'catalog.3mf', print_name: null } as Awaited<ReturnType<typeof api.getLibraryFile>>);
  vi.spyOn(api, 'getLibraryFilePlates').mockResolvedValue(plates());
  vi.spyOn(api, 'getResolvedSlicerProfile').mockResolvedValue({ preset_type: 'process', source: 'local', id: 'process-10', values: {} });
  vi.spyOn(api, 'getPrinters').mockResolvedValue([{ id: 1, name: 'P1S', model: 'P1S', provider: 'bambu', is_active: true } as Awaited<ReturnType<typeof api.getPrinters>>[number]]);
  vi.spyOn(api, 'listSlicerCatalogProfiles').mockResolvedValue([
    profile(1, 'printer'),
    profile(10, 'process'),
    profile(20, 'filament', 'PLA'),
    profile(21, 'filament', 'PETG'),
  ] as Awaited<ReturnType<typeof api.listSlicerCatalogProfiles>>);
  vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([binding]);
  vi.spyOn(api, 'getSlicerCatalogGroups').mockResolvedValue(groups as Awaited<ReturnType<typeof api.getSlicerCatalogGroups>>);
  vi.spyOn(api, 'listSlicerCatalogPreferences').mockResolvedValue([]);
  vi.spyOn(api, 'listSlicerFilamentRules').mockResolvedValue([]);
  vi.spyOn(api, 'getAssignments').mockResolvedValue([]);
  vi.spyOn(api, 'getSpoolmanSlotAssignments').mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  trackJob.mockClear();
});

describe('useSlicerWorkbench catalog selection', () => {
  it('keeps request blocked until physical printer and exact binding are chosen', async () => {
    const { result } = renderHook(
      () => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.platesQuery.isSuccess).toBe(true));
    expect(result.current.request).toBeNull();

    await chooseTarget(result);
    await waitFor(() => expect(result.current.request).not.toBeNull());
    expect(result.current.request).toMatchObject({
      printer_preset: { source: 'local', id: 'printer-1' },
      process_preset: { source: 'local', id: 'process-10' },
      filament_presets: [{ source: 'local', id: 'filament-20' }],
      catalog_printer_id: 1,
      catalog_binding_id: 5,
      catalog_process_profile_id: 10,
      catalog_filament_profile_ids: [20],
    });
  });

  it('re-resolves each plate filament slot without list-order fallback', async () => {
    const { result } = renderHook(
      () => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null),
      { wrapper: wrapper() },
    );
    await chooseTarget(result);
    await waitFor(() => expect(result.current.request?.catalog_filament_profile_ids).toEqual([20]));

    act(() => result.current.setSelectedPlate(2));

    await waitFor(() => {
      expect(result.current.selectedPlateMetadata?.name).toBe('PETG plate');
      expect(result.current.request?.catalog_filament_profile_ids).toEqual([21]);
    });
  });
});
