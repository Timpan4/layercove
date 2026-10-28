import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { GuidedCalibration } from '../../pages/GuidedCalibration';
import { server } from '../mocks/server';
import type { CalibrationSession, Printer, SlicerCatalogProfile } from '../../api/client';

const printer = { id: 1, name: 'Dogge printer', provider: 'bambu', is_active: true } as Printer;
const profile = (profile_id: number, profile_type: SlicerCatalogProfile['profile_type'], display_name: string, revision_id = profile_id) =>
  ({ profile_id, revision_id, profile_type, display_name, remote_profile_id: `remote-${profile_id}`, tombstoned: false }) as SlicerCatalogProfile;
const baseSession: CalibrationSession = { id: 1, printer_id: 1, filament_profile_id: 1, filament_revision_id: 1,
  nozzle_diameter: 0.4, tool_index: 0, parameters: {}, setting_limits: {}, results: {}, runs: {}, prints: {},
  saved_profile_id: null, version: 1, created_at: '', updated_at: '' };

function renderCalibration(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter initialEntries={[url]}>
    <QueryClientProvider client={client}><GuidedCalibration printers={[printer]} /></QueryClientProvider>
  </MemoryRouter>);
}

// Failure mode: the filament list ignores the inventory, and a printer without a
// slicer profile leaves Generate disabled with no reason or way forward.
it('offers inventory spools and points to printer profile setup', async () => {
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([profile(7, 'filament', 'Bambu ASA @BBL P1S')])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([])),
    http.get('*/api/v1/settings/spoolman', () => HttpResponse.json({ spoolman_enabled: 'false', spoolman_url: '' })),
    http.get('*/api/v1/inventory/spools', () => HttpResponse.json([
      { id: 3, brand: 'Polymaker', material: 'ASA', subtype: null, color_name: 'Grey', slicer_filament: 'GFSB01', slicer_filament_name: 'Bambu ASA', archived_at: null },
      { id: 4, brand: 'Acme', material: 'PETG', subtype: null, color_name: 'Red', slicer_filament: 'PFUS1', slicer_filament_name: 'Acme PETG', archived_at: null },
    ])),
  );
  renderCalibration('/profiles?calibration=guided');
  fireEvent.change(screen.getByLabelText('Printer'), { target: { value: '1' } });
  expect(await screen.findByRole('link', { name: 'Set up printer profiles on the Printers page' })).toHaveAttribute('href', '/#slicer-binding-1');
  expect(await screen.findByRole('option', { name: 'Polymaker ASA Grey · Bambu ASA @BBL P1S' })).toBeEnabled();
  expect(screen.getByRole('option', { name: 'Acme PETG Red · no matching slicer profile' })).toBeDisabled();
});

