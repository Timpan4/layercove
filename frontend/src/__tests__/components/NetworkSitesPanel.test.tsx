import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { NetworkSitesPanel } from '../../components/NetworkSitesPanel';
import { server } from '../mocks/server';
import { render } from '../utils';

const site = {
  id: 1,
  name: 'Timpa Home',
  site_number: 1,
  ipv4_cidr: '192.168.1.0/24',
  four_via_six_cidr: 'fd7a:115c:a1e0:b1a:0:1:c0a8:100/120',
  printer_count: 1,
};

describe('NetworkSitesPanel', () => {
  it('shows the named route, Pi guide, and generated MagicDNS target', async () => {
    const user = userEvent.setup();
    server.use(
      http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
      http.get('/api/v1/network-sites', () => HttpResponse.json([site])),
    );

    render(<NetworkSitesPanel />);

    expect(await screen.findByText('Timpa Home')).toBeInTheDocument();
    expect(screen.getByText(site.four_via_six_cidr)).toBeInTheDocument();
    await user.click(screen.getByText('Raspberry Pi Tailscale setup'));
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThan(0);

    await user.type(screen.getByLabelText('Printer LAN IPv4 address'), '192.168.1.87');
    expect(await screen.findByText('192-168-1-87-via-1')).toBeInTheDocument();
  });

  it('edits the route fields only for an unused site', async () => {
    const user = userEvent.setup();
    let updateBody: Record<string, unknown> = {};
    const prompts = ['Dogge Home', '2', '192.168.50.0/24'];
    vi.spyOn(window, 'prompt').mockImplementation(() => prompts.shift() ?? null);
    server.use(
      http.get('/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: false, requires_setup: false })),
      http.get('/api/v1/network-sites', () => HttpResponse.json([{ ...site, printer_count: 0 }])),
      http.patch('/api/v1/network-sites/:id', async ({ request }) => {
        updateBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...site, ...updateBody, printer_count: 0 });
      }),
    );

    render(<NetworkSitesPanel />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    await waitFor(() => expect(updateBody).toEqual({
      name: 'Dogge Home',
      site_number: 2,
      ipv4_cidr: '192.168.50.0/24',
    }));
  });
});
