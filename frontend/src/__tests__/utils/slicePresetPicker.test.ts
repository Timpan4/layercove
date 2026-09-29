import { describe, expect, it } from 'vitest';
import type { UnifiedPresetsResponse } from '../../api/client';
import { EMPTY_COMPATIBILITY_INDEX } from '../../utils/slicerPrinterMatch';
import { pickFilamentForSlot, pickProcessDefault } from '../../utils/slicePresetPicker';

const P1S = 'Bambu Lab P1S 0.4 nozzle';
const DREMEL = 'Dremel 3D40';
const AFINIA = 'Afinia H+1(HS)';

function presets(overrides: Partial<UnifiedPresetsResponse> = {}): UnifiedPresetsResponse {
  return {
    orca_cloud: { printer: [], process: [], filament: [] },
    cloud: { printer: [], process: [], filament: [] },
    local: { printer: [], process: [], filament: [] },
    standard: { printer: [], process: [], filament: [] },
    cloud_status: 'ok',
    orca_cloud_status: 'ok',
    ...overrides,
  };
}

describe('slice preset auto-picks', () => {
  it('does not auto-select a process targeting another printer for P1S', () => {
    const by = presets({
      local: {
        printer: [],
        process: [{ id: 'dremel-process', name: '.05mm Super Detail @Dremel 3D40 0.4', source: 'local', compatible_printers: [DREMEL] }],
        filament: [],
      },
    });

    expect(pickProcessDefault(by, P1S, EMPTY_COMPATIBILITY_INDEX)).toBeNull();
  });

  it('does not auto-select a filament targeting another printer for P1S', () => {
    const by = presets({
      local: {
        printer: [],
        process: [],
        filament: [{
          id: 'afinia-filament',
          name: 'Afinia ABS+@HS',
          source: 'local',
          compatible_printers: [AFINIA],
          filament_type: 'PLA',
          filament_colour: '#ffffff',
        }],
      },
    });

    expect(
      pickFilamentForSlot(
        by,
        { type: 'PLA', color: '#ffffff' },
        P1S,
        EMPTY_COMPATIBILITY_INDEX,
      ),
    ).toBeNull();
  });

  it('does not auto-select an unclassified unknown profile', () => {
    const by = presets({
      standard: {
        printer: [],
        process: [{ id: 'unknown-process', name: 'Mystery process', source: 'standard' }],
        filament: [],
      },
    });

    expect(pickProcessDefault(by, P1S, EMPTY_COMPATIBILITY_INDEX)).toBeNull();
  });
});
