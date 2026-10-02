import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlicerWorkbenchPage } from '../../pages/SlicerWorkbenchPage';
import { useSlicerWorkbench } from '../../features/slicer-workbench/useSlicerWorkbench';

vi.mock('../../features/slicer-workbench/useSlicerWorkbench');
vi.mock('../../components/CatalogSliceSelector', () => ({ CatalogSliceSelector: () => <div>Target profiles</div> }));
vi.mock('../../components/ModelViewer', () => ({ ModelViewer: ({ showBuildPlate }: { showBuildPlate?: boolean }) => <div data-testid="model" data-bed={showBuildPlate}>Model preview</div> }));
vi.mock('../../components/GcodeViewer', () => ({ GcodeViewer: ({ showBuildPlate }: { showBuildPlate?: boolean }) => <div data-testid="gcode" data-bed={showBuildPlate}>Toolpath preview</div> }));

function mockedModel(filename = 'cube.stl') {
  return {
    capabilitiesQuery: { data: { capabilities: { process_schema: true, model_state: false } } },
    schemaQuery: { data: { pages: [], options: [], scopes: {}, samples: {}, engine: { name: 'OrcaSlicer', version: '2.4.2' }, schema_hash: 'abc' } },
    sourceQuery: { data: { filename } }, platesQuery: { data: { plates: [] } },
    catalogSelection: {}, printerProfileQuery: {}, buildVolume: null, bedGeometry: { bed: null, issue: 'missingArea' },
    sourceName: 'cube.stl', modelUrl: '/cube.stl', previewUrl: '/cube.gcode',
    objects: [], selectedPlateMetadata: null, filamentSlots: [], arrange: true,
    settingsView: 'global', mode: 'simple', jobId: null, canPrint: true,
    jobState: { status: 'completed', kind: 'library_file', source_id: 42 }, request: {}, processOverrides: {},
    processProfileQuery: {}, schemaOptions: new Map(),
  } as unknown as ReturnType<typeof useSlicerWorkbench>;
}

beforeEach(() => {
  vi.mocked(useSlicerWorkbench).mockReturnValue(mockedModel());
});

function open() {
  render(<MemoryRouter initialEntries={['/slicer?library_file=42']}><SlicerWorkbenchPage /></MemoryRouter>);
}

describe('Workbench with missing bed metadata', () => {
  it('does not present missing slicer estimates as zero time or filament', () => {
    vi.mocked(useSlicerWorkbench).mockReturnValue({
      ...mockedModel(),
      result: { library_file_id: 77, name: 'cube.gcode', print_time_seconds: 0, filament_used_g: 0, filament_used_mm: 0, used_embedded_settings: false },
    });
    open();
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
    expect(screen.queryByText('0m')).not.toBeInTheDocument();
    expect(screen.queryByText('0 g')).not.toBeInTheDocument();
  });

  it('keeps positive estimates visible for a small calibration print', () => {
    vi.mocked(useSlicerWorkbench).mockReturnValue({
      ...mockedModel(),
      result: { library_file_id: 77, name: 'calibration.gcode', print_time_seconds: 45, filament_used_g: 0.04, filament_used_mm: 13, used_embedded_settings: false },
    });
    open();
    expect(screen.getByText('45s')).toBeInTheDocument();
    expect(screen.getByText('0.04 g')).toBeInTheDocument();
  });

  it('shows slicer time and material after a fresh slice completes', () => {
    vi.mocked(useSlicerWorkbench).mockReturnValue({
      ...mockedModel(),
      result: { library_file_id: 77, name: 'cube.gcode', print_time_seconds: 3720, filament_used_g: 12.5, filament_used_mm: 4000, used_embedded_settings: false },
    });
    open();
    fireEvent.click(screen.getByRole('button', { name: 'preview' }));
    expect(screen.getByRole('region', { name: 'Slice estimates' })).toBeInTheDocument();
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
    expect(screen.getByText('12.5 g')).toBeInTheDocument();
  });

  it('lets phone users reach settings and return to each canvas without losing the model', () => {
    open();
    const settings = screen.getByRole('button', { name: /settings/i });
    expect(settings).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(settings);
    expect(settings).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Target profiles')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /canvas/i }));
    expect(screen.getByTestId('model')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview' }));
    expect(screen.getByTestId('gcode')).toBeInTheDocument();
    fireEvent.click(settings);
    fireEvent.click(screen.getByRole('button', { name: /canvas/i }));
    expect(screen.getByTestId('gcode')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'prepare' }));
    expect(screen.getByTestId('model')).toBeInTheDocument();
  });

  it('renders the model without inventing a printer bed', () => {
    open();
    expect(screen.getByTestId('model')).toHaveAttribute('data-bed', 'false');
    expect(screen.getAllByText(/Bed geometry unavailable/).length).toBeGreaterThan(0);
  });

  it('does not describe a loaded STL with no object metadata as empty', () => {
    open();
    expect(screen.queryByText('0 objects')).not.toBeInTheDocument();
    expect(screen.getByText('Object count unavailable')).toBeInTheDocument();
  });

  it('opens a completed toolpath even when the profile has no bed geometry', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'preview' }));
    expect(screen.getByTestId('gcode')).toHaveAttribute('data-bed', 'false');
    expect(screen.queryByText('Slice plate to generate preview.')).not.toBeInTheDocument();
  });

  it('explains that a STEP source cannot be displayed in Prepare', () => {
    vi.mocked(useSlicerWorkbench).mockReturnValue(mockedModel('part.step'));
    open();
    expect(screen.getByText(/STEP source preview is unavailable/)).toBeInTheDocument();
    expect(screen.queryByTestId('model')).not.toBeInTheDocument();
  });
});
