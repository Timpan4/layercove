import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrintersPage } from '../../pages/PrintersPage';

const bambuCapabilities = {
  upload_gcode: false, upload_3mf: true, start_print: true, pause: true, resume: true, cancel: true,
  emergency_stop: false, camera: true, bed_temperature: true, extruder_temperature: true,
  chamber_temperature: true, ams: true, plate_selection: true, speed_control: true,
  firmware_information: true, object_cancellation: true,
};

const moonrakerCapabilities = {
  upload_gcode: true, upload_3mf: false, start_print: true, pause: true, resume: true, cancel: true,
  emergency_stop: true, camera: false, bed_temperature: false, extruder_temperature: false,
  chamber_temperature: false, ams: false, plate_selection: false, speed_control: false,
  firmware_information: false, object_cancellation: false,
};

const status = {
  connected: true,
  state: 'printing',
  current_print: 'cube.gcode',
  subtask_name: 'cube.gcode',
  current_archive_id: null,
  current_plate_id: null,
  gcode_file: 'cube.gcode',
  progress: 45,
  remaining_time: 12,
  layer_num: 4,
  total_layers: 10,
  temperatures: { nozzle: 210, bed: 60 },
  cover_url: null,
  hms_errors: [],
  ams: [],
  ams_exists: false,
  vt_tray: [],
  store_to_sdcard: false,
  timelapse: false,
  ipcam: false,
  wifi_signal: null,
  wired_network: false,
  door_open: false,
  nozzles: [],
  nozzle_rack: [],
  print_options: null,
  stg_cur: -1,
  stg_cur_name: null,
  airduct_mode: 0,
  speed_level: 2,
  chamber_light: false,
  active_extruder: 0,
  ams_mapping: [],
  ams_extruder_map: {},
  fila_switch: null,
  tray_now: 255,
  ams_status_main: 0,
  ams_status_sub: 0,
  mc_print_sub_stage: 0,
  last_ams_update: 0,
  printable_objects_count: 0,
  cooling_fan_speed: null,
  big_fan1_speed: null,
  big_fan2_speed: null,
  heatbreak_fan_speed: null,
  firmware_version: null,
  developer_mode: null,
  ams_filament_backup: null,
  awaiting_plate_clear: false,
  supports_drying: false,
};

function printer(provider: 'bambu' | 'moonraker', capabilities = provider === 'bambu' ? bambuCapabilities : moonrakerCapabilities) {
  return {
    id: 41,
    name: provider === 'bambu' ? 'Bambu One' : 'Klipper One',
    provider,
    serial_number: provider === 'bambu' ? 'BAMBU-41' : null,
    ip_address: provider === 'bambu' ? '192.168.1.41' : null,
    model: provider === 'bambu' ? 'X1C' : 'Voron',
    location: null,
    nozzle_count: 1,
    is_active: true,
    auto_archive: true,
    external_camera_url: provider === 'moonraker' ? 'https://camera.invalid/token=secret' : null,
    external_camera_type: provider === 'moonraker' ? 'mjpeg' : null,
    external_camera_enabled: provider === 'moonraker',
    external_camera_snapshot_url: null,
    camera_rotation: 0,
    plate_detection_enabled: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    capabilities,
    moonraker_config: provider === 'moonraker'
      ? { base_url: 'https://klipper.local:7125', websocket_url_override: null, tls_verify: true, api_key_configured: true, authorization_configured: false }
      : null,
  };
}

function setupPage(item = printer('moonraker'), currentStatus = status) {
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([item])),
    http.get('/api/v1/printers/:id/status', () => HttpResponse.json(currentStatus)),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.get('/api/v1/settings/ui-preferences', () => HttpResponse.json({ require_plate_clear: false })),
  );
  render(<PrintersPage />);
}

async function openMoonrakerEdit(item = printer('moonraker')) {
  const user = userEvent.setup();
  setupPage(item);
  await screen.findByText('Klipper One');
  const menu = [...document.querySelectorAll('button')].find((button) =>
    button.querySelector('.lucide-ellipsis-vertical'),
  );
  await user.click(menu!);
  await user.click(await screen.findByRole('button', { name: /^edit$/i }));
  await screen.findByText('Edit Printer');
  return user;
}

