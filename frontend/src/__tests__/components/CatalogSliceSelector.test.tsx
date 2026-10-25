import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type Printer, type SlicerCatalogBinding, type SlicerCatalogClassification, type SlicerCatalogGroups, type SlicerCatalogProfile, type SpoolAssignment } from '../../api/client';
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
    destinationArtifactKind: 'klipper_gcode', loadedFilamentMaterials: [], printerId: 1, bindingId: 5, selectedBinding: binding,
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

function candidate(
  profileId: number,
  displayName: string,
  group: keyof SlicerCatalogGroups,
  reasonDetails: string[] = [],
): SlicerCatalogClassification {
  return {
    profile_id: profileId, revision_id: profileId, profile_type: 'filament', display_name: displayName,
    source: 'local', account_id: 1, account_name: null, stale: false,
    classification: {
      group, compatibility: group === 'selected_printer' ? 'match' : 'unknown',
      readiness: group === 'unclassified' ? 'acknowledgement_required' : group === 'selected_printer' ? 'ready' : 'blocked',
      reason_codes: [], reason_details: reasonDetails,
      selectable: group === 'selected_printer' || group === 'unclassified',
      auto_selectable: group === 'selected_printer', acknowledgement_required: group === 'unclassified',
    },
  };
}

function loadedSpool(material: string, trayId: number): SpoolAssignment {
  return {
    id: trayId, spool_id: 900 + trayId, printer_id: 1, printer_name: 'P1S', ams_id: 0, tray_id: trayId,
    fingerprint_color: null, fingerprint_type: material, configured: true, created_at: '2026-10-25T00:00:00Z',
    spool: { id: 900 + trayId, material, brand: null, rgba: null } as NonNullable<SpoolAssignment['spool']>,
  };
}

