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

describe('Command deck page copy', () => {
  it('titles the production dashboard "Printers" without the internal layout eyebrow', () => {
    deck('IDLE');
    expect(screen.getByRole('heading', { level: 1, name: 'Printers' })).toBeInTheDocument();
    expect(screen.queryByText('Fleet plus focus')).not.toBeInTheDocument();
    expect(screen.queryByText('Command deck')).not.toBeInTheDocument();
  });

  it('hides the next action row while a print runs, because there is nothing to act on', () => {
    deck('RUNNING');
    expect(screen.queryByText('Next best action')).not.toBeInTheDocument();
    expect(screen.queryByText('Monitor this print')).not.toBeInTheDocument();
  });

  it('keeps the next action row when the printer is waiting for a job', () => {
    deck('IDLE');
    expect(screen.getByText('Next best action')).toBeInTheDocument();
    expect(screen.getByText('Choose a file to print')).toBeInTheDocument();
  });

  it('hides the machine state row when no notice needs attention', () => {
    deck('IDLE');
    expect(screen.queryByText('Machine state')).not.toBeInTheDocument();
    expect(screen.queryByText('No action needed')).not.toBeInTheDocument();
  });

  it('shows the machine state row when a notice needs attention', () => {
    deck('FINISH', true);
    expect(screen.getByText('Machine state')).toBeInTheDocument();
    expect(screen.getByText('Build plate needs clearing')).toBeInTheDocument();
  });
});
