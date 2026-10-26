/**
 * Copy regressions in the printer detail view ("Open controls"), rendered by PrinterCard.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { server } from '../mocks/server';

const mockPrinter = {
  id: 1,
  name: 'Bench P1S',
  ip_address: '192.168.1.120',
  serial_number: '00W00A000000001',
  access_code: '12345678',
  model: 'P1S',
  enabled: true,
  is_active: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'hardened_steel',
  location: null,
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockPrinterStatus = {
  connected: true,
  state: 'IDLE',
  awaiting_plate_clear: false,
  progress: 0,
  layer_num: 0,
  total_layers: 0,
  temperatures: { nozzle: 25, bed: 25, chamber: 25 },
  remaining_time: 0,
  filename: null,
  wifi_signal: -50,
  vt_tray: [],
  hms_errors: [],
  nozzles: [{ nozzle_diameter: 0.4, nozzle_type: 'hardened_steel' }],
};

const mockMaintenanceOverview = [
  {
    printer_id: 1,
    printer_name: 'Bench P1S',
    due_count: 0,
    warning_count: 0,
    total_print_hours: 629.4,
  },
];

const openPrinterControls = async (printerName: string) => {
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: `Inspect ${printerName}` }));
  await user.click(await screen.findByRole('button', { name: 'Open controls' }));
  await screen.findByRole('button', { name: 'Back' });
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.removeItem('printerCardSize');

  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
    http.get('/api/v1/printers/:id/status', () => HttpResponse.json(mockPrinterStatus)),
    http.get('/api/v1/maintenance/overview', () => HttpResponse.json(mockMaintenanceOverview)),
    http.get('/api/v1/settings/', () => HttpResponse.json({
      auto_archive: true,
      save_thumbnails: true,
      capture_finish_photo: true,
      default_filament_cost: 25.0,
      currency: 'USD',
      ams_humidity_good: 40,
      ams_humidity_fair: 60,
      ams_temp_good: 30,
      ams_temp_fair: 35,
      require_plate_clear: true,
    })),
    http.get('/api/v1/settings/ui-preferences', () => HttpResponse.json({
      ams_humidity_good: 40,
      ams_humidity_fair: 60,
      ams_temp_good: 30,
      ams_temp_fair: 35,
      require_plate_clear: true,
    })),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.get('/api/v1/network-sites', () => HttpResponse.json([])),
  );
});

describe('Printer detail copy', () => {
  it('names the overflow menu "More actions" instead of the "+N more" count string', async () => {
    render(<PrintersPage />);
    await openPrinterControls('Bench P1S');

    expect(await screen.findByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });

  it('separates the model, nozzle diameter, and print hours in the header', async () => {
    render(<PrintersPage />);
    await openPrinterControls('Bench P1S');

    await waitFor(() => {
      expect(
        screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === 'P1S · 0.4 mm · 629 h'),
      ).toBeInTheDocument();
    });
  });

  it('labels the HMS and maintenance chips with the subsystem when they report OK', async () => {
    render(<PrintersPage />);
    await openPrinterControls('Bench P1S');

    const hmsChip = await screen.findByRole('button', { name: 'HMS: OK' });
    expect(hmsChip).toHaveAttribute('title', 'HMS: OK');

    const maintenanceChip = await screen.findByRole('button', { name: 'All maintenance up to date - Click to view' });
    expect(maintenanceChip).toHaveAttribute('title', 'All maintenance up to date - Click to view');
  });

  it('names the HMS chip by its error count instead of a bare number', async () => {
    server.use(
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json({
        ...mockPrinterStatus,
        hms_errors: [{ code: '0x0300', attr: 0, module: 3, severity: 2, actions: ['CHECK_FILAMENT'] }],
      })),
    );
    render(<PrintersPage />);
    await openPrinterControls('Bench P1S');

    const hmsChip = await screen.findByRole('button', { name: 'View 1 HMS error(s)' });
    expect(hmsChip).toHaveTextContent('1');
  });
});
