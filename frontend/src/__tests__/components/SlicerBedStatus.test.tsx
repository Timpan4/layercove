import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SlicerBedStatus } from '../../features/slicer-workbench/SlicerBedStatus';

describe('SlicerBedStatus', () => {
  it('asks for a printer instead of reporting missing bed geometry when none is selected', () => {
    render(<SlicerBedStatus profileName={undefined} revisionId={undefined} loading={false} failed={false} issue={null} onRetry={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Choose a printer to see its bed.');
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });
});
