import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { SliceModal } from '../../components/SliceModal';
import { SliceJobTrackerProvider } from '../../contexts/SliceJobTrackerContext';
import { api } from '../../api/client';

vi.mock('../../api/client', () => ({
  api: {
    getPrinters: vi.fn(),
    listSlicerCatalogProfiles: vi.fn(),
    listSlicerCatalogBindings: vi.fn(),
    getSlicerCatalogGroups: vi.fn(),
    listSlicerCatalogPreferences: vi.fn(),
    saveSlicerCatalogPreference: vi.fn(),
    listSlicerFilamentRules: vi.fn(),
    getAssignments: vi.fn(),
    getSpoolmanSlotAssignments: vi.fn(),
    sliceLibraryFile: vi.fn(),
    sliceArchive: vi.fn(),
    getSliceJob: vi.fn(),
    getLibraryFilePlates: vi.fn(),
    getArchivePlates: vi.fn(),
    getLibraryFileFilamentRequirements: vi.fn(),
    getArchiveFilamentRequirements: vi.fn(),
    getPreviewSliceProgress: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
    updateSettings: vi.fn().mockResolvedValue({}),
  },
}));

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const profile = (
  profileId: number,
  profileType: 'printer' | 'process' | 'filament',
  displayName: string,
  metadata: Record<string, unknown> = {},
) => ({
  profile_id: profileId,
  revision_id: profileId,
  source: 'local',
  account_id: 1,
  account_name: null,
  remote_profile_id: `${profileType}-${profileId}`,
  profile_type: profileType,
  display_name: displayName,
  content_hash: `hash-${profileId}`,
  compatibility_metadata: metadata,
  tombstoned: false,
  stale: false,
  sharing_state: 'shared',
});
const classified = (
  profileId: number,
  profileType: 'process' | 'filament',
  displayName: string,
  group: 'selected_printer' | 'other_installed_printers' | 'unclassified' | 'incompatible' = 'selected_printer',
) => ({
  profile_id: profileId,
  revision_id: profileId,
  profile_type: profileType,
  display_name: displayName,
  source: 'local',
  account_id: 1,
  account_name: null,
  stale: false,
  classification: {
    group,
    compatibility: group === 'selected_printer' ? 'match' : group === 'unclassified' ? 'unknown' : 'mismatch',
    readiness: 'ready',
    reason_codes: group === 'unclassified' ? ['compatibility_unknown'] : group === 'incompatible' ? ['explicit_mismatch'] : [],
    reason_details: group === 'unclassified' ? ['compatibility unknown'] : group === 'incompatible' ? ['explicit mismatch'] : [],
    selectable: group === 'selected_printer' || group === 'unclassified',
    auto_selectable: group === 'selected_printer',
    acknowledgement_required: group === 'unclassified',
  },
});
const readyBinding = {
  id: 5,
  printer_id: 1,
  printer_name: 'P1S',
  profile_id: 1,
  profile_name: 'P1S 0.4',
  expected_nozzle_diameter: 0.4,
  tool_index: 0,
  default_process_profile_id: 10,
  default_filament_profile_id: 20,
  enforcement_state: 'shadow',
  is_active: true,
  confirmed_at: null,
  readiness: { state: 'ready', reason_codes: [] },
  nozzle: { status: 'confirmed', diameter: 0.4, tool_index: 0 },
};
const selectedProfiles = [
  classified(10, 'process', 'P1S process'),
  classified(20, 'filament', 'PLA profile'),
  classified(21, 'filament', 'PETG profile'),
];
const defaultGroups = {
  selected_printer: selectedProfiles,
  other_installed_printers: [classified(30, 'process', 'Voron process', 'other_installed_printers')],
  unclassified: [classified(31, 'process', 'Unknown process', 'unclassified')],
  incompatible: [classified(32, 'process', 'Dremel process', 'incompatible')],
};

function renderModal(kind: 'libraryFile' | 'archive' = 'libraryFile', onClose = vi.fn()) {
  render(
    <SliceJobTrackerProvider>
      <SliceModal source={{ kind, id: 100, filename: kind === 'libraryFile' ? 'Cube.stl' : 'Cube.3mf' }} onClose={onClose} />
    </SliceJobTrackerProvider>,
  );
  return onClose;
}

