import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlicerWorkbenchPage } from '../../pages/SlicerWorkbenchPage';
import { useSlicerWorkbench } from '../../features/slicer-workbench/useSlicerWorkbench';

vi.mock('../../features/slicer-workbench/useSlicerWorkbench');
vi.mock('../../components/CatalogSliceSelector', () => ({ CatalogSliceSelector: () => <div>Target profiles</div> }));
vi.mock('../../components/ModelViewer', () => ({ ModelViewer: ({ showBuildPlate }: { showBuildPlate?: boolean }) => <div data-testid="model" data-bed={showBuildPlate}>Model preview</div> }));
vi.mock('../../components/GcodeViewer', () => ({ GcodeViewer: ({ showBuildPlate }: { showBuildPlate?: boolean }) => <div data-testid="gcode" data-bed={showBuildPlate}>Toolpath preview</div> }));

beforeEach(() => {
  vi.mocked(useSlicerWorkbench).mockReturnValue({
    capabilitiesQuery: { data: { capabilities: { process_schema: true, model_state: false } } },
    schemaQuery: { data: { pages: [], options: [], scopes: {}, samples: {}, engine: { name: 'OrcaSlicer', version: '2.4.2' }, schema_hash: 'abc' } },
    sourceQuery: { data: { filename: 'cube.stl' } }, platesQuery: { data: { plates: [] } },
    catalogSelection: {}, printerProfileQuery: {}, buildVolume: null, bedGeometry: { bed: null, issue: 'missingArea' },
    sourceName: 'cube.stl', modelUrl: '/cube.stl', previewUrl: '/cube.gcode',
    objects: [], selectedPlateMetadata: null, filamentSlots: [], arrange: true,
    settingsView: 'global', mode: 'simple', jobId: null, canPrint: true,
    jobState: { status: 'completed' }, request: {}, processOverrides: {},
    processProfileQuery: {}, schemaOptions: new Map(),
  } as unknown as ReturnType<typeof useSlicerWorkbench>);
});

function open() {
  render(<MemoryRouter initialEntries={['/slicer?library_file=42']}><SlicerWorkbenchPage /></MemoryRouter>);
}

describe('Workbench with missing bed metadata', () => {
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
});
