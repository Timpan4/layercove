import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { CatalogSliceSelector } from '../../components/CatalogSliceSelector';
import type { CatalogSliceSelectionState } from '../../hooks/useCatalogSliceSelection';

function renderReadySelection(reason: string) {
  const readiness = { state: 'ready', reason_codes: [reason] } as const;
  const binding = {
    id: 5, profile_id: 1, printer_id: 1, printer_name: 'Voron', profile_name: 'Voron 0.4',
    expected_nozzle_diameter: 0.4, tool_index: 0, default_process_profile_id: 2,
    default_filament_profile_id: 3, enforcement_state: 'shadow' as const,
    is_active: true, confirmed_at: null,
    readiness: { ...readiness, reason_codes: [...readiness.reason_codes] },
    nozzle: { status: 'confirmed' as const, diameter: 0.4, tool_index: 0 },
  };
  const selection: CatalogSliceSelectionState = {
    activePrinters: [], activeBindings: [binding], printerBindings: [binding],
    destinationArtifactKind: 'klipper_gcode', printerId: 1, bindingId: 5, selectedBinding: binding,
    setPrinterId: vi.fn(), setBindingId: vi.fn(), groups: undefined, catalogProfiles: [],
    allClassifications: [], processChoice: null, filamentChoices: [], selectedPrinterPreset: null,
    selectedPrinterProfile: undefined, selectedFilamentProfiles: [], equivalentFilamentSlotCounts: [],
    applyFilamentToEquivalentSlots: vi.fn(), selectSavedFilament: vi.fn(), selectedProcessPreset: null,
    selectedFilamentPresets: [], chooseProcess: vi.fn(), chooseFilament: vi.fn(), acknowledged: false,
    setAcknowledged: vi.fn(), needsAcknowledgement: false, acknowledgementReasons: [],
    materialWarnings: [], resolvedSelection: null,
    selectionReadiness: { ...readiness, reason_codes: [...readiness.reason_codes] }, loading: false, error: null,
  };
  render(<MemoryRouter><CatalogSliceSelector selection={selection} filamentSlots={[]} /></MemoryRouter>);
}

describe('CatalogSliceSelector readiness display', () => {
  it('does not claim passed checks for a ready state with an unknown reason', () => {
    renderReadySelection('future_backend_reason');
    expect(screen.getAllByText('Readiness could not be verified. Reload the profiles and check the printer binding.').length).toBeGreaterThan(0);
    expect(screen.queryByText('Checks passed.')).not.toBeInTheDocument();
    expect(screen.getAllByText('Readiness could not be verified. Reload the profiles and check the printer binding.')[0].parentElement).not.toHaveClass('text-green-300');
    expect(screen.queryByText('future_backend_reason')).not.toBeInTheDocument();
  });

  it('keeps passed checks for a known ready nozzle match', () => {
    renderReadySelection('nozzle_match');
    expect(screen.getByText('Checks passed.')).toBeInTheDocument();
    expect(screen.getByText('Reported nozzle matches this printer profile.')).toBeInTheDocument();
  });
});
