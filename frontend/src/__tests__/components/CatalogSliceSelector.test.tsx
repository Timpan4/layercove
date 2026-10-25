import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Printer, type SlicerCatalogBinding, type SlicerCatalogClassification, type SlicerCatalogGroups, type SlicerCatalogProfile } from '../../api/client';
import { CatalogSliceSelector } from '../../components/CatalogSliceSelector';
import { useCatalogSliceSelection, type CatalogSliceSelectionState } from '../../hooks/useCatalogSliceSelection';

function renderReadySelection(reason: string) {
  const readiness = { state: 'ready', reason_codes: [reason] } as const;
  const binding = {
    id: 5, profile_id: 1, printer_id: 1, printer_name: 'Voron', profile_name: 'Voron 0.4',
    expected_nozzle_diameter: 0.4, tool_index: 0, default_process_profile_id: 2,
    default_filament_profile_id: 3, enforcement_state: 'shadow' as const,
    is_active: true, confirmed_at: null,
    readiness: { ...readiness, reason_codes: [...readiness.reason_codes] },
    nozzle: { status: 'confirmed' as const, diameter: 0.4, tool_index: 0 },
  };
  const selection: CatalogSliceSelectionState = {
    activePrinters: [], activeBindings: [binding], printerBindings: [binding],
    destinationArtifactKind: 'klipper_gcode', printerId: 1, bindingId: 5, selectedBinding: binding,
    setPrinterId: vi.fn(), setBindingId: vi.fn(), groups: undefined, catalogProfiles: [],
    allClassifications: [], processChoice: null, filamentChoices: [], selectedPrinterPreset: null,
    selectedPrinterProfile: undefined, selectedFilamentProfiles: [], equivalentFilamentSlotCounts: [],
    applyFilamentToEquivalentSlots: vi.fn(), selectSavedFilament: vi.fn(), selectedProcessPreset: null,
    selectedFilamentPresets: [], chooseProcess: vi.fn(), chooseFilament: vi.fn(), acknowledged: false,
    setAcknowledged: vi.fn(), needsAcknowledgement: false, acknowledgementReasons: [],
    materialWarnings: [], resolvedSelection: null,
    selectionReadiness: { ...readiness, reason_codes: [...readiness.reason_codes] }, loading: false, error: null,
  };
  render(<MemoryRouter><CatalogSliceSelector selection={selection} filamentSlots={[]} /></MemoryRouter>);
}

describe('CatalogSliceSelector readiness display', () => {
  it('does not claim passed checks for a ready state with an unknown reason', () => {
    renderReadySelection('future_backend_reason');
    expect(screen.getAllByText('Readiness could not be verified. Reload the profiles and check the printer binding.').length).toBeGreaterThan(0);
    expect(screen.queryByText('Checks passed.')).not.toBeInTheDocument();
    expect(screen.getAllByText('Readiness could not be verified. Reload the profiles and check the printer binding.')[0].parentElement).not.toHaveClass('text-green-300');
    expect(screen.queryByText('future_backend_reason')).not.toBeInTheDocument();
  });
});

const printer = { id: 1, name: 'P1S', model: null, provider: 'bambu', is_active: true } as Printer;
const binding: SlicerCatalogBinding = {
  id: 5, printer_id: 1, printer_name: 'P1S', profile_id: 4, profile_name: 'P1S 0.4',
  expected_nozzle_diameter: 0.4, tool_index: 0, default_process_profile_id: 12, default_filament_profile_id: null,
  enforcement_state: 'shadow', is_active: true, confirmed_at: null,
  readiness: { state: 'ready', reason_codes: [] }, nozzle: { status: 'confirmed', diameter: 0.4, tool_index: 0 },
};
const stlSlots = [{ type: '', color: '' }];
const plaSlots = [{ type: 'PLA', color: '' }];

function profileRecord(
  profileId: number,
  profileType: SlicerCatalogProfile['profile_type'],
  displayName: string,
  filamentType?: string,
): SlicerCatalogProfile {
  return {
    profile_id: profileId, revision_id: profileId, source: 'local', account_id: 1, account_name: null,
    remote_profile_id: String(profileId), profile_type: profileType, display_name: displayName,
    content_hash: String(profileId), compatibility_metadata: filamentType ? { filament_type: filamentType } : {},
    tombstoned: false, stale: false, sharing_state: 'shared',
  };
}

function selectable(profileId: number, profileType: SlicerCatalogClassification['profile_type'], displayName: string): SlicerCatalogClassification {
  return {
    profile_id: profileId, revision_id: profileId, profile_type: profileType, display_name: displayName,
    source: 'local', account_id: 1, account_name: null, stale: false,
    classification: {
      group: 'selected_printer', compatibility: 'match', readiness: 'ready', reason_codes: [], reason_details: [],
      selectable: true, auto_selectable: true, acknowledgement_required: false,
    },
  };
}

