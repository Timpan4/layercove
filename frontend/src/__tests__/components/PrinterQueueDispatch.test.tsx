import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrinterQueueWidget } from '../../components/PrinterQueueWidget';

const waiting = {
  id: 71, printer_id: 1, archive_id: 3, archive_name: 'Dispatched cube', position: 1,
  status: 'printing', scheduled_time: null,
  dispatch_progress: { stage: 'awaiting_printer', started_at: '2026-01-01T00:00:00Z', stage_started_at: '2026-01-01T00:00:00Z' },
};

describe('printer widget dispatch visibility', () => {
  it.each([false, true])('keeps a dispatched job visible while waiting for acceptance (pending next job: %s)', async (hasNext) => {
    const requested: Array<string | null> = [];
    server.use(http.get('/api/v1/queue/', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status');
      requested.push(status);
      if (status === 'printing') return HttpResponse.json([waiting]);
      if (status === 'pending') return HttpResponse.json(hasNext ? [{ ...waiting, id: 72, archive_name: 'Next cube', status: 'pending', dispatch_progress: null }] : []);
      throw new Error('The widget must not load all history to show dispatch progress');
    }));
    render(<PrinterQueueWidget printerId={1} />);
    await waitFor(() => expect(screen.getByText('Waiting for printer confirmation')).toBeInTheDocument());
    expect(screen.getByText('Dispatched cube')).toBeInTheDocument();
    expect(requested).toContain('pending');
    expect(requested).toContain('printing');
    expect(requested).not.toContain(null);
    if (hasNext) expect(screen.getByText('+1')).toBeInTheDocument();
  });
});
