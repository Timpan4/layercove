import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  type Printer,
  type SlicerCatalogBinding,
  type SlicerCatalogClassification,
  type SlicerCatalogProfile,
  type SlicerCatalogGroups,
} from '../../api/client';
import { useCatalogSliceSelection } from '../../hooks/useCatalogSliceSelection';

const classification = (
  profileId: number,
  profileType: 'process' | 'filament',
): SlicerCatalogClassification => ({
  profile_id: profileId,
  revision_id: profileId,
  profile_type: profileType,
  display_name: `${profileType} ${profileId}`,
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

const profile = (
  profileId: number,
  profileType: 'printer' | 'process' | 'filament',
): SlicerCatalogProfile => ({
  profile_id: profileId,
  revision_id: profileId,
  source: 'local',
  account_id: 1,
  account_name: null,
  remote_profile_id: String(profileId),
  profile_type: profileType,
  display_name: `${profileType} ${profileId}`,
  content_hash: String(profileId),
  compatibility_metadata: profileType === 'filament' ? { filament_type: 'PLA' } : {},
  tombstoned: false,
  stale: false,
  sharing_state: 'shared',
});

const binding: SlicerCatalogBinding = {
  id: 5,
  printer_id: 1,
  printer_name: 'P1S',
  profile_id: 4,
  profile_name: 'P1S 0.4',
  expected_nozzle_diameter: 0.4,
  tool_index: 0,
  default_process_profile_id: 12,
  default_filament_profile_id: 22,
  enforcement_state: 'enforced',
  is_active: true,
  confirmed_at: null,
  readiness: { state: 'ready', reason_codes: [] },
  nozzle: { status: 'confirmed', diameter: 0.4, tool_index: 0 },
};

const filamentSlots = [{ type: 'PLA', color: '' }];

const groups: SlicerCatalogGroups = {
  selected_printer: [classification(12, 'process'), classification(22, 'filament')],
  other_installed_printers: [],
  unclassified: [],
  incompatible: [],
};

describe('useCatalogSliceSelection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getPrinters').mockResolvedValue([{ id: 1, name: 'P1S', is_active: true } as Printer]);
    vi.spyOn(api, 'listSlicerCatalogProfiles').mockResolvedValue([
      profile(4, 'printer'),
      profile(12, 'process'),
      profile(22, 'filament'),
      profile(99, 'process'),
    ]);
    vi.spyOn(api, 'listSlicerFilamentRules').mockResolvedValue([]);
    vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([binding]);
    vi.spyOn(api, 'getSlicerCatalogGroups').mockResolvedValue(groups);
    vi.spyOn(api, 'listSlicerCatalogPreferences').mockResolvedValue([]);
    vi.spyOn(api, 'getAssignments').mockResolvedValue([]);
    vi.spyOn(api, 'getSpoolmanSlotAssignments').mockResolvedValue([]);
    vi.spyOn(api, 'saveSlicerCatalogPreference').mockResolvedValue({
      id: 1,
      key: 'process_profile',
      value: { profile_id: 99 },
    });
  });

  it('blocks resolution when a selected profile has no current classification', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useCatalogSliceSelection({ filamentSlots }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.activePrinters).toHaveLength(1));
    act(() => result.current.setPrinterId(1));
    await waitFor(() => expect(result.current.activeBindings).toHaveLength(1));
    act(() => result.current.setBindingId(5));
    await waitFor(() => expect(result.current.resolvedSelection).not.toBeNull());

    act(() => result.current.chooseProcess(classification(99, 'process')));

    expect(result.current.resolvedSelection).toBeNull();
  });
});
