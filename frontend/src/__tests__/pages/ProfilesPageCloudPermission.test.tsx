import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { setAuthToken } from '../../api/client';
import { ProfilesPage } from '../../pages/ProfilesPage';
import { server } from '../mocks/server';
import { render } from '../utils';

const authStatusHandler = http.get('*/api/v1/auth/status', () =>
  HttpResponse.json({ auth_enabled: true, requires_setup: false }),
);

function userHandler(isAdmin: boolean, permissions: string[]) {
  return http.get('*/api/v1/auth/me', () =>
    HttpResponse.json({
      id: 2,
      username: isAdmin ? 'admin' : 'operator',
      role: isAdmin ? 'admin' : 'operator',
      is_active: true,
      is_admin: isAdmin,
      groups: [],
      permissions,
      created_at: '2024-01-01T00:00:00Z',
    }),
  );
}

describe('ProfilesPage Bambu Cloud permission gate', () => {
  beforeEach(() => {
    setAuthToken('test-token');
  });

  afterEach(() => {
    setAuthToken(null);
  });

  it('does not request or offer Bambu Cloud without cloud:auth', async () => {
    let cloudStatusRequests = 0;
    server.use(
      authStatusHandler,
      userHandler(false, ['printers:read']),
      http.get('*/api/v1/cloud/status', () => {
        cloudStatusRequests += 1;
        return HttpResponse.json({ is_authenticated: false });
      }),
    );

    render(<ProfilesPage />);

    expect(await screen.findByText('You do not have permission to access this page.')).toBeInTheDocument();
    expect(screen.queryByText('Connect to Bambu Cloud')).not.toBeInTheDocument();
    expect(cloudStatusRequests).toBe(0);
  });

  it('loads Bambu Cloud controls for an administrator', async () => {
    let cloudStatusRequests = 0;
    server.use(
      authStatusHandler,
      userHandler(true, []),
      http.get('*/api/v1/cloud/status', () => {
        cloudStatusRequests += 1;
        return HttpResponse.json({ is_authenticated: false });
      }),
    );

    render(<ProfilesPage />);

    expect(await screen.findByText('Connect to Bambu Cloud')).toBeInTheDocument();
    await waitFor(() => expect(cloudStatusRequests).toBe(1));
  });
});
