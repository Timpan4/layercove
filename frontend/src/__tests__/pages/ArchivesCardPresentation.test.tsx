/**
 * Regression tests for archive card presentation: the time-accuracy badge,
 * the file size for archives whose file was never pulled from the printer,
 * and the status chip labels. Covers both the grid card and the list row.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { ArchivesPage } from '../../pages/ArchivesPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const baseArchive = {
  printer_id: 1,
  printer_name: 'X1 Carbon',
  print_time_seconds: 3600,
  actual_time_seconds: null,
  time_accuracy: null,
  filament_used_grams: 15.5,
  status: 'completed',
  started_at: null,
  completed_at: null,
  thumbnail_path: null,
  notes: null,
  rating: null,
  project_id: null,
  project_name: null,
  project_color: null,
  print_count: 1,
  tags: '',
  file_size: 0,
  created_at: '2024-01-01T09:00:00Z',
  updated_at: '2024-01-01T11:00:00Z',
  has_f3d: false,
};

const fixtureArchives = [
  // Accuracy 98 means the print ran slightly longer than estimated.
  { ...baseArchive, id: 101, print_name: 'Slow Bracket', time_accuracy: 98, actual_time_seconds: 3672 },
  // Accuracy 110 means the print finished faster than estimated.
  { ...baseArchive, id: 102, print_name: 'Fast Clip', time_accuracy: 110, actual_time_seconds: 3273 },
  { ...baseArchive, id: 103, print_name: 'On Time Cap', time_accuracy: 100, actual_time_seconds: 3600 },
  // Rounds to a 0% deviation, so no badge should render.
  { ...baseArchive, id: 104, print_name: 'Rounds Lid', time_accuracy: 99.6, actual_time_seconds: 3614 },
  { ...baseArchive, id: 105, print_name: 'Failed Vase', status: 'failed' },
  { ...baseArchive, id: 106, print_name: 'Aborted Hinge', status: 'aborted' },
  { ...baseArchive, id: 107, print_name: 'Sized Mount', file_size: 2097152 },
];

// Archives in fixtureArchives with file_size 0 (no file pulled from the printer).
const archivesWithoutFile = 6;

describe.each(['grid', 'list'] as const)('ArchivesPage card presentation (%s view)', (viewMode) => {
  beforeEach(() => {
    localStorage.setItem('archiveViewMode', viewMode);
    server.use(
      http.get('/api/v1/archives/', () => HttpResponse.json(fixtureArchives)),
      http.get('/api/v1/archives/stats', () =>
        HttpResponse.json({
          total_archives: fixtureArchives.length,
          total_print_time_seconds: 0,
          total_filament_grams: 0,
          prints_this_week: 0,
          prints_this_month: 0,
        })
      ),
      http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon' }])),
      http.get('/api/v1/projects/', () => HttpResponse.json([])),
      http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
      http.get('/api/v1/archives/:id/plates', ({ params }) =>
        HttpResponse.json({
          archive_id: Number(params.id),
          filename: 'sample.3mf',
          plates: [],
          is_multi_plate: false,
        })
      ),
      http.get('/api/v1/archives/:id/filament-requirements', () => HttpResponse.json([]))
    );
  });

  afterEach(() => {
    localStorage.removeItem('archiveViewMode');
  });

  it('shows a file size of "No file" instead of "0 B" when no file was pulled', async () => {
    render(<ArchivesPage />);

    await waitFor(() => {
      expect(screen.getAllByText('No file')).toHaveLength(archivesWithoutFile);
    });
    expect(screen.queryByText('0 B')).not.toBeInTheDocument();
  });

  it('keeps the real size for archives that have a file', async () => {
    render(<ArchivesPage />);

    await waitFor(() => {
      expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    });
  });

  it('shows failed and aborted archives with capitalized status labels', async () => {
    render(<ArchivesPage />);

    await waitFor(() => {
      expect(screen.getByText('Failed Vase')).toBeInTheDocument();
    });
    expect(screen.queryByText('failed')).not.toBeInTheDocument();
    expect(screen.queryByText('cancelled')).not.toBeInTheDocument();
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Cancelled').length).toBeGreaterThan(0);
  });
});

describe('ArchivesPage time-accuracy badge (grid view)', () => {
  beforeEach(() => {
    localStorage.setItem('archiveViewMode', 'grid');
    server.use(
      http.get('/api/v1/archives/', () => HttpResponse.json(fixtureArchives)),
      http.get('/api/v1/printers/', () => HttpResponse.json([{ id: 1, name: 'X1 Carbon' }])),
      http.get('/api/v1/projects/', () => HttpResponse.json([])),
      http.get('/api/v1/archives/tags', () => HttpResponse.json([])),
      http.get('/api/v1/archives/:id/plates', ({ params }) =>
        HttpResponse.json({
          archive_id: Number(params.id),
          filename: 'sample.3mf',
          plates: [],
          is_multi_plate: false,
        })
      ),
      http.get('/api/v1/archives/:id/filament-requirements', () => HttpResponse.json([]))
    );
  });

  afterEach(() => {
    localStorage.removeItem('archiveViewMode');
  });

  it('labels a below-100 accuracy as slower than estimate', async () => {
    render(<ArchivesPage />);

    expect(await screen.findByText('2% slower than estimate')).toBeInTheDocument();
  });

  it('labels an above-100 accuracy as faster than estimate', async () => {
    render(<ArchivesPage />);

    expect(await screen.findByText('10% faster than estimate')).toBeInTheDocument();
  });

  it('never renders a bare signed percent such as "-2%" or "+10%"', async () => {
    render(<ArchivesPage />);

    await screen.findByText('Fast Clip');
    expect(screen.queryByText(/^[+-]\d+%$/)).not.toBeInTheDocument();
  });

  it('renders no badge when the rounded deviation is 0', async () => {
    render(<ArchivesPage />);

    await screen.findByText('Rounds Lid');
    // Only the 98 and 110 archives have a deviation. The 100 and 99.6 archives must not get a badge.
    expect(screen.queryByText(/^[+-]?0%$/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/ than estimate$/)).toHaveLength(2);
  });
});
