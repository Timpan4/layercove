/** Regression tests for reactive camera-token refresh without global DOM mutation. */

import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, setAuthToken, setStreamToken } from '../../api/client';
import { CameraTile } from '../../components/CameraTile';
import { useStreamTokenSync } from '../../hooks/useCameraStreamToken';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authEnabled: true, user: { id: 1 }, loading: false }),
}));

function StreamTokenSync() {
  useStreamTokenSync();
  return null;
}

describe('useStreamTokenSync', () => {
  afterEach(() => {
    setAuthToken(null);
    setStreamToken(null);
    vi.restoreAllMocks();
  });

  it('does not rewrite unrelated media when a camera token arrives', async () => {
    vi.spyOn(api, 'getCameraStreamToken').mockResolvedValue({ token: 'camera-token' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StreamTokenSync),
        createElement('img', { alt: 'archive', src: '/api/v1/archives/5/thumbnail' }),
      ),
    );

    await waitFor(() => expect(api.getCameraStreamToken).toHaveBeenCalled());
    expect((screen.getByAltText('archive') as HTMLImageElement).src).not.toContain('token=');
  });

  it('keeps failed media mounted while replacing a stale stream token', async () => {
    let resolveFreshToken!: (value: { token: string }) => void;
    const freshToken = new Promise<{ token: string }>((resolve) => {
      resolveFreshToken = resolve;
    });
    vi.spyOn(api, 'getCameraStreamToken')
      .mockResolvedValueOnce({ token: 'stale-token' })
      .mockReturnValueOnce(freshToken);
    setAuthToken('auth-token');

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StreamTokenSync),
        createElement(CameraTile, {
          printerId: 42,
          printerName: 'Stale token camera',
          mode: 'live',
          snapshotIntervalMs: 5000,
          connected: true,
        }),
      ),
    );

    const image = screen.getByAltText('Stale token camera') as HTMLImageElement;
    await waitFor(() => expect(image.src).toContain('token=stale-token'));

    fireEvent.error(image);

    expect(screen.getByAltText('Stale token camera')).toBe(image);
    await waitFor(() => expect(api.getCameraStreamToken).toHaveBeenCalledTimes(2));

    await act(async () => resolveFreshToken({ token: 'fresh-token' }));
    await waitFor(() => expect(image.src).toContain('token=fresh-token'));
    expect(screen.getByAltText('Stale token camera')).toBe(image);

    fireEvent.error(image);
    expect(screen.queryByAltText('Stale token camera')).toBeNull();
  });
});
