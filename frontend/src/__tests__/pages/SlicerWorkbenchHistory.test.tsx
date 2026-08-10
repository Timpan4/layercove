import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api, ApiError, type ResliceRequestResponse, type SliceJobState } from '../../api/client';
import { HistoricalReslice } from '../../pages/SlicerWorkbenchPage';
import { render } from '../utils';

const request = {
  printer_preset: { source: 'standard' as const, id: 'printer' },
  process_preset: { source: 'standard' as const, id: 'process' },
  filament_preset: { source: 'standard' as const, id: 'filament' },
  filament_presets: [{ source: 'standard' as const, id: 'filament' }],
  catalog_printer_id: 1,
  catalog_binding_id: 5,
  catalog_process_profile_id: 10,
  catalog_filament_profile_ids: [20],
  catalog_history_job_id: 42,
  catalog_history_mode: 'exact' as const,
};

function state(provenance: SliceJobState['provenance'], status: SliceJobState['status'] = 'completed'): SliceJobState {
  return {
    job_id: 42,
    status,
    kind: 'library_file',
    source_id: 9,
    source_name: 'model.3mf',
    schema_hash: null,
    request_fingerprint: null,
    created_at: '2026-08-10T00:00:00Z',
    started_at: null,
    completed_at: '2026-08-10T00:01:00Z',
    progress: null,
    provenance,
  };
}

const resolvedProvenance: NonNullable<SliceJobState['provenance']> = {
  state: 'resolved',
  printer_revision_id: 11,
  process_revision_id: 12,
  filament_revision_ids: [13],
  selection_evidence: {},
  created_at: '2026-08-10T00:00:00Z',
};

function prepared(overrides: Partial<ResliceRequestResponse> = {}): ResliceRequestResponse {
  return {
    source_kind: 'library_file',
    source_id: 9,
    request,
    tombstoned: false,
    revision_ids: { printer: 11, process: 12, filaments: [13] },
    ...overrides,
  };
}

function renderHistory(jobState: SliceJobState, enqueue = vi.fn().mockResolvedValue(undefined)) {
  render(<HistoricalReslice model={{ jobId: 42, jobState, enqueue }} />);
  return enqueue;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('historical catalog re-slicing', () => {
  it('reports legacy unknown provenance without fabricating exact controls', () => {
    renderHistory(state({
      state: 'provenance_unknown',
      printer_revision_id: null,
      process_revision_id: null,
      filament_revision_ids: null,
      selection_evidence: null,
      created_at: '2026-08-10T00:00:00Z',
    }));

    expect(screen.getByText('Historical slicer provenance unknown')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exact historical' })).not.toBeInTheDocument();
  });

  it('previews then enqueues exact retained revisions', async () => {
    vi.spyOn(api, 'prepareResliceRequest').mockResolvedValue(prepared());
    const enqueue = renderHistory(state(resolvedProvenance));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Exact historical' }));
    expect(await screen.findByRole('dialog', { name: 'Confirm exact historical re-slice' })).toHaveTextContent(
      'Printer revision 11, process revision 12, filament revisions 13',
    );
    await user.click(screen.getByRole('button', { name: 'Confirm re-slice' }));

    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(request, { kind: 'libraryFile', id: 9 }));
  });

  it('requires and preserves explicit tombstone acknowledgement', async () => {
    const acknowledgedRequest = {
      ...request,
      catalog_tombstone_acknowledgement: { confirmed: true },
    };
    vi.spyOn(api, 'prepareResliceRequest')
      .mockResolvedValueOnce(prepared({ tombstoned: true }))
      .mockResolvedValueOnce(prepared({ request: acknowledgedRequest, tombstoned: true }));
    const enqueue = renderHistory(state(resolvedProvenance, 'failed'));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Exact historical' }));
    expect(await screen.findByRole('dialog', { name: 'Tombstoned historical revisions' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Acknowledge and preview' }));
    expect(await screen.findByRole('dialog', { name: 'Confirm exact historical re-slice' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm re-slice' }));

    await waitFor(() => expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ catalog_tombstone_acknowledgement: { confirmed: true } }),
      { kind: 'libraryFile', id: 9 },
    ));
    expect(api.prepareResliceRequest).toHaveBeenNthCalledWith(2, 42, {
      mode: 'exact',
      catalog_tombstone_acknowledgement: { confirmed: true },
    });
  });

  it('collects current target acknowledgement after backend safety recheck', async () => {
    const acknowledgedRequest = {
      ...request,
      catalog_acknowledgement: { confirmed: true },
    };
    vi.spyOn(api, 'prepareResliceRequest')
      .mockResolvedValueOnce(prepared())
      .mockResolvedValueOnce(prepared({ request: acknowledgedRequest }));
    const enqueue = vi.fn()
      .mockRejectedValueOnce(new ApiError(
        'slicer acknowledgement required: nozzle offline',
        409,
        'slicer_acknowledgement_required',
        { reason_codes: ['nozzle_offline'] },
      ))
      .mockResolvedValueOnce(undefined);
    renderHistory(state(resolvedProvenance), enqueue);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Exact historical' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm re-slice' }));
    expect(await screen.findByRole('dialog', { name: 'Confirm current target and nozzle' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Acknowledge and preview' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm re-slice' }));

    await waitFor(() => expect(enqueue).toHaveBeenLastCalledWith(
      expect.objectContaining({ catalog_acknowledgement: { confirmed: true } }),
      { kind: 'libraryFile', id: 9 },
    ));
    expect(api.prepareResliceRequest).toHaveBeenNthCalledWith(2, 42, {
      mode: 'exact',
      catalog_acknowledgement: { confirmed: true },
    });
  });

  it('keeps upgrade explicit and previews current revision IDs', async () => {
    vi.spyOn(api, 'prepareResliceRequest').mockResolvedValue(prepared({
      request: { ...request, catalog_history_mode: 'upgrade' },
      revision_ids: { printer: 21, process: 22, filaments: [23] },
    }));
    renderHistory(state(resolvedProvenance));
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Upgrade catalog' }));

    expect(api.prepareResliceRequest).toHaveBeenCalledWith(42, { mode: 'upgrade' });
    expect(await screen.findByRole('dialog', { name: 'Confirm catalog upgrade' })).toHaveTextContent(
      'Printer revision 21, process revision 22, filament revisions 23',
    );
  });
});
