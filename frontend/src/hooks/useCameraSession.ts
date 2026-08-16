import { useEffect, useState } from 'react';
import type { PrinterCamera } from '../api/client';
import { resolveMoonrakerCameraId } from '../utils/moonrakerCameras';
import { useCameraStreamToken } from './useCameraStreamToken';

type CameraMediaKind = 'stream' | 'snapshot';

interface UseCameraSessionOptions {
  printerId: number;
  provider?: 'bambu' | 'moonraker';
  cameras: PrinterCamera[];
}

export function buildCameraMediaPath(
  printerId: number,
  cameraId: number | null,
  kind: CameraMediaKind,
  fps: number | undefined,
  bust: number,
): string {
  const cameraPath = cameraId ? `cameras/${cameraId}` : 'camera';
  const fpsParam = kind === 'stream' && fps !== undefined ? `fps=${fps}&` : '';
  return `/api/v1/printers/${printerId}/${cameraPath}/${kind}?${fpsParam}t=${bust}`;
}

export function useCameraSession({ printerId, provider, cameras }: UseCameraSessionOptions) {
  const [selectedCameraId, setSelectedCameraId] = useState<number | null>(() =>
    provider === 'moonraker' ? resolveMoonrakerCameraId(cameras, null) : null,
  );
  const { waitingForToken, withToken } = useCameraStreamToken();

  useEffect(() => {
    if (provider !== 'moonraker') {
      if (selectedCameraId !== null) setSelectedCameraId(null);
      return;
    }
    const nextCameraId = resolveMoonrakerCameraId(cameras, selectedCameraId);
    if (nextCameraId !== selectedCameraId) setSelectedCameraId(nextCameraId);
  }, [cameras, provider, selectedCameraId]);

  const mediaUrl = (
    kind: CameraMediaKind,
    bust: number,
    fps?: number,
    cameraId: number | null = selectedCameraId,
  ) => waitingForToken ? '' : withToken(buildCameraMediaPath(printerId, cameraId, kind, fps, bust));

  return {
    selectedCameraId,
    setSelectedCameraId,
    selectedCamera: cameras.find((camera) => camera.id === selectedCameraId),
    waitingForToken,
    streamUrl: (fps: number, bust: number, cameraId?: number | null) =>
      mediaUrl('stream', bust, fps, cameraId),
    snapshotUrl: (bust: number, cameraId?: number | null) =>
      mediaUrl('snapshot', bust, undefined, cameraId),
  };
}
