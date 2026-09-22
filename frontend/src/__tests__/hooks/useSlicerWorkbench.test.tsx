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

function wrapper(queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
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
  vi.spyOn(api, 'getSlicerCatalogRevision').mockResolvedValue({
    id: 1, profile_id: 1, review_state: 'approved', content_hash: 'machine',
    content: { printable_area: ['0x0', '300x0', '300x300', '0x300'], printable_height: '300' },
  });
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


describe('workbench destination contract', () => {
  it.each([
    ['bambu', 'bambu_3mf'],
    ['moonraker', 'klipper_gcode'],
  ] as const)('submits %s output through the real selection and request hooks', async (provider, destination) => {
    vi.mocked(api.getPrinters).mockResolvedValue([{ id: 1, name: 'Printer', provider, is_active: true } as Awaited<ReturnType<typeof api.getPrinters>>[number]]);
    const submit = vi.spyOn(api, 'sliceLibraryFile').mockResolvedValue({ job_id: 55, status: 'pending', status_url: '/jobs/55' });
    const { result } = renderHook(() => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null), { wrapper: wrapper() });
    await chooseTarget(result);
    await waitFor(() => expect(result.current.request).not.toBeNull());
    await act(async () => { await result.current.slice(); });
    expect(submit).toHaveBeenCalledWith(42, expect.objectContaining({ destination_artifact_kind: destination }));
  });
});


it('uses the exact 300 mm bed and arranges without requiring per-object capability', async () => {
  const { result } = renderHook(() => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null), { wrapper: wrapper() });
  await chooseTarget(result);
  await waitFor(() => expect(result.current.request).not.toBeNull());
  await waitFor(() => expect(result.current.buildVolume).toEqual({ x: 300, y: 300, z: 300, origin: [0, 0] }));
  expect(api.getSlicerCatalogRevision).toHaveBeenCalledWith(1);
  expect(result.current.request).toMatchObject({ arrange: true });
  expect(result.current.request?.model_state).toBeUndefined();
  act(() => result.current.setArrange(false));
  expect(result.current.request?.arrange).toBe(false);
});

it('invalidates the output fingerprint when a selected filament revision changes', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null), { wrapper: wrapper(queryClient) });
  await chooseTarget(result);
  await waitFor(() => expect(result.current.requestFingerprint).not.toBeNull());
  const previous = result.current.requestFingerprint;
  act(() => queryClient.setQueryData(['slicerCatalogGroups', 1, 5], {
    ...groups, selected_printer: groups.selected_printer.map((p) => p.profile_id === 20 ? { ...p, revision_id: 120 } : p),
  }));
  await waitFor(() => expect(result.current.requestFingerprint).not.toBe(previous));
  const evidence = result.current.request?.catalog_selection_evidence as {filaments: Array<{revision_id: number}>};
  expect(evidence.filaments[0].revision_id).toBe(120);
});

it('selects the saved local filament after refetch and sends it in the next real request', async () => {
  vi.spyOn(api, 'saveSlicerCatalogPreference').mockResolvedValue({} as Awaited<ReturnType<typeof api.saveSlicerCatalogPreference>>);
  const { result } = renderHook(() => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null), { wrapper: wrapper() });
  await chooseTarget(result);
  await waitFor(() => expect(result.current.request?.catalog_filament_profile_ids).toEqual([20]));
  vi.mocked(api.listSlicerCatalogProfiles).mockResolvedValue([
    profile(1, 'printer'), profile(10, 'process'), profile(20, 'filament', 'PLA'), profile(30, 'filament', 'PLA'),
  ] as Awaited<ReturnType<typeof api.listSlicerCatalogProfiles>>);
  vi.mocked(api.getSlicerCatalogGroups).mockResolvedValue({
    ...groups, selected_printer: [...groups.selected_printer, classified(30, 'filament', 'Edited PLA')],
  } as Awaited<ReturnType<typeof api.getSlicerCatalogGroups>>);
  await act(async () => { await result.current.catalogSelection.selectSavedFilament(0, 30); });
  await waitFor(() => expect(result.current.request).toMatchObject({
    catalog_filament_profile_ids: [30], filament_presets: [{ source: 'local', id: 'filament-30' }],
  }));
});

