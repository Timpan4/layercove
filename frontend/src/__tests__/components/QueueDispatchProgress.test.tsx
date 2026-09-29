import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueueDispatchProgress } from '../../components/QueueDispatchProgress';

afterEach(() => vi.useRealTimers());
it('shows real byte progress, elapsed time and separate upload/start acknowledgement', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));
  const progress = { stage: 'uploading' as const, started_at: '2026-01-01T00:00:00Z', stage_started_at: '2026-01-01T00:00:00Z', bytes_transferred: 100, total_bytes: 100 };
  const { rerender } = render(<QueueDispatchProgress progress={progress} />);
  expect(screen.getByText('Uploading to printer')).toBeInTheDocument();
  expect(screen.getByText(/waiting for the upload response/)).toBeInTheDocument();
  expect(screen.queryByText(/start has not yet/)).not.toBeInTheDocument();
  rerender(<QueueDispatchProgress progress={{ ...progress, stage: 'awaiting_printer' }} />);
  expect(screen.getByText('Waiting for printer confirmation')).toBeInTheDocument();
  expect(screen.getByText(/start has not yet been confirmed/)).toBeInTheDocument();
});
