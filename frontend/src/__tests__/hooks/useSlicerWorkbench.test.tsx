import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type UnifiedPresetsBySlot, type UnifiedPresetsResponse } from '../../api/client';
import { useSlicerWorkbench } from '../../features/slicer-workbench/useSlicerWorkbench';

const trackJob = vi.hoisted(() => vi.fn());

vi.mock('../../contexts/SliceJobTrackerContext', () => ({
  useSliceJobTracker: () => ({ trackJob, jobStates: {} }),
}));

const emptyTier = (): UnifiedPresetsBySlot => ({ printer: [], process: [], filament: [] });
const never = () => new Promise<never>(() => undefined);
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

const presets: UnifiedPresetsResponse = {
  local: emptyTier(),
  orca_cloud: emptyTier(),
  cloud: emptyTier(),
  standard: {
    printer: [
      { id: 'creality-k1', name: 'Creality K1 0.4 nozzle', source: 'standard' },
      { id: 'bambu-x1c', name: 'Bambu Lab X1 Carbon 0.4 nozzle', source: 'standard' },
    ],
    process: [
      { id: 'x1c-process', name: '0.20mm Standard @BBL X1C', source: 'standard' },
      { id: 'a1-process', name: '0.20mm Standard @BBL A1', source: 'standard' },
    ],
    filament: [
      {
        id: 'a1-filament',
        name: 'Bambu PLA Basic @BBL A1',
        source: 'standard',
        filament_type: 'PLA',
        filament_colour: '#ff0000',
      },
      {
        id: 'x1c-filament',
        name: 'Bambu PLA Basic @BBL X1C',
        source: 'standard',
        filament_type: 'PLA',
        filament_colour: '#000000',
      },
      {
        id: 'x1c-petg',
        name: 'Bambu PETG HF @BBL X1C',
        source: 'standard',
        filament_type: 'PETG',
        filament_colour: '#0000ff',
      },
    ],
  },
  cloud_status: 'not_authenticated',
  orca_cloud_status: 'not_authenticated',
};

const printerModels = {
  'Bambu Lab X1 Carbon': 'X1C',
  'Bambu Lab A1': 'A1',
};

function plates(includeSecondPlate = false): Awaited<ReturnType<typeof api.getLibraryFilePlates>> {
  return {
    file_id: 42,
    filename: 'mixed-vendor.3mf',
    is_multi_plate: includeSecondPlate,
    embedded_printer: 'Bambu Lab X1 Carbon 0.4 nozzle',
    embedded_process: '0.20mm Standard @BBL X1C',
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
        filaments: [
          {
            slot_id: 1,
            type: 'PLA',
            color: '#ff0000',
            used_grams: 1,
            used_meters: 0.3,
          },
        ],
      },
      ...(includeSecondPlate
        ? [{
            index: 2,
            name: 'PETG plate',
            objects: ['Bracket'],
            object_ids: ['2'],
            has_thumbnail: false,
            thumbnail_url: null,
            print_time_seconds: null,
            filament_used_grams: null,
            filaments: [
              {
                slot_id: 1,
                type: 'PETG',
                color: '#0000ff',
                used_grams: 2,
                used_meters: 0.6,
              },
            ],
          }]
        : []),
    ],
  };
}

function wrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

function mockBaseQueries() {
  vi.spyOn(api, 'getSlicerCapabilities').mockResolvedValue(capabilities);
  vi.spyOn(api, 'getSlicerProcessSchema').mockResolvedValue(schema);
  vi.spyOn(api, 'getLibraryFile').mockImplementation(never);
  vi.spyOn(api, 'getResolvedSlicerProfile').mockImplementation(never);
  vi.spyOn(api, 'getSlicerPresets').mockResolvedValue(presets);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  trackJob.mockClear();
});

describe('useSlicerWorkbench preset defaults', () => {
  it('waits for plate metadata and printer models before selecting compatible defaults', async () => {
    mockBaseQueries();
    const plateData = plates();
    let resolvePlates!: (value: typeof plateData) => void;
    const platesPromise = new Promise<typeof plateData>((resolve) => {
      resolvePlates = resolve;
    });
    let resolvePrinterModels!: (value: typeof printerModels) => void;
    const printerModelsPromise = new Promise<typeof printerModels>((resolve) => {
      resolvePrinterModels = resolve;
    });
    vi.spyOn(api, 'getLibraryFilePlates').mockReturnValue(platesPromise);
    vi.spyOn(api, 'getSlicerPrinterModels').mockReturnValue(printerModelsPromise);

    const { result } = renderHook(
      () => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.presetsQuery.isSuccess).toBe(true));
    expect(result.current.printerPreset).toBeNull();
    expect(result.current.processPreset).toBeNull();
    expect(result.current.filamentPresets).toEqual([]);

    await act(async () => {
      resolvePlates(plateData);
      await platesPromise;
    });
    await waitFor(() => expect(result.current.platesQuery.isSuccess).toBe(true));
    expect(result.current.printerPreset).toEqual({ source: 'standard', id: 'bambu-x1c' });
    expect(result.current.processPreset).toBeNull();
    expect(result.current.filamentPresets).toEqual([]);
    expect(result.current.request).toBeNull();

    await act(async () => {
      resolvePrinterModels(printerModels);
      await printerModelsPromise;
    });

    await waitFor(() => {
      expect(result.current.processPreset).toEqual({ source: 'standard', id: 'x1c-process' });
      expect(result.current.filamentPresets).toEqual([
        { source: 'standard', id: 'x1c-filament' },
      ]);
      expect(result.current.request).not.toBeNull();
    });
  });

  it('reselects an automatic filament default when the plate material changes', async () => {
    mockBaseQueries();
    vi.spyOn(api, 'getLibraryFilePlates').mockResolvedValue(plates(true));
    vi.spyOn(api, 'getSlicerPrinterModels').mockResolvedValue(printerModels);

    const { result } = renderHook(
      () => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null),
      { wrapper: wrapper() },
    );

    await waitFor(() => {
      expect(result.current.selectedPlate).toBe(1);
      expect(result.current.filamentPresets).toEqual([
        { source: 'standard', id: 'x1c-filament' },
      ]);
    });

    act(() => result.current.setSelectedPlate(2));

    await waitFor(() => {
      expect(result.current.selectedPlateMetadata?.name).toBe('PETG plate');
      expect(result.current.filamentPresets).toEqual([
        { source: 'standard', id: 'x1c-petg' },
      ]);
    });
  });
});