function mockCatalog({
  filaments,
  filamentGroup,
  defaultFilamentProfileId = null,
  extraGroups = {},
  assignments = [],
}: {
  filaments: SlicerCatalogProfile[];
  filamentGroup: SlicerCatalogClassification[];
  defaultFilamentProfileId?: number | null;
  extraGroups?: Partial<SlicerCatalogGroups>;
  assignments?: SpoolAssignment[];
}) {
  const groups: SlicerCatalogGroups = {
    selected_printer: [selectable(12, 'process', 'P1S process'), ...filamentGroup],
    other_installed_printers: [],
    unclassified: [],
    incompatible: [],
    ...extraGroups,
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
  vi.spyOn(api, 'getAssignments').mockResolvedValue(assignments);
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

function filamentSection() {
  return screen.getByRole('group', { name: 'Filament profile' });
}

function filamentSections() {
  return within(filamentSection()).getAllByRole('group').map((section) => section.getAttribute('aria-label'));
}

describe('CatalogSliceSelector filament groups', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const materialCatalog = (assignments: SpoolAssignment[] = []) => mockCatalog({
    filaments: [
      profileRecord(22, 'filament', 'Voron Generic PLA', 'PLA'),
      profileRecord(23, 'filament', 'Voron PETG Basic', 'PETG'),
      profileRecord(24, 'filament', 'Inslogic 95A TPU', 'TPU'),
      profileRecord(25, 'filament', 'Polymaker PC', 'PC'),
      profileRecord(26, 'filament', 'Unlabelled template'),
    ],
    filamentGroup: [
      candidate(22, 'Voron Generic PLA', 'selected_printer', ['administrator mapping', 'nozzle match']),
      candidate(23, 'Voron PETG Basic', 'selected_printer'),
    ],
    extraGroups: {
      unclassified: [
        candidate(24, 'Inslogic 95A TPU', 'unclassified', ['compatibility unknown', 'nozzle match']),
        candidate(26, 'Unlabelled template', 'unclassified'),
      ],
      other_installed_printers: [candidate(25, 'Polymaker PC', 'other_installed_printers', ['bound to another printer'])],
    },
    assignments,
  });

  // Failure mode: 28 unsorted rows under "Unclassified" make PLA hard to find; the
  // groups must follow material, with unknown material last and empty groups hidden.
  it('groups filament candidates by material with unknown material last', async () => {
    materialCatalog();
    await renderFlow(stlSlots);

    await screen.findByRole('radio', { name: /Voron Generic PLA/ });
    await waitFor(() => expect(filamentSections()).toEqual(['PLA (1)', 'PETG (1)', 'TPU (1)', 'Other (1)', 'Unknown material (1)']));
    const pla = within(filamentSection()).getByRole('group', { name: 'PLA (1)' });
    expect(within(pla).getByRole('radio', { name: /Voron Generic PLA/ })).toBeInTheDocument();
    expect(within(pla).getByText('PLA', { exact: true })).toBeInTheDocument();
    expect(within(pla).getByText('Imported', { exact: true })).toBeInTheDocument();
    expect(within(filamentSection()).getByRole('group', { name: 'Other (1)' }).querySelector('input')).toBeDisabled();
  });

  // Failure mode: provenance and compatibility reasons are printed inline, so each row reads
  // as a sentence of jargon. The reasons must stay available but out of the visible text.
  it('keeps compatibility reasons in the tooltip and accessible description, not in visible text', async () => {
    materialCatalog();
    await renderFlow(stlSlots);

    const tpu = await screen.findByRole('radio', { name: /Inslogic 95A TPU/ });
    expect(tpu).toHaveAccessibleDescription('Manual confirmation required · compatibility unknown, nozzle match');
    expect(screen.getByRole('radio', { name: /Voron Generic PLA/ })).toHaveAccessibleDescription('administrator mapping, nozzle match');
    expect(screen.getByTitle('Manual confirmation required · compatibility unknown, nozzle match')).toBeInTheDocument();
    const reasonText = screen.queryAllByText(/Manual confirmation required|administrator mapping|compatibility unknown/);
    reasonText.forEach((element) => expect(element).not.toBeVisible());
  });

  // Failure mode: the printer already holds the source material, but its profiles sit
  // among 28 other rows, so the user has to search for the spool they already loaded.
  it('lists profiles for the loaded spool of the source material first without repeating them', async () => {
    materialCatalog([loadedSpool('PLA', 0)]);
    await renderFlow(plaSlots);

    await waitFor(() => expect(filamentSections()).toEqual(['Loaded in printer (1)', 'PETG (1)', 'TPU (1)', 'Other (1)', 'Unknown material (1)']));
    const loaded = within(filamentSection()).getByRole('group', { name: 'Loaded in printer (1)' });
    expect(within(loaded).getByRole('radio', { name: /Voron Generic PLA/ })).toBeInTheDocument();
  });

  // Failure mode: a loaded PETG spool is offered for a PLA slot, which would invite a
  // material mismatch that the readiness check then has to reject.
  it('does not offer a loaded spool of another material for the source slot', async () => {
    materialCatalog([loadedSpool('PETG', 1)]);
    await renderFlow(plaSlots);

    await screen.findByRole('radio', { name: /Voron Generic PLA/ });
    await waitFor(() => expect(filamentSections()).toEqual(['PLA (1)', 'PETG (1)', 'TPU (1)', 'Other (1)', 'Unknown material (1)']));
  });

  // Failure mode: search keeps matching profiles in every group, so a name search narrows the
  // grouped list instead of leaving headers for empty groups.
  it('filters profiles by name across the material groups', async () => {
    materialCatalog();
    await renderFlow(stlSlots);

    await screen.findByRole('radio', { name: /Voron Generic PLA/ });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search catalog profiles' }), { target: { value: 'petg' } });

    await waitFor(() => expect(filamentSections()).toEqual(['PETG (1)']));
    expect(screen.queryByRole('radio', { name: /Voron Generic PLA/ })).not.toBeInTheDocument();
  });
});
