import type { PrinterCamera } from '../api/client';

export function isUsableMoonrakerCamera(camera: PrinterCamera): boolean {
  return camera.available && camera.enabled && (camera.supported_live || camera.snapshot_available);
}

export function resolveMoonrakerCameraId(
  cameras: PrinterCamera[],
  selectedCameraId: number | null,
): number | null {
  const selected = cameras.find((camera) => camera.id === selectedCameraId);
  if (selected && isUsableMoonrakerCamera(selected)) return selected.id;
  return (
    cameras.find((camera) => camera.is_primary && isUsableMoonrakerCamera(camera))
    ?? cameras.find(isUsableMoonrakerCamera)
    ?? cameras[0]
  )?.id ?? null;
}
