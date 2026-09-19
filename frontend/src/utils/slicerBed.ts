/** Physical coordinates from the exact selected machine revision, never its label. */
export interface SlicerBed {
  x: number;
  y: number;
  z: number;
  origin: [number, number];
}

export function slicerBedFromProfile(profile: Record<string, unknown> | undefined): SlicerBed | null {
  if (!profile) return null;
  const area = profile.printable_area ?? profile.bed_shape;
  const rawHeight = profile.printable_height ?? profile.max_print_height;
  const height = Number(Array.isArray(rawHeight) ? rawHeight[0] : rawHeight);
  if (!Array.isArray(area) || area.length < 3 || area.length > 512 || !Number.isFinite(height) || height <= 0 || height > 20000) return null;
  const points = area.map((point) => {
    if (typeof point !== 'string') return null;
    const match = point.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))x([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/i);
    return match ? [Number(match[1]), Number(match[2])] : null;
  });
  if (points.some((point) => !point || point.some((v) => !Number.isFinite(v) || Math.abs(v) > 20000))) return null;
  const xs = points.map((point) => point![0]);
  const ys = points.map((point) => point![1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const x = Math.max(...xs) - minX, y = Math.max(...ys) - minY;
  if (x <= 0 || y <= 0 || x > 20000 || y > 20000) return null;
  return { x, y, z: height, origin: [minX, minY] };
}