// Failure mode: a synced local or Orca preset waits for catalog review, so its spool
// reads as "no matching slicer profile" and the user cannot tell what to do.
it('shows filament profiles that wait for catalog approval and links to the review', async () => {
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', ({ request }) => HttpResponse.json(new URL(request.url).searchParams.get('include_inactive') === 'true'
      ? [{ ...profile(7, 'filament', 'Bambu ASA @BBL P1S'), active: true, review_state: 'approved' },
        { ...profile(8, 'filament', 'Dogge PETG'), remote_profile_id: '12', source: 'local', active: false, review_state: 'pending' },
        { ...profile(9, 'filament', 'Orca PLA'), source: 'orca_cloud', active: false, review_state: 'approved' },
        { ...profile(10, 'filament', 'Rejected TPU'), active: false, review_state: 'rejected' },
        // Bundled presets are activated one by one on purpose; listing them would bury the user's own.
        { ...profile(11, 'filament', 'Bambu PLA Basic @BBL P1S'), source: 'standard', active: false, review_state: 'approved' }]
      : [profile(7, 'filament', 'Bambu ASA @BBL P1S')])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([])),
    http.get('*/api/v1/settings/spoolman', () => HttpResponse.json({ spoolman_enabled: 'false', spoolman_url: '' })),
    http.get('*/api/v1/inventory/spools', () => HttpResponse.json([
      { id: 4, brand: 'Acme', material: 'PETG', subtype: null, color_name: 'Red', slicer_filament: '12', slicer_filament_name: 'Dogge PETG', archived_at: null },
    ])),
  );
  renderCalibration('/profiles?calibration=guided');
  expect(await screen.findByRole('option', { name: 'Acme PETG Red · Dogge PETG · waiting for approval' })).toBeDisabled();
  expect(screen.getByRole('option', { name: 'Orca PLA' })).toBeDisabled();
  expect(screen.queryByRole('option', { name: 'Rejected TPU' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'Bambu PLA Basic @BBL P1S' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Review them in the Shared catalog' })).toHaveAttribute('href', '/profiles?tab=catalog');
});

const binding = (id: number, profile_name: string) => ({ id, printer_id: 1, profile_id: id + 100, profile_name, expected_nozzle_diameter: 0.4,
  tool_index: 0, default_process_profile_id: null, is_active: true, readiness: { state: 'ready', reason_codes: [] } });
const groups = (compatible: number[]) => ({ selected_printer: compatible.map(profile_id => ({ profile_id, classification: { selectable: true, acknowledgement_required: false, reason_details: [] } })),
  other_installed_printers: [], unclassified: [], incompatible: [] });

// Failure mode: a printer with one 0.4 mm profile but a 0.6 mm nozzle fitted cannot start
// a hand-recorded session, because clearing the profile selects it again.
it('lets the user clear an automatically selected printer profile and enter the nozzle', async () => {
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([binding(5, 'Bambu Lab P1S 0.4 nozzle')])),
    http.get('*/api/v1/slicer/catalog/printers/1/classification', () => HttpResponse.json(groups([]))),
    http.get('*/api/v1/settings/spoolman', () => HttpResponse.json({ spoolman_enabled: 'false', spoolman_url: '' })),
    http.get('*/api/v1/inventory/spools', () => HttpResponse.json([])),
  );
  renderCalibration('/profiles?calibration=guided');
  fireEvent.change(screen.getByLabelText('Printer'), { target: { value: '1' } });
  await waitFor(() => expect(screen.getByLabelText('Printer profile')).toHaveValue('5'));
  fireEvent.change(screen.getByLabelText('Printer profile'), { target: { value: '' } });
  await waitFor(() => expect(screen.getByLabelText('Nozzle diameter (mm)')).toBeEnabled());
  expect(screen.getByLabelText('Printer profile')).toHaveValue('');
});

