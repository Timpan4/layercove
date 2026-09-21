import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { Printer, PrinterStatus } from '../../api/client';
import { PrintersPagePrototype } from '../../pages/PrintersPagePrototype';

vi.mock('../../components/CameraTile', () => ({ CameraTile: () => <div>Camera</div> }));

function deck(state: string, awaiting_plate_clear = false) {
  const props: ComponentProps<typeof PrintersPagePrototype> = {
    printers: [{
      printer: { id: 1, name: 'Test printer', model: 'P1S', provider: 'bambu' } as Printer,
      status: {
        connected: true, state, progress: 95, layer_num: 19, total_layers: 20,
        subtask_name: 'Curtain_hook.gcode', remaining_time: 3, awaiting_plate_clear,
        ams: [{ id: 0, tray: [{ id: 0, tray_type: 'PLA', remain: -1 }] }],
      } as PrinterStatus,
    }],
    totalPrinters: 1, isLoading: false, search: '', statusFilter: 'all', locationFilter: 'all',
    availableLocations: [], hideOffline: false, sortBy: 'name', canAdd: false, production: true,
    onSearchChange: vi.fn(), onStatusFilterChange: vi.fn(), onLocationFilterChange: vi.fn(),
    onHideOfflineChange: vi.fn(), onSortChange: vi.fn(),
  };
  return render(<MemoryRouter><PrintersPagePrototype {...props} /></MemoryRouter>);
}

describe('Command deck live telemetry', () => {
  it('shows Bambu RUNNING as printing with its reported progress and next action', () => {
    deck('RUNNING');
    expect(screen.getByText('Monitor this print')).toBeInTheDocument();
    expect(screen.queryByText('Choose a file to print')).not.toBeInTheDocument();
    expect(screen.getAllByText('95%').length).toBeGreaterThan(0);
  });

  it('does not ask to clear the plate during an active print', () => {
    deck('RUNNING', true);
    expect(screen.queryByText('Build plate needs clearing')).not.toBeInTheDocument();
  });

  it('retains the plate-clear reminder after printing', () => {
    deck('FINISH', true);
    expect(screen.getByText('Build plate needs clearing')).toBeInTheDocument();
  });

  it('asks to clear an idle plate before choosing another job', () => {
    deck('IDLE', true);
    expect(screen.getByText('Clear plate and prepare next job')).toBeInTheDocument();
    expect(screen.queryByText('Choose a file to print')).not.toBeInTheDocument();
  });

  it('shows unknown filament remaining instead of the -1 sentinel', () => {
    deck('IDLE');
    expect(screen.queryByText('-1%')).not.toBeInTheDocument();
    expect(screen.getByText('Remaining unknown')).toBeInTheDocument();
  });
});
