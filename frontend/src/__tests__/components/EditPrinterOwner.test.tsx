/**
 * Tests for choosing a printer's owner in the Edit-Printer dialog.
 *
 * Prints started outside LayerCove are credited to the owner, and the owner
 * gains edit rights over them, so only callers who can edit every archive
 * see the field.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { PrintersPage } from '../../pages/PrintersPage';
import { server } from '../mocks/server';
import { setAuthToken } from '../../api/client';

const mockPrinter = {
  id: 1,
  name: 'Doggeday P1S',
  ip_address: '192.168.1.100',
  serial_number: '01P00A000000001',
  access_code: '12345678',
  model: 'P1S',
  location: null,
  auto_archive: true,
  is_active: true,
  owner_id: null,
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

const PRINTER_PERMISSIONS = ['printers:read', 'printers:update', 'printers:control'];

function signInWith(permissions: string[]) {
  setAuthToken('test-token', 'session');
  server.use(
    http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
    http.get('*/api/v1/auth/me', () =>
      HttpResponse.json({ id: 1, username: 'timpan', is_admin: false, permissions }),
    ),
  );
}

async function openEditModal() {
  render(<PrintersPage />);
  await userEvent.click(await screen.findByRole('button', { name: /^open controls$/i }));
  const menuBtn = [...document.querySelectorAll('button')].find((b) =>
    b.querySelector('.lucide-ellipsis-vertical'),
  )!;
  await userEvent.click(menuBtn);
  await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
  await screen.findByText('Edit Printer');
}

describe('EditPrinterModal owner', () => {
  let updateBody: Record<string, unknown> | null;

  beforeEach(() => {
    updateBody = null;
    server.use(
      http.get('/api/v1/printers/', () => HttpResponse.json([mockPrinter])),
      http.get('/api/v1/printers/:id/status', () => HttpResponse.json(mockStatus)),
      http.get('/api/v1/queue/', () => HttpResponse.json([])),
      http.get('/api/v1/network-sites', () => HttpResponse.json([])),
      http.get('/api/v1/users/', () =>
        HttpResponse.json([
          { id: 1, username: 'timpan', is_active: true },
          { id: 7, username: 'doggeday', is_active: true },
          { id: 9, username: 'former', is_active: false },
        ]),
      ),
      http.post('/api/v1/printers/diagnostic', () => HttpResponse.json({ overall: 'ok', checks: [] })),
      http.patch('/api/v1/printers/:id', async ({ request }) => {
        updateBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...mockPrinter, ...updateBody });
      }),
    );
  });

  afterEach(() => {
    setAuthToken(null);
  });

  it('sets an owner and credits the printer\'s past ownerless prints to them', async () => {
    signInWith([...PRINTER_PERMISSIONS, 'archives:update_all', 'users:read']);
    await openEditModal();

    const owner = await screen.findByLabelText('Owner');
    await waitFor(() => expect(screen.getByRole('option', { name: 'doggeday' })).toBeInTheDocument());
    expect(screen.queryByRole('option', { name: 'former' })).not.toBeInTheDocument();
    await userEvent.selectOptions(owner, '7');
    await userEvent.click(screen.getByLabelText(/past prints that have no user/i));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateBody).not.toBeNull());
    expect(updateBody).toMatchObject({ owner_id: 7, assign_unowned_prints: true });
  });

  it('hides the owner from users who cannot edit every archive', async () => {
    signInWith([...PRINTER_PERMISSIONS, 'users:read']);
    await openEditModal();

    expect(screen.queryByLabelText('Owner')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateBody).not.toBeNull());
    expect(updateBody).not.toHaveProperty('owner_id');
  });
});
