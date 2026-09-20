import { act, cleanup, render as renderBare, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import i18n from '../../i18n';
import { QueueDispatchProgress } from '../../components/QueueDispatchProgress';
import { PrinterQueueWidget } from '../../components/PrinterQueueWidget';
import { server } from '../mocks/server';
import { render } from '../utils';

const languages = ['en', 'de', 'es', 'fr', 'ja', 'it', 'ko', 'pt-BR', 'tr', 'zh-CN', 'zh-TW'];
const keys = [
  'queue.printDispatch', 'queue.dispatch.progressLabel', 'queue.dispatch.preparing',
  'queue.dispatch.uploading', 'queue.dispatch.awaitingPrinter', 'queue.dispatch.uploadProgress',
  'queue.dispatch.elapsed', 'queue.dispatch.uploadSummary', 'queue.dispatch.waitingForUpload',
  'queue.dispatch.waitingForStart', 'dispatchToast.preparingFile',
  'dispatchToast.uploadingBytes', 'dispatchToast.uploadingBytesWithProgress',
];

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

it.each(languages)('renders dispatch phases and accessibility text using the actual %s locale', async (language) => {
  await i18n.changeLanguage(language);
  for (const key of keys) {
    expect(i18n.exists(key, { lng: language, fallbackLng: false }), `${language}: ${key}`).toBe(true);
  }
  const progress = { stage: 'preparing' as const, started_at: '2026-01-01T00:00:00Z', stage_started_at: '2026-01-01T00:00:00Z', bytes_transferred: 100, total_bytes: 100 };
  const { rerender } = renderBare(<QueueDispatchProgress progress={progress} />);
  expect(screen.getByRole('status', { name: i18n.t('queue.dispatch.progressLabel') })).toBeInTheDocument();
  expect(screen.getByText(i18n.t('queue.dispatch.preparing'))).toBeInTheDocument();
  rerender(<QueueDispatchProgress progress={{ ...progress, stage: 'uploading' }} />);
  expect(screen.getByText(i18n.t('queue.dispatch.uploading'))).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: i18n.t('queue.dispatch.uploadProgress') })).toHaveAttribute('aria-valuenow', '100');
  expect(screen.getByText(i18n.t('queue.dispatch.uploadSummary', { transferred: '100 B', total: '100 B', percent: 100 }))).toBeInTheDocument();
  expect(screen.getByText(i18n.t('queue.dispatch.waitingForUpload'))).toBeInTheDocument();
  rerender(<QueueDispatchProgress progress={{ ...progress, stage: 'awaiting_printer' }} />);
  expect(screen.getByText(i18n.t('queue.dispatch.awaitingPrinter'))).toBeInTheDocument();
  expect(screen.getByText(i18n.t('queue.dispatch.waitingForStart'))).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

it('translates the printer widget dispatch heading', async () => {
  await i18n.changeLanguage('de');
  server.use(http.get('/api/v1/queue/', ({ request }) => HttpResponse.json(
    new URL(request.url).searchParams.get('status') === 'printing' ? [{
      id: 71, printer_id: 1, archive_id: 3, archive_name: 'Cube', position: 1, status: 'printing', scheduled_time: null,
      dispatch_progress: { stage: 'awaiting_printer', started_at: '2026-01-01T00:00:00Z', stage_started_at: '2026-01-01T00:00:00Z' },
    }] : [],
  )));
  render(<PrinterQueueWidget printerId={1} />);
  await waitFor(() => expect(screen.getByText('Druckübertragung')).toBeInTheDocument());
});

it('translates preparation and both upload toast variants with byte interpolation', async () => {
  await i18n.changeLanguage('de');
  render(<div />);
  const emit = (detail: Record<string, unknown>) => act(() => {
    window.dispatchEvent(new CustomEvent('bambuddy:dispatch-toast', { detail }));
  });
  const job = { queue_item_id: 42, printer_id: 1, printer_name: 'Printer', file_name: 'Cube.gcode' };
  emit({ ...job, type: 'queue_item_dispatch_stage', stage: 'preparing' });
  expect(screen.getByText('Datei für die Übertragung vorbereiten…')).toBeInTheDocument();
  emit({ ...job, type: 'queue_item_uploading', total_bytes: 100 });
  expect(screen.getByText('Hochladen: 0 B / 100 B (0.0%)')).toBeInTheDocument();
  emit({ ...job, type: 'queue_item_upload_progress', bytes_transferred: 25, total_bytes: 100 });
  expect(screen.getByText('Hochladen: 25 B / 100 B')).toBeInTheDocument();
  emit({ ...job, type: 'queue_item_upload_progress', bytes_transferred: 50, total_bytes: 100, pct: 50 });
  expect(screen.getByText('Hochladen: 50 B / 100 B (50.0%)')).toBeInTheDocument();
});
