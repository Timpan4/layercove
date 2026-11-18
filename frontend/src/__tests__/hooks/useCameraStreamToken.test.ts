/** Regression tests for camera and thumbnail token refresh. */

import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, ApiError, getStreamToken, setAuthToken, setMediaToken, setStreamToken, withMediaToken } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { CameraTile } from '../../components/CameraTile';
import { StreamOverlayPage } from '../../pages/StreamOverlayPage';
import { useStreamTokenSync } from '../../hooks/useCameraStreamToken';

const auth = vi.hoisted(() => ({ canViewCamera: true }));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authEnabled: true, user: { id: 1 }, loading: false, hasPermission: () => auth.canViewCamera }),
}));

function StreamTokenSync() {
  useStreamTokenSync();
  return null;
}

describe('useStreamTokenSync', () => {
  beforeEach(() => setAuthToken('fixture-auth-session'));

  afterEach(() => {
    auth.canViewCamera = true;
    setAuthToken(null);
    setMediaToken(null);
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

  it('recovers a delayed token for camera calibration references', async () => {
    vi.spyOn(api, 'getCameraStreamToken').mockResolvedValue({ token: 'camera-token' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StreamTokenSync),
        createElement('img', { alt: 'camera reference', src: '/api/v1/printers/42/camera/plate-detection/references/1/thumbnail' }),
      ),
    );

    await waitFor(() => expect(api.getCameraStreamToken).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByAltText('camera reference')).toHaveAttribute(
      'src', '/api/v1/printers/42/camera/plate-detection/references/1/thumbnail?token=camera-token',
    ));
  });

  it('loads archive images and video for a reader without camera access', async () => {
    auth.canViewCamera = false;
    vi.spyOn(api, 'getMediaToken').mockResolvedValue({ token: 'media-token' });
    const camera = vi.spyOn(api, 'getCameraStreamToken');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client: queryClient },
      createElement(StreamTokenSync),
      createElement('img', { alt: 'archive thumbnail', src: '/api/v1/archives/5/thumbnail' }),
      createElement('video', { 'data-testid': 'timelapse', src: '/api/v1/archives/5/timelapse' }),
    ));
    await waitFor(() => expect(screen.getByAltText('archive thumbnail')).toHaveAttribute(
      'src', '/api/v1/archives/5/thumbnail?token=media-token',
    ));
    expect(screen.getByTestId('timelapse')).toHaveAttribute('src', '/api/v1/archives/5/timelapse?token=media-token');
    expect(camera).not.toHaveBeenCalled();
  });

  it('mints new media credentials after the same user signs in again', async () => {
    auth.canViewCamera = false;
    const getToken = vi.spyOn(api, 'getMediaToken')
      .mockResolvedValueOnce({ token: 'old-media-token' })
      .mockResolvedValueOnce({ token: 'new-media-token' });
    setAuthToken('old-session');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const thumbnail = '/api/v1/archives/5/thumbnail';
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(StreamTokenSync)));
    await waitFor(() => expect(withMediaToken(thumbnail)).toBe(`${thumbnail}?token=old-media-token`));

    await act(async () => { setAuthToken('new-session'); });

    await waitFor(() => expect(withMediaToken(thumbnail)).toBe(`${thumbnail}?token=new-media-token`));
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('keeps signing media and lets a missing image fail without refreshing credentials', async () => {
    auth.canViewCamera = false;
    const getToken = vi.spyOn(api, 'getMediaToken').mockResolvedValue({ token: 'media-token' });
    const showFallback = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client: queryClient },
      createElement(StreamTokenSync),
      createElement('img', { alt: 'missing cover', src: '/api/v1/printers/5/cover', onError: showFallback }),
    ));
    const cover = screen.getByAltText('missing cover');
    await waitFor(() => expect(cover).toHaveAttribute('src', '/api/v1/printers/5/cover?token=media-token'));

    await act(async () => { fireEvent.error(cover); });
    expect(showFallback).toHaveBeenCalledOnce();
    expect(getToken).toHaveBeenCalledTimes(1);
    const thumbnail = '/api/v1/archives/5/thumbnail';
    expect(withMediaToken(thumbnail)).toBe(`${thumbnail}?token=media-token`);
  });

  it('keeps a loaded timelapse on its current source when the credential rotates', async () => {
    auth.canViewCamera = false;
    vi.spyOn(api, 'getMediaToken')
      .mockResolvedValueOnce({ token: 'first-media-token' })
      .mockResolvedValueOnce({ token: 'next-media-token' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client: queryClient },
      createElement(StreamTokenSync),
      createElement('video', { 'data-testid': 'timelapse', src: '/api/v1/archives/5/timelapse' }),
    ));
    const video = screen.getByTestId('timelapse');
    await waitFor(() => expect(video).toHaveAttribute('src', '/api/v1/archives/5/timelapse?token=first-media-token'));
    Object.defineProperty(video, 'readyState', { value: HTMLMediaElement.HAVE_METADATA });

    await act(async () => queryClient.invalidateQueries({ queryKey: ['media-token'] }));
    const image = '/api/v1/archives/5/thumbnail';
    await waitFor(() => expect(withMediaToken(image)).toBe(`${image}?token=next-media-token`));
    expect(video).toHaveAttribute('src', '/api/v1/archives/5/timelapse?token=first-media-token');
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
