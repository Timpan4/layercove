/**
 * Unit tests for rewriteMediaSrcWithToken — the DOM walker that retrofits a
 * camera stream token onto <img>/<video> src URLs that rendered before the
 * token arrived (regression guard for the post-login blank-thumbnails bug).
 */

import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setAuthToken, setStreamToken } from '../../api/client';
import { CameraTile } from '../../components/CameraTile';
import {
  rewriteMediaSrcWithToken,
  useStreamTokenSync,
} from '../../hooks/useCameraStreamToken';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authEnabled: true, user: { id: 1 }, loading: false }),
}));

function StreamTokenSync() {
  useStreamTokenSync();
  return null;
}

describe('rewriteMediaSrcWithToken', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    root.remove();
  });

  const addImg = (src: string) => {
    const img = document.createElement('img');
    img.setAttribute('src', src);
    root.appendChild(img);
    return img;
  };

  const addVideo = (src: string) => {
    const v = document.createElement('video');
    v.setAttribute('src', src);
    root.appendChild(v);
    return v;
  };

  it('appends token to /api/v1/ images that have no query string', () => {
    const img = addImg('/api/v1/library/files/42/thumbnail');
    const count = rewriteMediaSrcWithToken(root, 'abc123');
    expect(count).toBe(1);
    expect(img.getAttribute('src')).toBe('/api/v1/library/files/42/thumbnail?token=abc123');
  });

  it('appends token to URLs that already have a query string using & separator', () => {
    const img = addImg('/api/v1/archives/5/thumbnail?v=1700000000000');
    rewriteMediaSrcWithToken(root, 'abc123');
    expect(img.getAttribute('src')).toBe('/api/v1/archives/5/thumbnail?v=1700000000000&token=abc123');
  });

  it('leaves images alone that already carry the current token', () => {
    const img = addImg('/api/v1/library/files/42/thumbnail?token=abc123');
    const count = rewriteMediaSrcWithToken(root, 'abc123');
    expect(count).toBe(0);
    expect(img.getAttribute('src')).toBe('/api/v1/library/files/42/thumbnail?token=abc123');
  });

  it('replaces a stale token with the current one', () => {
    const img = addImg('/api/v1/library/files/42/thumbnail?token=OLD');
    rewriteMediaSrcWithToken(root, 'NEW');
    expect(img.getAttribute('src')).toBe('/api/v1/library/files/42/thumbnail?token=NEW');
  });

  it('replaces a stale token that sits in the middle of the query string', () => {
    const img = addImg('/api/v1/archives/5/thumbnail?token=OLD&v=1700000000000');
    rewriteMediaSrcWithToken(root, 'NEW');
    // Old token stripped, v preserved, new token appended.
    expect(img.getAttribute('src')).toBe('/api/v1/archives/5/thumbnail?v=1700000000000&token=NEW');
  });

  it('ignores images that do not point at /api/v1/', () => {
    const img = addImg('https://cdn.example.com/static/logo.png');
    rewriteMediaSrcWithToken(root, 'abc123');
    expect(img.getAttribute('src')).toBe('https://cdn.example.com/static/logo.png');
  });

  it('updates <video> elements as well', () => {
    const v = addVideo('/api/v1/printers/7/camera/stream?fps=10');
    rewriteMediaSrcWithToken(root, 'abc123');
    expect(v.getAttribute('src')).toBe('/api/v1/printers/7/camera/stream?fps=10&token=abc123');
  });

  it('url-encodes tokens containing special characters', () => {
    const img = addImg('/api/v1/library/files/42/thumbnail');
    rewriteMediaSrcWithToken(root, 'a b/c=d');
    expect(img.getAttribute('src')).toBe('/api/v1/library/files/42/thumbnail?token=a%20b%2Fc%3Dd');
  });
});

describe('useStreamTokenSync', () => {
  afterEach(() => {
    setAuthToken(null);
    setStreamToken(null);
    vi.restoreAllMocks();
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
