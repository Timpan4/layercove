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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  trackJob.mockClear();
});

describe('useSlicerWorkbench preset defaults', () => {
  it('selects mutually compatible embedded defaults from a mixed-vendor catalog', async () => {
    const never = () => new Promise<never>(() => undefined);
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
        ],
      },
      cloud_status: 'not_authenticated',
      orca_cloud_status: 'not_authenticated',
    };

    vi.spyOn(api, 'getSlicerCapabilities').mockImplementation(never);
    vi.spyOn(api, 'getLibraryFile').mockImplementation(never);
    vi.spyOn(api, 'getSlicerProcessSchema').mockImplementation(never);
    vi.spyOn(api, 'getResolvedSlicerProfile').mockImplementation(never);
    vi.spyOn(api, 'getSlicerPresets').mockResolvedValue(presets);
    vi.spyOn(api, 'getSlicerPrinterModels').mockResolvedValue({
      'Bambu Lab X1 Carbon': 'X1C',
      'Bambu Lab A1': 'A1',
    });
    const plates: Awaited<ReturnType<typeof api.getLibraryFilePlates>> = {
      file_id: 42,
      filename: 'mixed-vendor.3mf',
      is_multi_plate: false,
      embedded_printer: 'Bambu Lab X1 Carbon 0.4 nozzle',
      embedded_process: '0.20mm Standard @BBL X1C',
      plates: [
        {
          index: 1,
          name: 'Plate 1',
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
      ],
    };
    let resolvePlates!: (value: typeof plates) => void;
    const platesPromise = new Promise<typeof plates>((resolve) => {
      resolvePlates = resolve;
    });
    vi.spyOn(api, 'getLibraryFilePlates').mockReturnValue(platesPromise);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    );

    const { result } = renderHook(
      () => useSlicerWorkbench({ kind: 'libraryFile', id: 42 }, null),
      { wrapper },
    );

    await waitFor(() => expect(result.current.presetsQuery.isSuccess).toBe(true));
    expect(result.current.printerPreset).toBeNull();
    expect(result.current.processPreset).toBeNull();
    expect(result.current.filamentPresets).toEqual([]);

    await act(async () => {
      resolvePlates(plates);
      await platesPromise;
    });

    await waitFor(() => {
      expect(result.current.printerPreset).toEqual({ source: 'standard', id: 'bambu-x1c' });
      expect(result.current.processPreset).toEqual({ source: 'standard', id: 'x1c-process' });
      expect(result.current.filamentPresets).toEqual([
        { source: 'standard', id: 'x1c-filament' },
      ]);
    });
  });
});
