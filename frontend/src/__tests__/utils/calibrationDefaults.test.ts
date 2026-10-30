import { expect, it } from 'vitest';
import { defaultTestValues } from '../../utils/calibrationDefaults';

// Failure mode: a new step showed empty test ranges, so nothing could be generated without guessing.
it('starts each step from Orca calibration defaults around the profile value', () => {
  const petg = { filament_type: ['PETG'], nozzle_temperature: ['245'], filament_flow_ratio: ['0.98'], pressure_advance: ['0.04'] };
  expect(defaultTestValues('temperature', 'nozzle_temperature', petg, 300))
    .toEqual({ lowest: '230', highest: '250', increment: '5', baseline: '245' });
  expect(defaultTestValues('flow_rate', 'filament_flow_ratio', petg, 300))
    .toEqual({ lowest: '0.784', highest: '1.176', increment: '0.049', baseline: '0.98' });
  expect(defaultTestValues('pressure_advance', 'pressure_advance', petg, 300))
    .toEqual({ lowest: '0', highest: '0.1', increment: '0.002', baseline: '0.04' });
});

// Failure mode: rounding the step first moved the top flow tile past +20%.
it('keeps the flow range at plus and minus 20 percent', () => {
  expect(defaultTestValues('flow_rate', 'filament_flow_ratio', { filament_flow_ratio: ['0.99'] }, null))
    .toEqual({ lowest: '0.792', highest: '1.188', increment: '0.0495', baseline: '0.99' });
});

// Failure mode: a PETG profile that inherits its type got the PLA range of 190-230 °C.
it('takes the material from the parent profile when the profile inherits it', () => {
  expect(defaultTestValues('temperature', 'nozzle_temperature', { inherits: 'Generic PETG @System', nozzle_temperature: ['265'] }, 350))
    .toEqual({ lowest: '230', highest: '250', increment: '5', baseline: '265' });
  // The printer named after "@" is not the material.
  expect(defaultTestValues('temperature', 'nozzle_temperature', { inherits: 'Generic PETG @ASA Printer' }, 350))
    .toEqual({ lowest: '230', highest: '250', increment: '5', baseline: '' });
});

it('keeps the temperature range under the session limit', () => {
  expect(defaultTestValues('temperature', 'nozzle_temperature', { filament_type: ['PA-CF'] }, 298))
    .toEqual({ lowest: '280', highest: '295', increment: '5', baseline: '' });
});
