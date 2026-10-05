/**
 * ETA sort must re-order when a printer status changes while the search and
 * filters stay at their defaults (filteredPrinters keeps its identity then).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const makePrinter = (id: number, name: string) => ({
  id,
  name,
  ip_address: `192.168.1.${100 + id}`,
  serial_number: `00M09A35010000${id}`,
  access_code: '12345678',
  model: 'X1C',
  enabled: true,
  nozzle_diameter: 0.4,
  nozzle_type: 'hardened_steel',
  location: 'Workshop',
  auto_archive: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
});

const status = (printing: boolean) => ({
  connected: true,
  state: printing ? 'RUNNING' : 'IDLE',
  progress: printing ? 42 : 0,
  layer_num: 0,
  total_layers: 0,
  temperatures: { nozzle: 25, bed: 25, chamber: 25 },
  remaining_time: printing ? 600 : 0,
  filename: printing ? 'test_print.3mf' : null,
  wifi_signal: -50,
  vt_tray: [],
  speed_level: 2,
});

const names = () =>
  screen
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent)
    .filter((n) => n === 'Alpha' || n === 'Bravo');

describe('PrintersPage - ETA sort reacts to status updates', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockImplementation((key) =>
      key === 'printerSortBy' ? 'eta' : null,
    );
  });

  it('moves a printer that starts printing ahead of idle ones', async () => {
    let alphaPrinting = false;
    server.use(
      http.get('/api/v1/printers/', () =>
        HttpResponse.json([makePrinter(1, 'Alpha'), makePrinter(2, 'Bravo')]),
      ),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/printers/:id/status', ({ params }) =>
        HttpResponse.json(status(params.id === '1' ? alphaPrinting : !alphaPrinting)),
      ),
    );

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <PrintersPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(names()).toEqual(['Bravo', 'Alpha']));

    // Simulates the WebSocket status push: Bravo goes idle, Alpha starts printing.
    alphaPrinting = true;
    await act(async () => {
      client.setQueryData(['printerStatus', 1], status(true));
      client.setQueryData(['printerStatus', 2], status(false));
    });

    await waitFor(() => expect(names()).toEqual(['Alpha', 'Bravo']));
  });
});