it('keeps a cleared printer profile cleared after the session starts', async () => {
  const started = { ...baseSession, id: 12, filament_profile_id: 7, filament_revision_id: 7 };
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([])),
    http.post('*/api/v1/calibration/sessions', () => HttpResponse.json(started, { status: 201 })),
    http.get('*/api/v1/calibration/sessions/12', () => HttpResponse.json(started)),
    http.get('*/api/v1/calibration/sessions/12/evidence', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([{ ...profile(7, 'filament', 'Generic ASA'), active: true }])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([binding(5, 'Bambu Lab P1S 0.4 nozzle')])),
    http.get('*/api/v1/slicer/catalog/printers/1/classification', () => HttpResponse.json(groups([7]))),
    http.get('*/api/v1/slicer/catalog/revisions/7', () => HttpResponse.json({ content: {} })),
    http.get('*/api/v1/printers/1/status', () => HttpResponse.json({ ams: [] })),
    http.get('*/api/v1/settings/spoolman', () => HttpResponse.json({ spoolman_enabled: 'false', spoolman_url: '' })),
    http.get('*/api/v1/inventory/spools', () => HttpResponse.json([])),
  );
  renderCalibration('/profiles?calibration=guided');
  fireEvent.change(screen.getByLabelText('Printer'), { target: { value: '1' } });
  await waitFor(() => expect(screen.getByLabelText('Printer profile')).toHaveValue('5'));
  await screen.findByRole('option', { name: 'Generic ASA' });
  fireEvent.change(screen.getByLabelText('Filament'), { target: { value: 'profile:7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start calibration' }));
  await screen.findByRole('button', { name: 'Delete session' });
  fireEvent.change(screen.getByLabelText('Printer profile'), { target: { value: '' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(screen.getByLabelText('Printer profile')).toHaveValue('');
});

// Failure mode: switching the printer profile changes which profile a spool matches, the
// field shows nothing, yet the hidden earlier match still starts the session.
it('drops a spool choice that no longer matches after the printer profile changes', async () => {
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([profile(7, 'filament', 'Bambu ASA @BBL P1S'), profile(8, 'filament', 'Bambu ASA @BBL X1C')])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([binding(5, 'X1C profile'), binding(6, 'P1S profile')])),
    http.get('*/api/v1/slicer/catalog/printers/1/classification', ({ request }) =>
      HttpResponse.json(groups(new URL(request.url).searchParams.get('binding_id') === '5' ? [8] : [7]))),
    http.get('*/api/v1/settings/spoolman', () => HttpResponse.json({ spoolman_enabled: 'false', spoolman_url: '' })),
    http.get('*/api/v1/inventory/spools', () => HttpResponse.json([
      { id: 3, brand: 'Polymaker', material: 'ASA', subtype: null, color_name: 'Grey', slicer_filament: 'GFSB01', slicer_filament_name: 'Bambu ASA', archived_at: null },
    ])),
  );
  renderCalibration('/profiles?calibration=guided');
  fireEvent.change(screen.getByLabelText('Printer'), { target: { value: '1' } });
  await screen.findByRole('option', { name: 'X1C profile · 0.4 mm' });
  fireEvent.change(screen.getByLabelText('Printer profile'), { target: { value: '5' } });
  // Wait for the compatibility check, which narrows the spool to its X1C profile.
  await waitFor(() => expect(screen.queryByRole('option', { name: 'Polymaker ASA Grey · Bambu ASA @BBL P1S' })).not.toBeInTheDocument());
  fireEvent.change(screen.getByLabelText('Filament'), { target: { value: 'spool:3:8' } });
  expect(screen.getByRole('button', { name: 'Start calibration' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Printer profile'), { target: { value: '6' } });
  await waitFor(() => expect(screen.queryByRole('option', { name: 'Polymaker ASA Grey · Bambu ASA @BBL X1C' })).not.toBeInTheDocument());
  expect(screen.getByRole('option', { name: 'Polymaker ASA Grey · Bambu ASA @BBL P1S' })).toBeInTheDocument();
  expect(screen.getByLabelText('Filament')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Start calibration' })).toBeDisabled();
});

it('explains why a test cannot be generated or printed yet', async () => {
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([baseSession])),
    http.get('*/api/v1/calibration/sessions/1', () => HttpResponse.json(baseSession)),
    http.get('*/api/v1/calibration/sessions/1/evidence', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([profile(1, 'filament', 'Generic ASA')])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([{ id: 5, printer_id: 1, profile_id: 9, profile_name: 'Bambu Lab P1S 0.4 nozzle',
      expected_nozzle_diameter: 0.4, tool_index: 0, default_process_profile_id: null, is_active: true, readiness: { state: 'ready', reason_codes: [] } }])),
    http.get('*/api/v1/slicer/catalog/printers/1/classification', () => HttpResponse.json({ selected_printer: [], other_installed_printers: [], unclassified: [], incompatible: [] })),
    http.get('*/api/v1/slicer/catalog/revisions/1', () => HttpResponse.json({ content: {} })),
    http.get('*/api/v1/printers/1/status', () => HttpResponse.json({ ams: [] })),
  );
  renderCalibration('/profiles?calibration=guided&calibrationSession=1');
  // The only matching printer profile is selected for the user.
  await waitFor(() => expect(screen.getByLabelText('Printer profile')).toHaveValue('5'));
  expect(await screen.findByText('Choose a process.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generate test' })).toBeDisabled();
  expect(screen.getByText('Save the test values and generate the test.')).toBeInTheDocument();
});

