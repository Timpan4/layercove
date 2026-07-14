/**
 * Tests for the Edit-Printer setup-time pre-flight.
 *
 * Editing a printer runs the same connection diagnostic on save as the
 * Add-Printer dialog, and warns (rather than blocks) when a check fails.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const mockPrinter = {
  id: 1,
  name: 'X1 Carbon',
  ip_address: '192.168.1.100',
  serial_number: '00M09A350100001',
  access_code: '12345678',
  model: 'X1C',
  enabled: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'hardened_steel',
  location: null,
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const mockStatus = {
  connected: true,
  state: 'IDLE',
  progress: 0,
  layer_num: 0,
  total_layers: 0,
  temperatures: { nozzle: 25, bed: 25, chamber: 25 },
  remaining_time: 0,
  filename: null,
  wifi_signal: -50,
  vt_tray: [],
};

async function openEditModal() {
  render(<PrintersPage />);
  await waitFor(() => expect(screen.getByText('X1 Carbon')).toBeInTheDocument());

  // Open the per-printer actions menu (kebab button), then click Edit.
  const menuBtn = [...document.querySelectorAll('button')].find((b) =>
    b.querySelector('.lucide-ellipsis-vertical'),
  )!;
  await userEvent.click(menuBtn);
  await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
  await screen.findByText('Edit Printer');
}

describe('EditPrinterModal pre-flight', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json(mockStatus)),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/network-sites', () => HttpResponse.json([])),
    );
  });

  it('warns instead of saving when a connection check fails', async () => {
    server.use(
      http.post('/api/v1/printers/diagnostic', () =>
        HttpResponse.json({
          printer_id: null,
          ip_address: '192.168.1.100',
          overall: 'problems',
          checks: [{ id: 'developer_mode', status: 'fail', params: {} }],
        }),
      ),
    );

    await openEditModal();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/Some connection checks failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save anyway/i })).toBeInTheDocument();
  });

  it('saves directly when all connection checks pass', async () => {
    let updated = false;
    server.use(
      http.post('/api/v1/printers/diagnostic', () =>
        HttpResponse.json({
          printer_id: null,
          ip_address: '192.168.1.100',
          overall: 'ok',
          checks: [{ id: 'developer_mode', status: 'pass', params: {} }],
        }),
      ),
      http.patch('/api/v1/printers/:id', async () => {
        updated = true;
        return HttpResponse.json({ ...mockPrinter, name: 'X1 Carbon' });
      }),
    );

    await openEditModal();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updated).toBe(true));
    expect(screen.queryByText(/Some connection checks failed/i)).not.toBeInTheDocument();
  });

  it('reassigns a printer to a named site', async () => {
    let diagnosticTarget = '';
    let updateBody: Record<string, unknown> = {};
    server.use(
      http.get('/api/v1/network-sites', () =>
        HttpResponse.json([
          {
            id: 2,
            name: 'Dogge Home',
            site_number: 2,
            ipv4_cidr: '192.168.50.0/24',
            four_via_six_cidr: 'fd7a:115c:a1e0:b1a:0:2:c0a8:3200/120',
            printer_count: 0,
          },
        ]),
      ),
      http.post('/api/v1/printers/diagnostic', async ({ request }) => {
        diagnosticTarget = ((await request.json()) as { ip_address: string }).ip_address;
        return HttpResponse.json({ overall: 'ok', checks: [] });
      }),
      http.patch('/api/v1/printers/:id', async ({ request }) => {
        updateBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...mockPrinter, ...updateBody });
      }),
    );

    await openEditModal();
    await userEvent.selectOptions(screen.getByLabelText('Connection'), '2');
    await userEvent.type(screen.getByLabelText('Printer LAN IPv4 address'), '192.168.50.22');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateBody.network_site_id).toBe(2));
    expect(updateBody.network_site_lan_ip).toBe('192.168.50.22');
    expect(diagnosticTarget).toBe('192-168-50-22-via-2');
  });

  it('does not detach an existing site when the site query fails', async () => {
    let updated = false;
    server.use(
      http.get('/api/v1/printers/', () =>
        HttpResponse.json([
          {
            ...mockPrinter,
            network_site_id: 1,
            network_site_lan_ip: '192.168.1.87',
            network_site: { id: 1, name: 'Timpa Home', site_number: 1 },
          },
        ]),
      ),
      http.get('/api/v1/network-sites', () => HttpResponse.json({ detail: 'failed' }, { status: 500 })),
      http.patch('/api/v1/printers/:id', () => {
        updated = true;
        return HttpResponse.json(mockPrinter);
      }),
    );

    await openEditModal();
    const save = screen.getByRole('button', { name: /save changes/i });
    await waitFor(() => expect(save).toBeDisabled());
    await userEvent.click(save);

    expect(updated).toBe(false);
  });
});
