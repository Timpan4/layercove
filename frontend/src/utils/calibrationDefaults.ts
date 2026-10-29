import type { CalibrationStep } from '../api/client';

type TestValues = { lowest: string; highest: string; increment: string; baseline: string };

// Orca's calibration dialog defaults, from OrcaSlicer v2.3.0 src/slic3r/GUI/calib_dlg.cpp.
// Temperature towers use 5 °C steps between these per-material bounds; PLA bounds cover other materials.
const temperatures: [RegExp, number, number][] = [
  [/^(ABS|ASA)/i, 230, 270], [/^PETG/i, 230, 250], [/^PCTG/i, 240, 280], [/^TPU/i, 210, 240], [/^(PA|PET)-CF/i, 280, 320],
];
// Pressure advance uses the direct-drive tower range; a Bowden extruder needs a wider one.
const ranges: Partial<Record<CalibrationStep, [number, number, number]>> = {
  pressure_advance: [0, 0.1, 0.002], retraction: [0, 2, 0.1], volumetric_flow: [5, 20, 0.5],
};

function first(content: Record<string, unknown> | undefined, key: string) {
  const value = content?.[key];
  const item = Array.isArray(value) ? value[0] : value;
  return typeof item === 'string' || typeof item === 'number' ? String(item) : '';
}

/** A test range for a step that has none saved yet, around the filament profile's current value. */
export function defaultTestValues(step: CalibrationStep, field: string, content: Record<string, unknown> | undefined,
  maxTemperature: number | null | undefined): TestValues {
  const baseline = first(content, field);
  if (step === 'temperature') {
    const material = first(content, 'filament_type');
    const [, low, high] = temperatures.find(([pattern]) => pattern.test(material)) ?? [null, 190, 230];
    // Stay under the session's temperature limit, on the 5 °C grid.
    const highest = maxTemperature == null ? high : Math.min(high, Math.floor(maxTemperature / 5) * 5);
    return { lowest: String(Math.min(low, highest - 5)), highest: String(highest), increment: '5', baseline };
  }
  if (step === 'flow_rate') {
    // Orca's first flow pass prints nine tiles from -20% to +20% of the current ratio.
    const ratio = Number(baseline);
    if (!baseline || !(ratio > 0)) return { lowest: '', highest: '', increment: '', baseline };
    // Rounded endpoints in thousandths, with the step derived from them, keep the top tile at +20% and on the step grid.
    const lowest = Math.round(ratio * 800), highest = Math.round(ratio * 1200);
    return { lowest: String(lowest / 1000), highest: String(highest / 1000), increment: String((highest - lowest) / 8 / 1000), baseline };
  }
  const [lowest, highest, increment] = ranges[step]!;
  return { lowest: String(lowest), highest: String(highest), increment: String(increment), baseline };
}