// Failure modes: a deleted default process still enables Generate, and a session whose
// filament profile was removed offers Generate and Save that the server rejects.
it('blocks generating with a removed process or filament profile', async () => {
  const withProcess = (deletedFilament: boolean) => {
    server.use(
      http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([baseSession])),
      http.get('*/api/v1/calibration/sessions/1', () => HttpResponse.json({ ...baseSession, parameters: { temperature: { lowest: 200, highest: 220, increment: 5, baseline: 210 } } })),
      http.get('*/api/v1/calibration/sessions/1/evidence', () => HttpResponse.json([])),
      http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json(deletedFilament ? [] : [profile(1, 'filament', 'Generic ASA')])),
      http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([{ ...binding(5, 'Bambu Lab P1S 0.4 nozzle'), default_process_profile_id: 44 }])),
      http.get('*/api/v1/slicer/catalog/printers/1/classification', () => HttpResponse.json(groups([1]))),
      http.get('*/api/v1/slicer/catalog/revisions/1', () => HttpResponse.json({ content: { nozzle_temperature: ['210'] } })),
      http.get('*/api/v1/printers/1/status', () => HttpResponse.json({ ams: [] })),
    );
  };
  withProcess(false);
  const first = renderCalibration('/profiles?calibration=guided&calibrationSession=1');
  await waitFor(() => expect(screen.getByLabelText('Printer profile')).toHaveValue('5'));
  expect(await screen.findByText('Choose a process.')).toBeInTheDocument();
  first.unmount();

  withProcess(true);
  renderCalibration('/profiles?calibration=guided&calibrationSession=1');
  expect(await screen.findByText(/filament profile is no longer available/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Generate test' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Save profile copy' })).toBeDisabled();
});

// Failure mode: saving a calibrated copy required sharing it with every user.
it('saves a finished calibration as a private copy unless it is shared', async () => {
  const results = { temperature: 215, flow_rate: 0.98, pressure_advance: 0.02, retraction: 0.8, volumetric_flow: 15 };
  let body: unknown;
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([baseSession])),
    http.get('*/api/v1/calibration/sessions/1', () => HttpResponse.json({ ...baseSession, results })),
    http.get('*/api/v1/calibration/sessions/1/evidence', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([profile(1, 'filament', 'Generic ASA')])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([])),
    http.get('*/api/v1/printers/1/status', () => HttpResponse.json({ ams: [] })),
    http.post('*/api/v1/calibration/sessions/1/save', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ ...baseSession, results, saved_profile_id: 9, version: 2 });
    }),
  );
  renderCalibration('/profiles?calibration=guided&calibrationSession=1');
  const save = await screen.findByRole('button', { name: 'Save profile copy' });
  fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'ASA calibrated' } });
  await waitFor(() => expect(save).toBeEnabled());
  expect(screen.getByRole('checkbox', { name: 'Share with everyone on this installation' })).not.toBeChecked();
  fireEvent.click(save);
  await waitFor(() => expect(body).toMatchObject({ share_local_copy: false }));
});

// Failure mode: a photo taken before the first test is generated vanishes from the step.
it('keeps photos taken before generation visible on the step', async () => {
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([baseSession])),
    http.get('*/api/v1/calibration/sessions/1', () => HttpResponse.json({ ...baseSession, runs: { temperature: 70 } })),
    http.get('*/api/v1/calibration/sessions/1/evidence', () => HttpResponse.json([
      { id: 3, session_id: 1, step: 'temperature', source: 'upload', run_id: null, print_id: null, created_at: '' },
      { id: 4, session_id: 1, step: 'temperature', source: 'upload', run_id: 69, print_id: null, created_at: '' },
    ])),
    http.get('*/api/v1/calibration/sessions/1/evidence/:photo/image', () => new HttpResponse(new Blob(['x'], { type: 'image/png' }))),
    http.get('*/api/v1/slice-jobs/70', () => HttpResponse.json({ id: 70, status: 'completed' })),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([profile(1, 'filament', 'Generic ASA')])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/revisions/1', () => HttpResponse.json({ content: {} })),
    http.get('*/api/v1/printers/1/status', () => HttpResponse.json({ ams: [] })),
  );
  renderCalibration('/profiles?calibration=guided&calibrationSession=1');
  expect(await screen.findByText('Photo saved with this step. Choose the result yourself.')).toBeInTheDocument();
});

