/** Physical coordinates from the exact selected machine revision, never its label. */
export interface SlicerBed {
  x: number;
  y: number;
  z: number;
  origin: [number, number];
  outline?: Array<[number, number]>;
}

export type SlicerBedIssue = 'missingArea' | 'invalidArea' | 'missingHeight' | 'invalidHeight';
export type SlicerBedResult = { bed: SlicerBed; issue: null } | { bed: null; issue: SlicerBedIssue };

const MAX_COORDINATE = 20000;
const MAX_POINTS = 512;
const MAX_AREA_LENGTH = 32768;
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const POINT = new RegExp(`^(${NUMBER})\\s*x\\s*(${NUMBER})$`, 'i');
const SCALAR = new RegExp(`^${NUMBER}$`);

function areaPoints(value: unknown): Array<[number, number]> | null {
  // Cloud's values_map is string-valued. Files may instead carry native JSON
  // arrays. Decode those representations without modifying the saved revision.
  if (typeof value === 'string') {
    if (value.length > MAX_AREA_LENGTH) return null;
    const text = value.trim();
    if (text.startsWith('[')) {
      try { value = JSON.parse(text); } catch { return null; }
    } else {
      value = text.split(',');
    }
  }
  if (!Array.isArray(value) || value.length > MAX_POINTS) return null;
  if (value.length === 1 && typeof value[0] === 'string' && value[0].includes(',')) {
    if (value[0].length > MAX_AREA_LENGTH) return null;
    value = value[0].split(',');
  }
  if (!Array.isArray(value) || value.length < 3 || value.length > MAX_POINTS) return null;
  const points: Array<[number, number]> = [];
  for (const point of value) {
    if (typeof point !== 'string' || point.length > 128) return null;
    const match = point.trim().match(POINT);
    if (!match) return null;
    const x = Number(match[1]), y = Number(match[2]);
    if (![x, y].every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_COORDINATE)) return null;
    points.push([x, y]);
  }
  return points;
}

function heightValue(value: unknown): number | null {
  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    value = value[0];
  }
  if (typeof value === 'string') {
    if (value.length > 64 || !SCALAR.test(value.trim())) return null;
    value = Number(value);
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_COORDINATE
    ? value : null;
}

export function parseSlicerBed(profile: Record<string, unknown> | undefined): SlicerBedResult {
  const area = profile?.printable_area ?? profile?.bed_shape;
  if (area == null) return { bed: null, issue: 'missingArea' };
  const points = areaPoints(area);
  if (!points) return { bed: null, issue: 'invalidArea' };
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const x = Math.max(...xs) - minX, y = Math.max(...ys) - minY;
  // A line or collapsed polygon is not a printable bed, even if its bounds
  // span both axes. Irregular beds are still displayed by their bounding box.
  const twiceArea = points.reduce((sum, [px, py], i) => {
    const [nx, ny] = points[(i + 1) % points.length];
    return sum + px * ny - nx * py;
  }, 0);
  if (x <= 0 || y <= 0 || x > MAX_COORDINATE || y > MAX_COORDINATE || twiceArea === 0) {
    return { bed: null, issue: 'invalidArea' };
  }
  const rawHeight = profile?.printable_height ?? profile?.max_print_height;
  if (rawHeight == null) return { bed: null, issue: 'missingHeight' };
  const height = heightValue(rawHeight);
  if (height === null) return { bed: null, issue: 'invalidHeight' };
  const outline = Math.abs(Math.abs(twiceArea) - 2 * x * y) > 0.001 ? points : undefined;
  return { bed: { x, y, z: height, origin: [minX, minY], ...(outline ? { outline } : {}) }, issue: null };
}

export function slicerBedFromProfile(profile: Record<string, unknown> | undefined): SlicerBed | null {
  return parseSlicerBed(profile).bed;
}