describe('provider capability UI', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps Bambu capability controls and capability queries', async () => {
    const firmwareRequested = vi.fn();
    const slotPresetsRequested = vi.fn();
    const labelsRequested = vi.fn();
    const uploadRequested = vi.fn();
    server.use(
      http.get('/api/v1/firmware/updates/41', () => {
        firmwareRequested();
        return HttpResponse.json({ current_version: null, latest_version: null, update_available: false });
      }),
      http.get('/api/v1/printers/41/slot-presets', () => {
        slotPresetsRequested();
        return HttpResponse.json({});
      }),
      http.get('/api/v1/printers/41/ams-labels', () => { labelsRequested(); return HttpResponse.json({}); }),
      http.post('/api/v1/library/files', () => {
        uploadRequested();
        return HttpResponse.json({ id: 9, filename: 'cube.gcode.3mf', metadata: {} });
      }),
    );
    setupPage(printer('bambu'), { ...status, state: 'IDLE', current_print: null });

    expect(await screen.findByText('Bambu One')).toBeInTheDocument();
    expect(await screen.findByTestId('speed-control')).toBeInTheDocument();
    expect(screen.getAllByTitle(/view heater history/i)).not.toHaveLength(0);
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^print$/i }));
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(picker).toHaveAttribute('accept', '.3mf');
    fireEvent.change(picker, { target: { files: [new File(['gcode'], 'cube.gcode')] } });
    const rejection = 'Only .gcode.3mf files can be printed on this printer';
    expect(await screen.findByText(rejection)).toBeInTheDocument();
    expect(uploadRequested).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    const card = document.getElementById('printer-card-41')!;
    fireEvent.dragEnter(card, { dataTransfer: { files: [] } });
    expect(screen.getByText(/drop to print/i)).toBeInTheDocument();
    fireEvent.drop(card, { dataTransfer: { files: [new File(['gcode'], 'cube.gcode')] } });
    expect(await screen.findByText(rejection)).toBeInTheDocument();
    expect(uploadRequested).not.toHaveBeenCalled();
    fireEvent.drop(card, { dataTransfer: { files: [new File(['3mf'], 'cube.gcode.3mf')] } });
    await waitFor(() => expect(uploadRequested).toHaveBeenCalledOnce());
    await waitFor(() => expect(firmwareRequested).toHaveBeenCalledOnce());
    await waitFor(() => expect(slotPresetsRequested).toHaveBeenCalledOnce());
    await waitFor(() => expect(labelsRequested).toHaveBeenCalledOnce());
  });

  it('removes Moonraker unsupported controls and skips their APIs while retaining shared controls', async () => {
    const firmwareRequested = vi.fn();
    const slotPresetsRequested = vi.fn();
    const labelsRequested = vi.fn();
    const objectsRequested = vi.fn();
    server.use(
      http.get('/api/v1/firmware/updates/41', () => { firmwareRequested(); return HttpResponse.json({}); }),
      http.get('/api/v1/printers/41/slot-presets', () => { slotPresetsRequested(); return HttpResponse.json({}); }),
      http.get('/api/v1/printers/41/ams-labels', () => { labelsRequested(); return HttpResponse.json({}); }),
      http.get('/api/v1/printers/41/print/objects', () => { objectsRequested(); return HttpResponse.json({ objects: [] }); }),
    );
    setupPage();

    expect(await screen.findByText('Klipper One')).toBeInTheDocument();
    expect(screen.queryByTestId('speed-control')).not.toBeInTheDocument();
    expect(screen.queryByTitle(/camera/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/view heater history/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OK' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /pause/i })).toBeInTheDocument();
    expect(screen.getAllByText('cube.gcode').length).toBeGreaterThan(0);
    expect(screen.getAllByText('45%').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^print$/i })).not.toBeInTheDocument();
    const menu = [...document.querySelectorAll('button')].find((button) =>
      button.querySelector('.lucide-ellipsis-vertical'),
    );
    await userEvent.click(menu!);
    expect(screen.queryByRole('button', { name: /mqtt debug/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run diagnostics/i })).not.toBeInTheDocument();
    expect(firmwareRequested).not.toHaveBeenCalled();
    expect(slotPresetsRequested).not.toHaveBeenCalled();
    expect(labelsRequested).not.toHaveBeenCalled();
    expect(objectsRequested).not.toHaveBeenCalled();
  });

  it('normalizes paused jobs and hides start/upload when capabilities deny them', async () => {
    const user = userEvent.setup();
    const resumeRequested = vi.fn();
    server.use(http.post('/api/v1/printers/41/print/resume', () => {
      resumeRequested();
      return HttpResponse.json({ success: true, message: 'Resumed' });
    }));
    setupPage(
      printer('moonraker', { ...moonrakerCapabilities, upload_gcode: false, start_print: false }),
      { ...status, state: 'paused' },
    );

    expect(await screen.findByText('Klipper One')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /resume/i })).toBeInTheDocument();
    expect(screen.getAllByText('cube.gcode').length).toBeGreaterThan(0);
    expect(screen.getAllByText('45%').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^stop$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^print$/i })).not.toBeInTheDocument();
    await user.click(screen.getByTitle('Select'));
    await user.click(await screen.findByRole('button', { name: /select all/i }));
    const resumeButtons = screen.getAllByRole('button', { name: /resume/i });
    await user.click(resumeButtons.at(-1)!);
    await waitFor(() => expect(resumeRequested).toHaveBeenCalledOnce());
  });

  it('hides idle print/upload action when start or upload capability is missing', async () => {
    setupPage(
      printer('moonraker', { ...moonrakerCapabilities, upload_gcode: false, start_print: false }),
      { ...status, state: 'IDLE', current_print: null },
    );

    expect(await screen.findByText('Klipper One')).toBeInTheDocument();
    await screen.findAllByText('Idle');
    expect(screen.queryByRole('button', { name: /^print$/i })).not.toBeInTheDocument();
  });

  it('derives gcode-only picker accept and rejects 3MF selection and drop', async () => {
    const uploadRequested = vi.fn();
    server.use(http.post('/api/v1/library/files', () => {
      uploadRequested();
      return HttpResponse.json({ id: 10, filename: 'cube.gcode.3mf', metadata: {} });
    }));
    setupPage(printer('moonraker'), { ...status, state: 'IDLE', current_print: null });

    await userEvent.click(await screen.findByRole('button', { name: /^print$/i }));
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(picker).toHaveAttribute('accept', '.gcode');
    fireEvent.change(picker, { target: { files: [new File(['3mf'], 'cube.gcode.3mf')] } });
    const rejection = 'Only .gcode files can be printed on this printer';
    expect(await screen.findByText(rejection)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    const card = document.getElementById('printer-card-41')!;
    fireEvent.drop(card, { dataTransfer: { files: [new File(['3mf'], 'cube.gcode.3mf')] } });
    expect(await screen.findByText(rejection)).toBeInTheDocument();
    expect(uploadRequested).not.toHaveBeenCalled();
  });

  it('names both accepted formats when both upload capabilities are enabled', async () => {
    setupPage(
      printer('bambu', { ...bambuCapabilities, upload_gcode: true }),
      { ...status, state: 'IDLE', current_print: null },
    );

    await userEvent.click(await screen.findByRole('button', { name: /^print$/i }));
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(picker).toHaveAttribute('accept', '.gcode,.3mf');
    fireEvent.change(picker, { target: { files: [new File(['stl'], 'cube.stl')] } });
    expect(await screen.findByText('Only .gcode and .gcode.3mf files can be printed')).toBeInTheDocument();
  });

  it('treats preparing as busy while keeping cancel available', async () => {
    setupPage(printer('moonraker'), { ...status, state: 'PREPARING' });

    expect(await screen.findByRole('button', { name: /^stop$/i })).toBeInTheDocument();
    expect(screen.getAllByText('cube.gcode').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^print$/i })).not.toBeInTheDocument();
    const card = document.getElementById('printer-card-41')!;
    fireEvent.dragEnter(card, { dataTransfer: { files: [] } });
    expect(screen.getByText(/printer busy/i)).toBeInTheDocument();
  });

  it('uses only same-origin camera route when camera capability is enabled', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    setupPage(printer('moonraker', { ...moonrakerCapabilities, camera: true }));

    const camera = await screen.findByTitle(/open camera/i);
    await userEvent.click(camera);
    expect(open).toHaveBeenCalledWith('/camera/41', 'camera-41', expect.any(String));
    expect(document.body.textContent).not.toContain('camera.invalid');
    expect(document.body.textContent).not.toContain('token=secret');
    open.mockRestore();
  });
});