async function chooseTarget() {
  const user = userEvent.setup();
  const printerSelect = await screen.findByRole('combobox', { name: 'Physical printer' });
  await screen.findByRole('option', { name: 'P1S' });
  await user.selectOptions(printerSelect, '1');
  const bindingSelect = await screen.findByRole('combobox', { name: 'Exact slicer binding' });
  await screen.findByRole('option', { name: /P1S 0.4 · 0.4 mm · tool 0/ });
  await user.selectOptions(bindingSelect, '5');
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.getPrinters.mockResolvedValue([{ id: 1, name: 'P1S', model: 'P1S', provider: 'bambu', is_active: true }]);
  mockApi.listSlicerCatalogProfiles.mockResolvedValue([
    profile(1, 'printer', 'P1S 0.4'),
    profile(10, 'process', 'P1S process'),
    profile(20, 'filament', 'PLA profile', { filament_type: 'PLA' }),
    profile(21, 'filament', 'PETG profile', { filament_type: 'PETG' }),
    profile(31, 'process', 'Unknown process'),
    profile(32, 'process', 'Dremel process'),
  ]);
  mockApi.listSlicerCatalogBindings.mockResolvedValue([readyBinding]);
  mockApi.getSlicerCatalogGroups.mockResolvedValue(defaultGroups);
  mockApi.listSlicerCatalogPreferences.mockResolvedValue([]);
  mockApi.saveSlicerCatalogPreference.mockResolvedValue({ id: 1, key: 'process_profile', value: { profile_id: 10 } });
  mockApi.listSlicerFilamentRules.mockResolvedValue([]);
  mockApi.getAssignments.mockResolvedValue([]);
  mockApi.getSpoolmanSlotAssignments.mockResolvedValue([]);
  mockApi.getLibraryFilePlates.mockResolvedValue({ file_id: 100, filename: 'Cube.stl', plates: [], is_multi_plate: false });
  mockApi.getArchivePlates.mockResolvedValue({ archive_id: 100, filename: 'Cube.3mf', plates: [], is_multi_plate: false });
  mockApi.getLibraryFileFilamentRequirements.mockResolvedValue({ file_id: 100, filename: 'Cube.stl', plate_id: 1, filaments: [{ slot_id: 1, type: 'PLA', color: '' }] });
  mockApi.getArchiveFilamentRequirements.mockResolvedValue({ archive_id: 100, filename: 'Cube.3mf', plate_id: 1, filaments: [{ slot_id: 1, type: 'PLA', color: '' }] });
  mockApi.sliceLibraryFile.mockResolvedValue({ job_id: 42 });
  mockApi.sliceArchive.mockResolvedValue({ job_id: 43 });
  mockApi.getSliceJob.mockResolvedValue({ job_id: 42, status: 'running', kind: 'library_file', source_id: 100, source_name: 'Cube.stl', created_at: 'today', started_at: null, completed_at: null });
  mockApi.getPreviewSliceProgress.mockResolvedValue(null);
});