it('preserves a deliberate arrange-off setting when unchanged plate metadata refetches', async () => {
  const { result } = renderHook(() => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null), { wrapper: wrapper() });
  await chooseTarget(result);
  await waitFor(() => expect(result.current.request).not.toBeNull());
  act(() => result.current.setArrange(false));
  vi.mocked(api.getLibraryFilePlates).mockResolvedValue(plates());
  await act(async () => { await result.current.platesQuery.refetch(); });
  expect(result.current.request?.arrange).toBe(false);
});


describe('cloud revision geometry regression', () => {
  it.each(['orca_cloud', 'cloud', 'local', 'standard'] as const)('uses serialized geometry from the exact %s revision while Ready', async (source) => {
    vi.mocked(api.listSlicerCatalogProfiles).mockResolvedValue([
      { ...profile(1, 'printer'), source }, profile(10, 'process'), profile(20, 'filament', 'PLA'),
    ] as Awaited<ReturnType<typeof api.listSlicerCatalogProfiles>>);
    vi.mocked(api.getSlicerCatalogRevision).mockResolvedValue({
      id: 1, profile_id: 1, review_state: 'approved', content_hash: 'serialized',
      content: { printable_area: '0x0,300x0,300x300,0x300', printable_height: '300' },
    });
    const { result } = renderHook(() => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null), { wrapper: wrapper() });
    await chooseTarget(result);
    await waitFor(() => expect(result.current.printerProfileQuery.isSuccess).toBe(true));
    expect(result.current.catalogSelection.selectionReadiness.state).toBe('ready');
    expect(result.current.buildVolume).toEqual({ x: 300, y: 300, z: 300, origin: [0, 0] });
    expect(api.getSlicerCatalogRevision).toHaveBeenCalledWith(1);
  });
});

it('does not reuse the previous bed while a new exact revision loads, even if the old request finishes late', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  type Revision = Awaited<ReturnType<typeof api.getSlicerCatalogRevision>>;
  let finishOld!: (value: Revision) => void;
  let finishNew!: (value: Revision) => void;
  vi.mocked(api.getSlicerCatalogRevision).mockImplementation((id) => new Promise((resolve) => {
    if (id === 1) finishOld = resolve;
    else if (id === 2) finishNew = resolve;
  }));
  const { result } = renderHook(() => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null), { wrapper: wrapper(client) });
  await chooseTarget(result);
  await waitFor(() => expect(api.getSlicerCatalogRevision).toHaveBeenCalledWith(1));
  act(() => client.setQueryData(['slicerCatalogProfiles'], [
    { ...profile(1, 'printer'), revision_id: 2 }, profile(10, 'process'), profile(20, 'filament', 'PLA'),
  ]));
  await waitFor(() => expect(api.getSlicerCatalogRevision).toHaveBeenCalledWith(2));
  expect(result.current.buildVolume).toBeNull();
  await act(async () => finishNew({ id: 2, profile_id: 1, review_state: 'approved', content_hash: 'new',
    content: { printable_area: '-20x-10,330x-10,330x340,-20x340', printable_height: '400' },
  }));
  await waitFor(() => expect(result.current.buildVolume).toEqual({ x: 350, y: 350, z: 400, origin: [-20, -10] }));
  await act(async () => finishOld({ id: 1, profile_id: 1, review_state: 'approved', content_hash: 'old',
    content: { printable_area: '0x0,256x0,256x256,0x256', printable_height: '256' },
  }));
  expect(result.current.buildVolume).toEqual({ x: 350, y: 350, z: 400, origin: [-20, -10] });
  expect(result.current.printerProfileQuery.data?.id).toBe(2);
});
