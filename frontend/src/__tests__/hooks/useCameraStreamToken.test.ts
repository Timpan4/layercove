/** Regression tests for camera and thumbnail token refresh. */

import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, ApiError, getStreamToken, setAuthToken, setStreamToken } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { CameraTile } from '../../components/CameraTile';
import { StreamOverlayPage } from '../../pages/StreamOverlayPage';
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

  it('updates the stream overlay when a stale token is replaced', async () => {
    let resolveFreshToken!: (value: { token: string }) => void;
    const freshToken = new Promise<{ token: string }>((resolve) => {
      resolveFreshToken = resolve;
    });
    vi.spyOn(api, 'getCameraStreamToken')
      .mockResolvedValueOnce({ token: 'stale-token' })
      .mockReturnValueOnce(freshToken);
    vi.spyOn(api, 'getWebSocketToken').mockRejectedValue(new ApiError('Unauthorized', 401));
    setAuthToken('auth-token');
    setStreamToken('stale-token');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(['printer', 42], { name: 'Overlay camera' });
    queryClient.setQueryData(queryKeys.printerStatus(42), { state: 'IDLE', connected: true });
    queryClient.setQueryData(['settings'], {});
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StreamTokenSync),
        createElement(
          MemoryRouter,
          { initialEntries: ['/overlay/42'] },
          createElement(Routes, null,
            createElement(Route, { path: '/overlay/:printerId', element: createElement(StreamOverlayPage) }),
          ),
        ),
      ),
    );
    const image = screen.getByAltText('Camera stream') as HTMLImageElement;
    await waitFor(() => expect(api.getCameraStreamToken).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getStreamToken()).toBe('stale-token'));
    expect(image.src).toContain('token=stale-token');
    fireEvent.error(image);
    await waitFor(() => expect(api.getCameraStreamToken).toHaveBeenCalledTimes(2));
    await act(async () => resolveFreshToken({ token: 'fresh-token' }));
    await waitFor(() => expect(image.src).toContain('token=fresh-token'));
  });

  it.each([
    '/api/v1/archives/5/thumbnail',
    '/api/v1/printers/42/camera/plate-detection/references/1/thumbnail',
  ])('recovers a delayed token for thumbnail %s', async (src) => {
    vi.spyOn(api, 'getCameraStreamToken').mockResolvedValue({ token: 'camera-token' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StreamTokenSync),
        createElement('img', { alt: 'archive', src }),
      ),
    );

    await waitFor(() => expect(api.getCameraStreamToken).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByAltText('archive') as HTMLImageElement).src).toContain('token=camera-token'));
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