describe('SliceModal catalog selection', () => {
  it('explains a P1S without a binding and links to its setup', async () => {
    mockApi.listSlicerCatalogBindings.mockResolvedValue([]);
    renderModal();
    const user = userEvent.setup();
    await screen.findByRole('option', { name: 'P1S' });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Physical printer' }), '1');

    expect(await screen.findByText('P1S has no active slicer binding. Add one before slicing.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up P1S binding' })).toHaveAttribute('href', '/#slicer-binding-1');
    expect(screen.getByRole('button', { name: 'Slice' })).toBeDisabled();
    expect(mockApi.sliceLibraryFile).not.toHaveBeenCalled();
  });

  it('requires material mismatch acknowledgement for every PLA project slot', async () => {
    mockApi.listSlicerCatalogProfiles.mockResolvedValue([
      profile(1, 'printer', 'P1S 0.4'),
      profile(10, 'process', 'P1S process'),
      profile(20, 'filament', 'Inslogic 95A TPU', { filament_type: 'TPU' }),
    ]);
    mockApi.getSlicerCatalogGroups.mockResolvedValue({
      ...defaultGroups,
      selected_printer: [selectedProfiles[0], classified(20, 'filament', 'Inslogic 95A TPU')],
    });
    mockApi.getLibraryFileFilamentRequirements.mockResolvedValue({
      file_id: 100, filename: 'Cube.3mf', plate_id: 1,
      filaments: [1, 2, 3].map((slot_id) => ({ slot_id, type: 'PLA', color: '' })),
    });
    renderModal();
    const user = await chooseTarget();

    await waitFor(() => expect(screen.getAllByRole('radio', { name: /Inslogic 95A TPU/ })).toHaveLength(3));
    expect(screen.getByRole('button', { name: 'Slice' })).toBeDisabled();
    expect(screen.getByText(/Filament 1: project PLA, selected TPU/)).toBeInTheDocument();
    expect(screen.getByText(/Filament 2: project PLA, selected TPU/)).toBeInTheDocument();
    expect(screen.getByText(/Filament 3: project PLA, selected TPU/)).toBeInTheDocument();
    expect(screen.getByText(/Filament 1: project PLA, selected TPU/).closest('label'))
      .toHaveClass('text-amber-900', 'dark:text-amber-200');

    await user.click(screen.getByRole('checkbox', { name: /Confirm filament materials before slicing/ }));
    expect(screen.getByRole('button', { name: 'Slice' })).toBeEnabled();
  });

  it('requires material confirmation for a standalone STL without declared material', async () => {
    mockApi.getLibraryFileFilamentRequirements.mockResolvedValue({
      file_id: 100, filename: 'Cube.stl', plate_id: 1, filaments: [],
    });
    renderModal();
    const user = await chooseTarget();

    await waitFor(() => expect(screen.getByRole('radio', { name: /PLA profile/ })).toBeChecked());
    expect(screen.getByRole('button', { name: 'Slice' })).toBeDisabled();
    expect(screen.getByText(/Filament 1: source material unknown, selected PLA/)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Confirm filament materials before slicing/ }));
    expect(screen.getByRole('button', { name: 'Slice' })).toBeEnabled();
  });

  it('requires physical printer then exact binding and renders all four groups safely', async () => {
    renderModal();
    const slice = await screen.findByRole('button', { name: 'Slice' });
    expect(slice).toBeDisabled();
    const user = await chooseTarget();

    const processGroup = await screen.findByRole('group', { name: 'Process profile' });
    expect(within(processGroup).getByText('Selected printer (1)')).toBeInTheDocument();
    expect(within(processGroup).getByText('Other installed printers (1)')).toBeInTheDocument();
    expect(within(processGroup).getByText('Unclassified (1)')).toBeInTheDocument();
    await user.click(within(processGroup).getByText('Incompatible (1)'));
    expect(within(processGroup).getByRole('radio', { name: /Dremel process/ })).toBeDisabled();
  });

  it('requires warning acknowledgement for a manual unclassified choice', async () => {
    renderModal();
    const user = await chooseTarget();
    await user.click(screen.getByText('Unclassified (1)'));
    await user.click(screen.getByRole('radio', { name: /Unknown process/ }));

    expect(screen.getByText(/Manual confirmation required/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Slice' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Confirm current target and nozzle/ }));
    expect(screen.getByRole('button', { name: 'Slice' })).toBeEnabled();
  });

  it('sends exact catalog identities, ordered multi-slot profiles, and evidence', async () => {
    mockApi.getLibraryFileFilamentRequirements.mockResolvedValue({
      file_id: 100,
      filename: 'Cube.3mf',
      plate_id: 1,
      filaments: [
        { slot_id: 1, type: 'PLA', color: '#ff0000', used_grams: 1, used_meters: 1 },
        { slot_id: 2, type: 'PETG', color: '#0000ff', used_grams: 1, used_meters: 1 },
      ],
    });
    const onClose = renderModal('libraryFile');
    const user = await chooseTarget();
    const slice = screen.getByRole('button', { name: 'Slice' });
    await waitFor(() => expect(slice).toBeEnabled());
    await user.click(slice);

    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalledTimes(1));
    const request = mockApi.sliceLibraryFile.mock.calls[0][1];
    expect(request).toMatchObject({
      printer_preset: { source: 'local', id: 'printer-1' },
      process_preset: { source: 'local', id: 'process-10' },
      filament_presets: [
        { source: 'local', id: 'filament-20' },
        { source: 'local', id: 'filament-21' },
      ],
      catalog_printer_id: 1,
      catalog_binding_id: 5,
      catalog_process_profile_id: 10,
      catalog_filament_profile_ids: [20, 21],
    });
    expect(request.catalog_selection_evidence.filaments).toEqual([
      expect.objectContaining({ slot_id: 1, profile_id: 20, reason: 'unique_metadata_match' }),
      expect.objectContaining({ slot_id: 2, profile_id: 21, reason: 'unique_metadata_match' }),
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('loads every project slot before slicing all plates', async () => {
    mockApi.getLibraryFilePlates.mockResolvedValue({
      file_id: 100, filename: 'Cube.3mf', is_multi_plate: true,
      plates: [1, 2].map((index) => ({
        index, name: `Plate ${index}`, has_thumbnail: false, thumbnail_url: null,
        objects: [], filaments: [{ type: index === 1 ? 'PLA' : 'PETG', color: '' }],
      })),
    });
    mockApi.getLibraryFileFilamentRequirements.mockImplementation(async (_id, plateId) => ({
      file_id: 100, filename: 'Cube.3mf', plate_id: plateId ?? null,
      filaments: plateId === undefined
        ? [{ slot_id: 1, type: 'PLA', color: '' }, { slot_id: 2, type: 'PETG', color: '' }]
        : [{ slot_id: 1, type: 'PLA', color: '' }],
    }));
    renderModal();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Plate 1/ }));
    await chooseTarget();
    const plateRequestId = mockApi.getLibraryFileFilamentRequirements.mock.calls
      .find(([, plateId]) => plateId === 1)?.[2];
    expect(plateRequestId).toEqual(expect.any(String));
    await user.click(screen.getByRole('checkbox', { name: 'Slice all 2 plates' }));

    await waitFor(() => expect(mockApi.getLibraryFileFilamentRequirements).toHaveBeenCalledWith(
      100, undefined, expect.any(String),
    ));
    const allPlatesRequestId = mockApi.getLibraryFileFilamentRequirements.mock.calls
      .find(([, plateId]) => plateId === undefined)?.[2];
    expect(allPlatesRequestId).not.toBe(plateRequestId);
    expect(await screen.findByRole('group', { name: 'Filament 2 · PETG' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Slice all 2 plates' }));
    await waitFor(() => expect(mockApi.sliceLibraryFile).toHaveBeenCalledWith(100,
      expect.objectContaining({ plate: 0, catalog_filament_profile_ids: [20, 21] })));
  });

  it('blocks partial multi-slot resolution', async () => {
    mockApi.listSlicerCatalogBindings.mockResolvedValue([{ ...readyBinding, default_filament_profile_id: null }]);
    mockApi.getSlicerCatalogGroups.mockResolvedValue({
      ...defaultGroups,
      selected_printer: selectedProfiles.filter((item) => item.profile_id !== 21),
    });
    mockApi.getLibraryFileFilamentRequirements.mockResolvedValue({
      file_id: 100,
      filename: 'Cube.3mf',
      plate_id: 1,
      filaments: [
        { slot_id: 1, type: 'PLA', color: '', used_grams: 1, used_meters: 1 },
        { slot_id: 2, type: 'PETG', color: '', used_grams: 1, used_meters: 1 },
      ],
    });
    renderModal();
    await chooseTarget();
    expect(screen.getByRole('button', { name: 'Slice' })).toBeDisabled();
  });

  it('requires explicit acknowledgement for offline binding readiness', async () => {
    mockApi.listSlicerCatalogBindings.mockResolvedValue([{
      ...readyBinding,
      readiness: { state: 'acknowledgement_required', reason_codes: ['nozzle_offline'] },
      nozzle: { status: 'offline', diameter: null, tool_index: 0 },
    }]);
    renderModal();
    const user = await chooseTarget();
    expect(screen.getByRole('button', { name: 'Slice' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Confirm current target and nozzle/ }));
    expect(screen.getByRole('button', { name: 'Slice' })).toBeEnabled();
  });

  it('routes archive slicing with the same catalog evidence', async () => {
    renderModal('archive');
    const user = await chooseTarget();
    const slice = screen.getByRole('button', { name: 'Slice' });
    await waitFor(() => expect(slice).toBeEnabled());
    await user.click(slice);
    await waitFor(() => expect(mockApi.sliceArchive).toHaveBeenCalledWith(
      100,
      expect.objectContaining({ catalog_binding_id: 5 }),
    ));
  });
});


it.each(['libraryFile', 'archive'] as const)('uses the physical Moonraker provider for %s output without a manual format switch', async (kind) => {
  // The label is deliberately unchanged: output must follow the provider, not a name heuristic.
  mockApi.getPrinters.mockResolvedValue([{ id: 1, name: 'P1S', model: 'P1S', provider: 'moonraker', is_active: true }]);
  renderModal(kind);
  const user = await chooseTarget();
  const slice = screen.getByRole('button', { name: 'Slice' });
  await waitFor(() => expect(slice).toBeEnabled());
  await user.click(slice);
  const submit = kind === 'libraryFile' ? mockApi.sliceLibraryFile : mockApi.sliceArchive;
  await waitFor(() => expect(submit).toHaveBeenCalledWith(100, expect.objectContaining({ destination_artifact_kind: 'klipper_gcode' })));
});
