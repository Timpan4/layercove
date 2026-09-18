import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SlicerSettingsSidebar, type SlicerSettingsSidebarProps } from '../../features/slicer-workbench/SlicerSettingsSidebar';

const props: SlicerSettingsSidebarProps = {
  pages: [{ id: 'quality', label: 'Quality', groups: [{ id: 'layers', label: 'Layers', options: ['layer_height'] }] }],
  settings: [{ key: 'layer_height', label: 'Layer height', mode: 'simple', scope: 'global', kind: 'number', value: '0.2' }],
  mode: 'simple', onModeChange: vi.fn(), pageId: 'quality', onPageChange: vi.fn(),
  scope: 'global', onScopeChange: vi.fn(), onSettingChange: vi.fn(),
};

function longCatalog() {
  return <>
    <label>Physical printer<select><option>Voron 0.4 mm</option></select></label>
    <details>
      <summary>Unclassified (28)</summary>
      {Array.from({ length: 28 }, (_, index) => <label key={index} className="block py-2">
        <input type="radio" name="filament" />Filament {index + 1}
        <span className="block">Manual confirmation required · compatibility unknown, nozzle match</span>
      </label>)}
    </details>
    <label><input type="checkbox" />Confirm current target and nozzle before slicing</label>
  </>;
}

describe('SlicerSettingsSidebar scroll ownership', () => {
  it('keeps an expanded 28-profile catalog and the following settings in the same vertical scroller', () => {
    render(<div style={{ height: 480, width: 320 }}><SlicerSettingsSidebar {...props} selectionPanel={longCatalog()} /></div>);
    const sidebar = screen.getByRole('complementary');
    const details = screen.getByText('Unclassified (28)').closest('details')!;
    fireEvent.click(screen.getByText('Unclassified (28)'));
    expect(details.open).toBe(true);
    expect(screen.getAllByRole('radio')).toHaveLength(28);
    expect(sidebar).toHaveClass('overflow-y-auto', 'overflow-x-hidden', 'overscroll-contain', 'min-h-0');
    expect(sidebar).not.toHaveClass('overflow-hidden');
    const catalogSection = details.closest('section')!;
    const processSection = screen.getByText('Process', { exact: true }).closest('section')!;
    expect(catalogSection).toHaveClass('shrink-0');
    expect(processSection).toHaveClass('shrink-0');
    expect(processSection).not.toHaveClass('overflow-hidden');
    expect(sidebar).toContainElement(screen.getByRole('checkbox'));
    expect(sidebar).toContainElement(screen.getByRole('spinbutton', { name: 'Layer height' }));
  });

  it('keeps legacy presets and object controls in the sidebar scroller too', () => {
    render(<SlicerSettingsSidebar {...props} supportsObjectState scope="object"
      printerName="Legacy printer" filamentName="PLA" processName="Standard"
      objects={[{ id: 'part', name: 'Part', hidden: false, locked: false }]} />);
    const sidebar = screen.getByRole('complementary');
    expect(sidebar).toHaveClass('overflow-y-auto');
    expect(sidebar).toContainElement(screen.getByRole('combobox', { name: 'Machine preset' }));
    expect(sidebar).toContainElement(screen.getByRole('button', { name: 'Hide Part' }));
    expect(sidebar).toContainElement(screen.getByRole('button', { name: 'Lock Part' }));
    expect(screen.getByRole('button', { name: 'Hide Part' }).parentElement!.parentElement!).not.toHaveClass('overflow-auto');
  });
});
