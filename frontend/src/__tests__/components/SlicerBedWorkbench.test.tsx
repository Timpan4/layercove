import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { SlicerWorkbenchPage } from '../../pages/SlicerWorkbenchPage';
import type { SlicerBed } from '../../utils/slicerBed';

// Only the canvas renderers and external API calls are replaced. The page,
// selector, revision query, geometry parser and state messages are production.
vi.mock('../../components/ModelViewer', () => ({
  ModelViewer: ({ buildVolume, showBuildPlate, centerOnBed }: { buildVolume?: SlicerBed; showBuildPlate?: boolean; centerOnBed?: boolean }) => <output data-testid="model-bed" data-bed={showBuildPlate} data-centered={centerOnBed}>{JSON.stringify(buildVolume ?? null)}</output>,
}));
vi.mock('../../components/GcodeViewer', () => ({
  GcodeViewer: ({ buildVolume, showBuildPlate }: { buildVolume?: SlicerBed; showBuildPlate?: boolean }) => <output data-testid="gcode-bed" data-bed={showBuildPlate}>{JSON.stringify(buildVolume ?? null)}</output>,
}));
vi.mock('../../contexts/SliceJobTrackerContext', () => ({
  useSliceJobTracker: () => ({ trackJob: vi.fn(), jobStates: { 9: {
    status: 'completed', result: { library_file_id: 77 }, request_fingerprint: 'previous',
  } } }),
}));

const bed = { x: 300, y: 300, z: 300, origin: [0, 0] };
const revision = {
  id: 101, profile_id: 1, review_state: 'approved', content_hash: 'machine',
  content: { printable_area: '0x0,300x0,300x300,0x300', printable_height: '300' },
};
const profile = (id: number, type: 'printer' | 'process' | 'filament') => ({
  profile_id: id, revision_id: 100 + id, source: 'orca_cloud' as const, remote_profile_id: `profile-${id}`,
  profile_type: type, display_name: `Cloud ${type}`, content_hash: 'content', account_id: 1,
  sharing_state: 'shared', tombstoned: false, stale: false, compatibility_metadata: {}, account_name: null,
});
const binding = {
  id: 5, profile_id: 1, printer_id: 1, printer_name: 'Physical device', profile_name: 'Cloud machine',
  expected_nozzle_diameter: 0.4, tool_index: 0, default_process_profile_id: 2, default_filament_profile_id: 3,
  enforcement_state: 'shadow', is_active: true, confirmed_at: null,
  readiness: { state: 'ready', reason_codes: [] }, nozzle: { status: 'confirmed', diameter: 0.4, tool_index: 0 },
};

beforeEach(() => {
  const contract = {
    contract_version: '1', engine: { name: 'OrcaSlicer', version: '2.4.2', commit: 'pinned' },
    image_identity: { digest: `sha256:${'b'.repeat(64)}` }, schema_hash: 'a'.repeat(64),
    capabilities: { process_schema: true, model_state: false, progress: true, cancel: false }, supported_scopes: ['global'],
  };
  vi.spyOn(api, 'getSlicerCapabilities').mockResolvedValue(contract);
  vi.spyOn(api, 'getSlicerProcessSchema').mockResolvedValue({ ...contract, pages: [], options: [], scopes: {}, samples: {} });
  vi.spyOn(api, 'getLibraryFile').mockResolvedValue({ id: 42, filename: 'cube.stl' } as Awaited<ReturnType<typeof api.getLibraryFile>>);
  vi.spyOn(api, 'getLibraryFilePlates').mockResolvedValue({
    file_id: 42, filename: 'cube.stl', is_multi_plate: false, plates: [{ index: 1, objects: [], object_ids: [], filaments: [] }],
  } as unknown as Awaited<ReturnType<typeof api.getLibraryFilePlates>>);
  vi.spyOn(api, 'getPrinters').mockResolvedValue([{ id: 1, name: 'Physical device', provider: 'moonraker', is_active: true }] as Awaited<ReturnType<typeof api.getPrinters>>);
  vi.spyOn(api, 'listSlicerCatalogProfiles').mockResolvedValue([profile(1, 'printer'), profile(2, 'process'), profile(3, 'filament')] as Awaited<ReturnType<typeof api.listSlicerCatalogProfiles>>);
  vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([binding] as Awaited<ReturnType<typeof api.listSlicerCatalogBindings>>);
  vi.spyOn(api, 'getSlicerCatalogGroups').mockResolvedValue({
    selected_printer: ['process', 'filament'].map((type, index) => ({
      ...profile(index + 2, type as 'process' | 'filament'),
      classification: { group: 'selected_printer', compatibility: 'match', readiness: 'ready', reason_codes: [], reason_details: [], selectable: true, auto_selectable: true, acknowledgement_required: false },
    })), other_installed_printers: [], unclassified: [], incompatible: [],
  } as Awaited<ReturnType<typeof api.getSlicerCatalogGroups>>);
  vi.spyOn(api, 'getSlicerCatalogRevision').mockResolvedValue(revision);
  vi.spyOn(api, 'getResolvedSlicerProfile').mockResolvedValue({ preset_type: 'process', source: 'orca_cloud', id: 'profile-2', values: {} });
  vi.spyOn(api, 'listSlicerCatalogPreferences').mockResolvedValue([]);
  vi.spyOn(api, 'listSlicerFilamentRules').mockResolvedValue([]);
  vi.spyOn(api, 'getAssignments').mockResolvedValue([]);
  vi.spyOn(api, 'getSpoolmanSlotAssignments').mockResolvedValue([]);
});