describe('Moonraker onboarding and guarded stop', () => {
  it('keeps provider destination and add controls usable at phone widths', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([])),
      http.get('/api/v1/discovery/info', () => HttpResponse.json({ is_docker: false, subnets: [] })),
    );
    render(<PrintersPage />);
    await user.click(await screen.findByText(/add printer/i));

    for (const width of [320, 375, 390, 414]) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      window.dispatchEvent(new Event('resize'));
      const moonraker = screen.getByRole('radio', { name: /moonraker/i });
      expect(moonraker).toBeVisible();
      expect(moonraker.closest('label')).toHaveClass('min-h-11');
      expect(screen.getAllByRole('button', { name: /add printer/i }).some((button) => button.getAttribute('type') === 'submit')).toBe(true);
    }
  });

  it('omits blank secrets, keeps authentication choices exclusive, and surfaces safe creation errors', async () => {
    const user = userEvent.setup();
    let body: Record<string, unknown> | undefined;
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([])),
      http.get('/api/v1/discovery/info', () => HttpResponse.json({ is_docker: false, subnets: [] })),
      http.post('/api/v1/printers/', async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ detail: { message: 'Moonraker rejected configured credentials.' } }, { status: 400 });
      }),
    );
    render(<PrintersPage />);
    await user.click(await screen.findByText(/add printer/i));
    await user.click(screen.getByRole('radio', { name: /moonraker/i }));
    await user.type(screen.getByPlaceholderText('My Printer'), 'Moon');
    await user.type(screen.getByLabelText(/moonraker base url/i), 'https://klipper.local:7125');
    await user.click(screen.getByLabelText(/enable external camera/i));
    expect(screen.getByLabelText('External camera URL')).toBeInTheDocument();
    expect(screen.getByLabelText('External camera type')).toBeInTheDocument();
    const apiKey = screen.getByLabelText(/api key/i);
    const authorization = screen.getByLabelText(/^authorization$/i);
    await user.type(apiKey, 'key');
    expect(authorization).toBeDisabled();
    await user.clear(apiKey);
    await user.click(screen.getAllByRole('button', { name: /add printer/i }).find((button) => button.getAttribute('type') === 'submit')!);
    await waitFor(() => expect(body).toBeDefined());
    expect((body!.moonraker_config as Record<string, unknown>).api_key).toBeUndefined();
    expect((body!.moonraker_config as Record<string, unknown>).authorization).toBeUndefined();
    expect(await screen.findByText(/Moonraker rejected configured credentials/i)).toBeInTheDocument();
  });

  it('keeps redacted edit secrets out of the DOM, retains blanks, and reports stored test results', async () => {
    let patchBody: Record<string, unknown> | undefined;
    let connectionFails = false;
    server.use(
      http.patch('/api/v1/printers/41', async ({ request }) => {
        patchBody = await request.json() as Record<string, unknown>;
        return HttpResponse.json(printer('moonraker'));
      }),
      http.post('/api/v1/printers/41/test-connection', () => connectionFails
        ? HttpResponse.json({ detail: 'Stored connection failed.' }, { status: 503 })
        : HttpResponse.json({ success: true, message: 'Stored connection works.' })),
    );

    const redactedPrinter = {
      ...printer('moonraker'),
      external_camera_enabled: false,
      external_camera_url: null,
      moonraker_config: { ...printer('moonraker').moonraker_config, api_key: 'api-key-value' },
    };
    const user = await openMoonrakerEdit(redactedPrinter);
    expect(document.body.textContent).not.toContain('api-key-value');
    expect(screen.getByLabelText(/moonraker base url/i)).toHaveValue('https://klipper.local:7125');
    expect(screen.getByLabelText(/api key/i)).toHaveValue('');
    await user.click(screen.getByLabelText(/enable external camera/i));
    expect(screen.getByLabelText('External camera URL')).toBeInTheDocument();
    expect(screen.getByLabelText('External camera type')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/secret retained/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /test.*connection/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Stored connection works.');
    connectionFails = true;
    await user.click(screen.getByRole('button', { name: /test.*connection/i }));
    expect(await screen.findByRole('status')).toHaveTextContent('Stored connection failed.');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(patchBody).toBeDefined());
    expect((patchBody!.moonraker_config as Record<string, unknown>).api_key).toBeUndefined();
    expect((patchBody!.moonraker_config as Record<string, unknown>).authorization).toBeUndefined();
  });

  it('requires confirmed emergency stop, keeps cancel/Escape request-free, and surfaces server errors', async () => {
    const user = userEvent.setup();
    let requests = 0;
    let body: unknown;
    server.use(http.post('/api/v1/printers/41/emergency-stop', async ({ request }) => {
      requests += 1;
      body = await request.json();
      return HttpResponse.json({ detail: { message: 'Emergency stop unavailable.' } }, { status: 503 });
    }));
    setupPage();

    const emergencyStop = await screen.findByRole('button', { name: /^emergency stop$/i });
    expect(emergencyStop).toHaveClass('!min-h-11');
    await user.click(emergencyStop);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(requests).toBe(0);
    await user.click(screen.getByRole('button', { name: /^emergency stop$/i }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(requests).toBe(0);
    await user.click(screen.getByRole('button', { name: /^emergency stop$/i }));
    await user.click(screen.getAllByRole('button', { name: /^emergency stop$/i }).at(-1)!);
    await waitFor(() => expect(requests).toBe(1));
    expect(body).toEqual({ confirmed: true });
    expect(await screen.findByText(/Emergency stop unavailable/i)).toBeInTheDocument();
  });
});
