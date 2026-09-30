import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { expect, it } from 'vitest';
import { GuidedCalibration } from '../../pages/GuidedCalibration';
import { server } from '../mocks/server';
import type { CalibrationSession } from '../../api/client';

// Failure modes: a range save erases a draft, or step navigation keeps another step's draft.
it('preserves a draft result through a range save and loads the next step separately', async () => {
  let session: CalibrationSession = { id: 1, printer_id: 1, filament_profile_id: 1, filament_revision_id: 1,
    nozzle_diameter: 0.4, tool_index: 0, parameters: {}, setting_limits: {}, results: {}, runs: {}, prints: {},
    saved_profile_id: null, version: 1, created_at: '', updated_at: '' };
  let saved = false;
  server.use(
    http.get('*/api/v1/calibration/sessions', () => HttpResponse.json([session])),
    http.get('*/api/v1/calibration/sessions/1', () => HttpResponse.json(session)),
    http.get('*/api/v1/calibration/sessions/1/evidence', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/profiles', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/bindings', () => HttpResponse.json([])),
    http.get('*/api/v1/slicer/catalog/revisions/1', () => HttpResponse.json({ content: { nozzle_temperature: ['210'], filament_flow_ratio: ['1'] } })),
    http.get('*/api/v1/printers/1/status', () => HttpResponse.json({ ams: [] })),
    http.put('*/api/v1/calibration/sessions/1/parameters/temperature', async ({ request }) => {
      const { version, ...values } = await request.json() as { version: number; lowest: number; highest: number; increment: number; baseline: number };
      session = { ...session, version: version + 1, parameters: { temperature: values } };
      saved = true;
      return HttpResponse.json(session);
    }),
    http.put('*/api/v1/calibration/sessions/1/results/temperature', () => {
      session = { ...session, version: session.version + 1, results: { temperature: 210 } };
      return HttpResponse.json(session);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={['/profiles?calibration=guided&calibrationSession=1']}>
    <QueryClientProvider client={client}><GuidedCalibration printers={[]} /></QueryClientProvider>
  </MemoryRouter>);
  await waitFor(() => expect(screen.getByLabelText('Baseline value (°C)')).toHaveValue(210));
  fireEvent.change(screen.getByLabelText('Lowest test value (°C)'), { target: { value: '200' } });
  fireEvent.change(screen.getByLabelText('Highest test value (°C)'), { target: { value: '220' } });
  fireEvent.change(screen.getByLabelText('Step size (°C)'), { target: { value: '5' } });
  fireEvent.change(screen.getByLabelText('Custom result (°C)'), { target: { value: '210' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save test values' }));
  await waitFor(() => { expect(saved).toBe(true); expect(screen.getByRole('button', { name: 'Save test values' })).toBeEnabled(); });
  expect(screen.getByLabelText('Custom result (°C)')).toHaveValue(210);
  fireEvent.change(screen.getByLabelText('Lowest test value (°C)'), { target: { value: '205' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use value' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit result' }));
  expect(screen.getByLabelText('Lowest test value (°C)')).toHaveValue(205);
  fireEvent.click(screen.getByRole('button', { name: 'Use value' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Next: Flow rate' }));
  await waitFor(() => expect(screen.getByLabelText('Custom result (ratio)')).toHaveValue(null));
  expect(screen.getByLabelText('Baseline value (ratio)')).toHaveValue(1);
});
