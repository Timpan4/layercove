import { describe, expect, it } from 'vitest';
import { isActivePrintState, normalizePrintState } from '../../utils/printerState';

describe('printer state normalization', () => {
  it.each([
    ['RUNNING', 'printing'],
    ['PRINTING', 'printing'],
    ['PAUSE', 'paused'],
    ['PAUSED', 'paused'],
    ['PREPARING', 'preparing'],
    ['PREPARE', 'preparing'],
    ['SLICING', 'preparing'],
    ['FINISH', 'finished'],
    ['COMPLETED', 'finished'],
    ['CANCELLED', 'finished'],
    ['CANCELED', 'finished'],
    ['STOPPED', 'finished'],
  ] as const)('maps %s to %s', (state, expected) => {
    expect(normalizePrintState(state)).toBe(expected);
  });

  it.each(['RUNNING', 'PRINTING', 'PAUSE', 'PAUSED', 'PREPARING', 'PREPARE', 'SLICING'])(
    'treats %s as active',
    (state) => expect(isActivePrintState(state)).toBe(true),
  );

  it.each(['FINISH', 'COMPLETED', 'CANCELLED', 'CANCELED', 'STOPPED', 'IDLE'])(
    'treats %s as terminal or idle',
    (state) => expect(isActivePrintState(state)).toBe(false),
  );
});