it('lets a session move to the filament profile version that replaced it', async () => {
  let switched = false;
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([baseSession])),
    http.get('*/api/v1/calibration/sessions/1', () => HttpResponse.json(baseSession)),
    http.get('*/api/v1/calibration/sessions/1/evidence', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([profile(1, 'filament', 'Generic ASA', 2)])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/revisions/:id', () => HttpResponse.json({ content: {} })),
    http.get('*/api/v1/printers/1/status', () => HttpResponse.json({ ams: [] })),
    http.post('*/api/v1/calibration/sessions/1/filament-revision', () => {
      switched = true;
      return HttpResponse.json({ ...baseSession, filament_revision_id: 2, version: 2 });
    }),
  );
  renderCalibration('/profiles?calibration=guided&calibrationSession=1');
  expect(await screen.findAllByText('Switch to the current filament version first.')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Use current filament version' }));
  await waitFor(() => expect(switched).toBe(true));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Use current filament version' })).not.toBeInTheDocument());
});

// Failure modes: a range save erases a draft, or step navigation keeps another step's draft.
it('preserves a draft result through a range save and loads the next step separately', async () => {
  let session: CalibrationSession = { id: 1, printer_id: 1, filament_profile_id: 1, filament_revision_id: 1,
    nozzle_diameter: 0.4, tool_index: 0, parameters: {}, setting_limits: {}, results: {}, runs: {}, prints: {},
    saved_profile_id: null, version: 1, created_at: '', updated_at: '' };
  let saved = false;
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([session])),
    http.get('*/api/v1/calibration/sessions/1', () => HttpResponse.json(session)),
    http.get('*/api/v1/calibration/sessions/1/evidence', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/revisions/1', () => HttpResponse.json({ content: { nozzle_temperature: ['210'], filament_flow_ratio: ['1'] } })),
    http.get('*/api/v1/printers/1/status', () => HttpResponse.json({ ams: [] })),
    http.put('*/api/v1/calibration/sessions/1/parameters/temperature', async ({ request }) => {
      const { version, ...values } = await request.json() as { version: number; lowest: number; highest: number; increment: number; baseline: number };
      session = { ...session, version: version + 1, parameters: { temperature: values } };
      saved = true;
      return HttpResponse.json(session);
    }),
    http.put('*/api/v1/calibration/sessions/1/results/temperature', () => {
      session = { ...session, version: session.version + 1, results: { temperature: 210 } };
      return HttpResponse.json(session);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={['/profiles?calibration=guided&calibrationSession=1']}>
    <QueryClientProvider client={client}><GuidedCalibration printers={[]} /></QueryClientProvider>
  </MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText('Baseline value (°C)')).toHaveValue(210));
  fireEvent.change(screen.getByLabelText('Lowest test value (°C)'), { target: { value: '200' } });
  fireEvent.change(screen.getByLabelText('Highest test value (°C)'), { target: { value: '220' } });
  fireEvent.change(screen.getByLabelText('Step size (°C)'), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText('Custom result (°C)'), { target: { value: '210' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save test values' }));
  await waitFor(() => { expect(saved).toBe(true); expect(screen.getByRole('button', { name: 'Save test values' })).toBeEnabled(); });
  expect(screen.getByLabelText('Custom result (°C)')).toHaveValue(210);
  fireEvent.change(screen.getByLabelText('Lowest test value (°C)'), { target: { value: '205' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use value' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit result' }));
  expect(screen.getByLabelText('Lowest test value (°C)')).toHaveValue(205);
  fireEvent.click(screen.getByRole('button', { name: 'Use value' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Next: Flow rate' }));
  await waitFor(() => expect(screen.getByLabelText('Custom result (ratio)')).toHaveValue(null));
  expect(screen.getByLabelText('Baseline value (ratio)')).toHaveValue(1);
});
