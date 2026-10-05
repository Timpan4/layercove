/**
 * The grouped header row shows summed label/core weights, but the weight check
 * compares one spool's scale reading. It must not flag a mismatch (or offer a
 * sync) for a correct representative reading.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import InventoryPageRouter from '../../pages/InventoryPage';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

const baseSpool = {
  material: 'PLA',
  subtype: null,
  brand: 'Polymaker',
  color_name: 'Red',
  rgba: 'FF0000FF',
  label_weight: 1000,
  core_weight: 250,
  weight_used: 0,
  slicer_filament: null,
  slicer_filament_name: null,
  nozzle_temp_min: null,
  nozzle_temp_max: null,
  note: null,
  added_full: null,
  last_used: null,
  encode_time: null,
  tag_uid: null,
  tray_uuid: null,
  data_origin: null,
  tag_type: null,
  archived_at: null,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  k_profiles: [],
  cost_per_kg: null,
  last_weighed_at: null,
};

const spools = [
  { ...baseSpool, id: 1, last_scale_weight: 1250 }, // full spool, correct reading
  { ...baseSpool, id: 2, last_scale_weight: null },
];

describe('InventoryPage grouped weight check', () => {
  beforeEach(() => {
    // setup.ts replaces localStorage with vi.fn() stubs, so feed values via getItem.
    const stored: Record<string, string> = {
      'bambuddy-inventory-group': 'true',
      'bambuddy-inventory-columns': JSON.stringify([
        { id: 'material', label: 'Material', visible: true },
        { id: 'weight_check', label: 'Weight Check', visible: true },
      ]),
    };
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => stored[key] ?? null);
    server.use(
      http.get('/api/v1/inventory/spools', () => HttpResponse.json(spools)),
      http.get('/api/v1/inventory/assignments', () => HttpResponse.json([])),
      http.get('/api/v1/spoolman/settings', () => HttpResponse.json({ spoolman_enabled: 'false' })),
    );
  });

  it('does not offer a weight sync on the group header for a correct representative reading', async () => {
    render(<InventoryPageRouter />);

    await waitFor(() => {
      expect(document.body.textContent).toContain('1250g');
    });
    expect(screen.queryByTitle(/Sync: trust scale weight/)).not.toBeInTheDocument();
  });
});