function mockCatalog({
  filaments,
  filamentGroup,
  defaultFilamentProfileId = null,
}: {
  filaments: SlicerCatalogProfile[];
  filamentGroup: SlicerCatalogClassification[];
  defaultFilamentProfileId?: number | null;
}) {
  const groups: SlicerCatalogGroups = {
    selected_printer: [selectable(12, 'process', 'P1S process'), ...filamentGroup],
    other_installed_printers: [],
    unclassified: [],
    incompatible: [],
  };
  vi.spyOn(api, 'getPrinters').mockResolvedValue([printer]);
  vi.spyOn(api, 'listSlicerCatalogProfiles').mockResolvedValue([
    profileRecord(4, 'printer', 'P1S 0.4'),
    profileRecord(12, 'process', 'P1S process'),
    ...filaments,
  ]);
  vi.spyOn(api, 'listSlicerFilamentRules').mockResolvedValue([]);
  vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([{ ...binding, default_filament_profile_id: defaultFilamentProfileId }]);
  vi.spyOn(api, 'getSlicerCatalogGroups').mockResolvedValue(groups);
  vi.spyOn(api, 'listSlicerCatalogPreferences').mockResolvedValue([]);
  vi.spyOn(api, 'getAssignments').mockResolvedValue([]);
  vi.spyOn(api, 'getSpoolmanSlotAssignments').mockResolvedValue([]);
}

function SelectionUnderTest({ filamentSlots }: { filamentSlots: Array<{ type: string; color: string }> }) {
  const selection = useCatalogSliceSelection({ filamentSlots });
  return <CatalogSliceSelector selection={selection} filamentSlots={filamentSlots} />;
}

async function renderFlow(filamentSlots: Array<{ type: string; color: string }>) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><SelectionUnderTest filamentSlots={filamentSlots} /></MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('option', { name: /P1S/ });
  fireEvent.change(screen.getByRole('combobox', { name: 'Physical printer' }), { target: { value: '1' } });
  fireEvent.change(await screen.findByRole('combobox', { name: 'Exact slicer binding' }), { target: { value: '5' } });
}

describe('CatalogSliceSelector filament choice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Failure modes: a TPU default is auto-selected for an unknown source; the
  // slot then reads as selected and asks for a confirmation of unknown material.
  it('leaves an unknown source material unselected and asks for a choice instead of a mismatched default', async () => {
    const tpu = selectable(22, 'filament', 'Inslogic 95A TPU');
    mockCatalog({
      filaments: [profileRecord(22, 'filament', 'Inslogic 95A TPU', 'TPU')],
      filamentGroup: [tpu],
      defaultFilamentProfileId: 22,
    });
    await renderFlow(stlSlots);

    expect(await screen.findByText('Choose the filament you will print with.')).toBeInTheDocument();
    expect(await screen.findByText('Pick a filament profile for slot 1.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Inslogic 95A TPU/ })).not.toBeChecked();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  // Failure mode: the one matching profile is not auto-selected, or the
  // readiness line still reports the old "Checks passed." copy.
  it('auto-selects the only matching PLA profile and states the ready combination', async () => {
    mockCatalog({
      filaments: [profileRecord(22, 'filament', 'Voron Generic PLA', 'PLA'), profileRecord(23, 'filament', 'Inslogic 95A TPU', 'TPU')],
      filamentGroup: [selectable(22, 'filament', 'Voron Generic PLA'), selectable(23, 'filament', 'Inslogic 95A TPU')],
    });
    await renderFlow(plaSlots);

    expect(await screen.findByText('Ready to slice for P1S with Voron Generic PLA.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Voron Generic PLA/ })).toBeChecked();
    expect(screen.queryByText('Choose the filament you will print with.')).not.toBeInTheDocument();
  });

  // Failure mode: an empty "Other installed printers (0)" or "Incompatible (0)"
  // header is rendered as if it were a list of choices.
  it('does not render group headers that have no profiles', async () => {
    mockCatalog({
      filaments: [profileRecord(22, 'filament', 'Voron Generic PLA', 'PLA')],
      filamentGroup: [selectable(22, 'filament', 'Voron Generic PLA')],
    });
    await renderFlow(plaSlots);

    expect(await screen.findByRole('radio', { name: /Voron Generic PLA/ })).toBeChecked();
    expect(screen.queryByText(/Other installed printers \(0\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Incompatible \(0\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Unclassified \(0\)/)).not.toBeInTheDocument();
  });

  // Failure mode: a real mismatch is confirmed with copy that does not name
  // the source or the profile material.
  it('names both materials when a chosen profile differs from the source material', async () => {
    const tpu = selectable(22, 'filament', 'Inslogic 95A TPU');
    mockCatalog({
      filaments: [profileRecord(22, 'filament', 'Inslogic 95A TPU', 'TPU')],
      filamentGroup: [tpu],
    });
    await renderFlow(plaSlots);

    await screen.findByText('Pick a filament profile for slot 1.');
    fireEvent.click(screen.getByRole('radio', { name: /Inslogic 95A TPU/ }));

    expect(await screen.findByText('Filament 1: source says PLA, profile is TPU. Slice anyway?')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Slice anyway\?/ })).not.toBeChecked();
    expect(screen.getByText('Confirm the warning below before slicing.')).toBeInTheDocument();
  });
});