afterEach(() => vi.restoreAllMocks());

async function selectMachine() {
  render(<MemoryRouter initialEntries={['/slicer?library_file=42&job=9']}><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SlicerWorkbenchPage /></QueryClientProvider></MemoryRouter>);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Physical printer' }), { target: { value: '1' } });
  await screen.findByRole('option', { name: /Cloud machine/ });
  fireEvent.change(screen.getByRole('combobox', { name: 'Exact slicer binding' }), { target: { value: '5' } });
}

describe('bed geometry in the actual workbench', () => {
  it('uses inherited bed geometry for a cloud revision containing only overrides', async () => {
    vi.mocked(api.getSlicerCatalogRevision).mockResolvedValue({
      ...revision,
      content: { inherits: 'Voron 2.4 300 0.4 nozzle', base_id: 'G4jBDBTV7TnKVT6X' },
      bed_content: { printable_area: '0x0,300x0,300x300,0x300', printable_height: '275' },
      bed_parent_revision_id: 882,
    });
    await selectMachine();
    expect(await screen.findByTestId('model-bed')).toHaveTextContent(JSON.stringify({ ...bed, z: 275 }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(await screen.findByTestId('gcode-bed')).toHaveTextContent(JSON.stringify({ ...bed, z: 275 }));
  });

  it('renders Prepare and Preview for a Ready cloud profile with serialized coordinates', async () => {
    await selectMachine();
    expect(await screen.findByTestId('model-bed')).toHaveTextContent(JSON.stringify(bed));
    expect(screen.getByText(/Readiness: acknowledgement_required/)).toBeInTheDocument();
    expect(screen.getByText(/Filament 1: source material unknown, selected profile material unknown/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(await screen.findByTestId('gcode-bed')).toHaveTextContent(JSON.stringify(bed));
    expect(screen.queryByText(/Select a printer profile with bed geometry/)).not.toBeInTheDocument();
  });

  it('keeps the model visible on revision failure, then restores its bed without reselecting', async () => {
    vi.mocked(api.getSlicerCatalogRevision).mockRejectedValueOnce(new Error('Service unavailable'));
    await selectMachine();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the bed for Cloud machine.');
    expect(screen.getByRole('alert')).toHaveTextContent('Profile revision 101');
    expect(screen.getByTestId('model-bed')).toHaveTextContent('null');
    expect(screen.getByTestId('model-bed')).toHaveAttribute('data-bed', 'false');
    expect(screen.getByTestId('model-bed')).toHaveAttribute('data-centered', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading bed' }));
    expect(await screen.findByTestId('model-bed')).toHaveTextContent(JSON.stringify(bed));
    expect(api.getSlicerCatalogRevision).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('combobox', { name: 'Exact slicer binding' })).toHaveValue('5');
    expect(screen.getByTestId('model-bed')).toHaveAttribute('data-bed', 'true');
    expect(screen.getByTestId('model-bed')).toHaveAttribute('data-centered', 'true');
    expect(screen.queryByText(/printer fit and placement are unverified/)).not.toBeInTheDocument();
  });

  it('identifies an invalid field instead of claiming that no printer is selected', async () => {
    vi.mocked(api.getSlicerCatalogRevision).mockResolvedValue({ ...revision, content: { printable_area: 'broken', printable_height: '300' } });
    await selectMachine();
    expect(await screen.findByRole('alert')).toHaveTextContent('Bed geometry is unavailable for Cloud machine.');
    expect(screen.getByRole('alert')).toHaveTextContent('invalid printable_area or bed_shape coordinates');
    expect(screen.getByTestId('model-bed')).toHaveTextContent('null');
    expect(screen.getByTestId('model-bed')).toHaveAttribute('data-bed', 'false');
    expect(screen.getByTestId('model-bed')).toHaveAttribute('data-centered', 'false');
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('invalid printable_area');
    expect(screen.queryByText('Slice plate to generate preview.')).not.toBeInTheDocument();
    expect(screen.getByTestId('gcode-bed')).toHaveAttribute('data-bed', 'false');
    expect(screen.getByText(/printer fit and placement are unverified/)).toBeInTheDocument();
  });

  it('reports a missing height while preserving the bedless model preview', async () => {
    vi.mocked(api.getSlicerCatalogRevision).mockResolvedValue({
      ...revision, content: { printable_area: revision.content.printable_area },
    });
    await selectMachine();
    expect(await screen.findByRole('alert')).toHaveTextContent('no printable_height or max_print_height');
    expect(screen.getByRole('alert')).toHaveTextContent('Profile revision 101');
    expect(screen.getByTestId('model-bed')).toHaveTextContent('null');
    expect(screen.getByTestId('model-bed')).toHaveAttribute('data-bed', 'false');
    expect(screen.getByTestId('model-bed')).toHaveAttribute('data-centered', 'false');
  });

  it('shows loading while the selected revision is pending', async () => {
    let finish!: (value: typeof revision) => void;
    vi.mocked(api.getSlicerCatalogRevision).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await selectMachine();
    await waitFor(() => expect(api.getSlicerCatalogRevision).toHaveBeenCalledWith(101));
    expect(screen.getByText('Loading selected bed…')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-bed')).toHaveAttribute('data-bed', 'false');
    expect(screen.getByText(/printer fit and placement are unverified/)).toBeInTheDocument();
    await act(async () => finish(revision));
    expect(await screen.findByTestId('model-bed')).toHaveTextContent(JSON.stringify(bed));
  });
});
