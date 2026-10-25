import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SlicerFooter } from '../../features/slicer-workbench/SlicerFooter';

describe('SlicerFooter', () => {
  it('omits the object count when it is unknown instead of saying it is unavailable', () => {
    render(<SlicerFooter plateName="Plate 1" objectCount={null} />);
    expect(screen.getByText('Plate 1')).toBeInTheDocument();
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });

  it('keeps the engine hash in the title attribute instead of the visible text', () => {
    render(<SlicerFooter plateName="Plate 1" objectCount={2} engine={{ label: 'OrcaSlicer 2.4.2', hash: '1e646235e4ffff' }} />);
    expect(screen.getByText('OrcaSlicer 2.4.2')).toHaveAttribute('title', '1e646235e4ffff');
    expect(screen.queryByText(/1e646235/)).not.toBeInTheDocument();
  });
});
