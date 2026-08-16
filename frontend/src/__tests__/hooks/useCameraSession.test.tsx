import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PrinterCamera } from '../../api/client';
import { buildCameraMediaPath, useCameraSession } from '../../hooks/useCameraSession';

vi.mock('../../hooks/useCameraStreamToken', () => ({
  useCameraStreamToken: () => ({
    waitingForToken: false,
    withToken: (url: string) => `${url}&token=scoped-token`,
  }),
}));

function camera(id: number, overrides: Partial<PrinterCamera> = {}): PrinterCamera {
  return {
    id,
    printer_id: 7,
    source: 'moonraker',
    source_uid: `camera-${id}`,
    name: `Camera ${id}`,
    location: null,
    service: null,
    camera_type: 'mjpeg',
    source_enabled: true,
    enabled: true,
    is_primary: false,
    rotation: 0,
    sort_order: id,
    available: true,
    supported_live: true,
    snapshot_available: true,
    history: false,
    first_seen_at: '',
    last_seen_at: '',
    missing_since: null,
    ...overrides,
  };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('buildCameraMediaPath', () => {
  it('builds selected-camera and legacy fallback paths', () => {
    expect(buildCameraMediaPath(7, 12, 'stream', 9, 42)).toBe(
      '/api/v1/printers/7/cameras/12/stream?fps=9&t=42',
    );
    expect(buildCameraMediaPath(7, null, 'snapshot', undefined, 42)).toBe(
      '/api/v1/printers/7/camera/snapshot?t=42',
    );
  });
});

describe('useCameraSession', () => {
  it('selects the usable primary camera and owns tokenized media URLs', () => {
    const cameras = [camera(1, { available: false }), camera(2, { is_primary: true })];
    const { result } = renderHook(
      () => useCameraSession({ printerId: 7, provider: 'moonraker', cameras }),
      { wrapper: wrapper() },
    );

    expect(result.current.selectedCameraId).toBe(2);
    expect(result.current.streamUrl(15, 99)).toBe(
      '/api/v1/printers/7/cameras/2/stream?fps=15&t=99&token=scoped-token',
    );

    act(() => result.current.setSelectedCameraId(1));
    expect(result.current.selectedCameraId).toBe(2);
  });
});
