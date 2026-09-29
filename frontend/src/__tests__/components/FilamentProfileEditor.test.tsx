import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type SlicerCatalogProfile } from '../../api/client';
import { FilamentProfileEditor } from '../../components/FilamentProfileEditor';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ hasPermission: () => true }) }));
const profile = { profile_id: 8, revision_id: 15, display_name: 'Cloud PLA', sharing_state: 'private' } as SlicerCatalogProfile;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute('open', ''); });
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.removeAttribute('open'); });
  vi.spyOn(api, 'getSlicerCatalogRevision').mockResolvedValue({ id: 15, profile_id: 8, content_hash: 'old', review_state: 'approved',
    content: { name: 'Cloud PLA', type: 'filament', compatible_printers: ['Printer'], nozzle_temperature: ['220','215'], filament_flow_ratio: ['0.98'] } });
});
afterEach(() => vi.restoreAllMocks());
it('edits real revision values, preserves array slots and requires consent before saving a copy', async () => {
  const copy = vi.spyOn(api, 'copySlicerFilament').mockResolvedValue({ profile_id: 30, revision_id: 40, local_preset_id: 6 });
  const saved = vi.fn().mockResolvedValue(undefined), close = vi.fn();
  render(<QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}>
    <FilamentProfileEditor profile={profile} onSaved={saved} onClose={close} />
  </QueryClientProvider>);
  const input = await screen.findByLabelText('Nozzle temperature (°C)');
  fireEvent.change(input, { target: {value: '235'} });
  const save = screen.getByRole('button', {name: 'Save and use local copy'});
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(save);
  await waitFor(() => expect(saved).toHaveBeenCalledWith(30));
  expect(copy).toHaveBeenCalledWith(8, { base_revision_id: 15, name: 'Cloud PLA - edited', share_local_copy: true,
    overrides: {nozzle_temperature: ['235','215']} });
  expect(close).toHaveBeenCalled();
});
