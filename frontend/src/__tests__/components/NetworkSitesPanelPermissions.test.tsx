import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkSitesPanel } from '../../components/NetworkSitesPanel';
import { ToastProvider } from '../../contexts/ToastContext';
import { server } from '../mocks/server';

const auth = vi.hoisted(() => ({ permissions: new Set<string>() }));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    authEnabled: true,
    hasPermission: (permission: string) => auth.permissions.has(permission),
  }),
}));

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <NetworkSitesPanel />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('NetworkSitesPanel permissions', () => {
  beforeEach(() => auth.permissions.clear());

  it('does not expose site management to a viewer', () => {
    auth.permissions.add('printers:read');

    renderPanel();

    expect(screen.queryByRole('heading', { name: 'Network Sites' })).not.toBeInTheDocument();
  });

  it('shows site management to an operator', async () => {
    auth.permissions.add('printers:create');
    auth.permissions.add('printers:update');
    auth.permissions.add('printers:delete');
    server.use(http.get('/api/v1/network-sites', () => HttpResponse.json([])));

    renderPanel();

    expect(await screen.findByRole('heading', { name: 'Network Sites' })).toBeInTheDocument();
  });
});
