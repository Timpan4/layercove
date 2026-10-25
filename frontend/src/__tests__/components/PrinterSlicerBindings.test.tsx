import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrinterSlicerBindings } from '../../components/PrinterSlicerBindings';
import {
  api,
  type Printer,
  type PrinterStatus,
  type SlicerCatalogBinding,
  type SlicerCatalogClassification,
} from '../../api/client';

const auth = vi.hoisted(() => ({ enabled: true, update: true }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authEnabled: auth.enabled, hasPermission: (permission: string) => permission === 'printers:update' && auth.update }),
}));
vi.mock('../../components/ConfirmModal', () => ({
  ConfirmModal: ({ title, message, onConfirm, onCancel }: { title: string; message: string; onConfirm: () => void; onCancel: () => void }) => <div role="dialog"><h2>{title}</h2><p>{message}</p><button onClick={onConfirm}>Confirm and bind</button><button onClick={onCancel}>Cancel</button></div>,
}));

const printer = (id: number, name: string, model: string | null, provider: Printer['provider'] = 'bambu') => ({ id, name, model, provider, is_active: true } as Printer);
const profile = { profile_id: 10, revision_id: 1, source: 'local', account_id: 1, account_name: null, remote_profile_id: 'p', profile_type: 'printer', display_name: 'P1S profile', content_hash: 'hash', compatibility_metadata: {}, tombstoned: false, stale: false, sharing_state: 'private' } as const;
const voronProfile ={ ...profile, profile_id: 11, remote_profile_id: 'voron', display_name: 'Voron 0.4 profile' } as const;
const p1sMetadataProfile = { ...profile, profile_id: 12, remote_profile_id: 'p1s-meta', display_name: 'Bambu PLA Basic', compatibility_metadata: { model: 'P1S' } } as const;
const binding = (id: number, profileName: string): SlicerCatalogBinding => ({
  id,
  printer_id: 1,
  printer_name: 'P1S',
  profile_id: 10 + id,
  profile_name: profileName,
  expected_nozzle_diameter: 0.4,
  tool_index: id - 1,
  default_process_profile_id: null,
  default_filament_profile_id: null,
  enforcement_state: 'shadow',
  is_active: true,
  confirmed_at: null,
  readiness: { state: 'acknowledgement_required', reason_codes: ['default_unavailable'] },
  nozzle: { status: 'confirmed', diameter: 0.4, tool_index: id - 1 },
});
const emptyGroups = {
  selected_printer: [],
  other_installed_printers: [],
  unclassified: [],
  incompatible: [],
};
const statusWithNozzle = (diameter: string) => ({ nozzles: [{ nozzle_type: 'stainless_steel', nozzle_diameter: diameter }] }) as unknown as PrinterStatus;

function renderPanel(printers: Printer[], url = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter initialEntries={[url]}><QueryClientProvider client={client}><PrinterSlicerBindings printers={printers} /></QueryClientProvider></MemoryRouter>);
}

describe('PrinterSlicerBindings', () => {
  beforeEach(() => {
    auth.enabled = true;
    auth.update = true;
    vi.restoreAllMocks();
    vi.spyOn(api, 'listSlicerCatalogProfiles').mockResolvedValue([profile]);
    vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([]);
    vi.spyOn(api, 'getSlicerCatalogGroups').mockResolvedValue(emptyGroups);
    vi.spyOn(api, 'getSlicerCatalogBindingSuggestion').mockResolvedValue({ printer_id: 1, suggested_profile_ids: [10], requires_confirmation: true, readiness: 'acknowledgement_required' });
    vi.spyOn(api, 'getPrinterStatus').mockResolvedValue(statusWithNozzle('0.4'));
  });

  it('offers a P1S suggestion inline with its profile name', async () => {
    renderPanel([printer(1, 'P1S', 'P1S')]);
    expect(await screen.findByText('Suggested: P1S profile · 0.4 mm')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use suggestion' })).toBeInTheDocument();
  });

  it('requires explicit confirmation before a suggestion opens the create dialog', async () => {
    renderPanel([printer(1, 'P1S', 'P1S')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Use suggestion' }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Confirm suggested slicer binding/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and bind' }));
    expect(await screen.findByRole('heading', { name: 'Choose slicer profile' })).toBeInTheDocument();
  });

  it('keeps Tool index and rollout behind Advanced in the create dialog', async () => {
    renderPanel([printer(1, 'P1S', 'P1S')]);
    const chooseButton = await screen.findByRole('button', { name: 'Choose profile' });
    await waitFor(() => expect(chooseButton).toBeEnabled());
    fireEvent.click(chooseButton);

    expect(screen.getByRole('combobox', { name: 'Printer profile' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Nozzle' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Tool index' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Rollout' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('spinbutton', { name: 'Tool index' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Rollout' })).toBeInTheDocument();
  });

  it('prefills the create dialog nozzle from the printer reported nozzle', async () => {
    vi.spyOn(api, 'getPrinterStatus').mockResolvedValue(statusWithNozzle('0.6'));
    renderPanel([printer(1, 'P1S', 'P1S')]);
    expect(await screen.findByText('Suggested: P1S profile · 0.6 mm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose profile' }));
    expect(screen.getByRole('spinbutton', { name: 'Nozzle' })).toHaveValue(0.6);
  });

  it('shows the setup empty state with the printer name when nothing is bound', async () => {
    vi.spyOn(api, 'getSlicerCatalogBindingSuggestion').mockResolvedValue({ printer_id: 1, suggested_profile_ids: [], requires_confirmation: true, readiness: 'setup_required' });
    renderPanel([printer(1, 'P1S', 'P1S')]);
    expect(await screen.findByText('Not set up yet. Slicing for P1S is unavailable until a profile is chosen.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use suggestion' })).not.toBeInTheDocument();
  });

  it('asks for a catalog import instead of Choose profile when only other printers have profiles', async () => {
    vi.spyOn(api, 'listSlicerCatalogProfiles').mockResolvedValue([voronProfile]);
    vi.spyOn(api, 'getSlicerCatalogBindingSuggestion').mockResolvedValue({ printer_id: 1, suggested_profile_ids: [], requires_confirmation: true, readiness: 'setup_required' });
    renderPanel([printer(1, 'P1S', 'P1S')]);

    const message = await screen.findByText(/No P1S printer profile is in the catalog yet/);
    expect(message).toHaveTextContent('No P1S printer profile is in the catalog yet. Import one from Profiles, then choose it here.');
    expect(screen.getByRole('link', { name: 'Profiles' })).toHaveAttribute('href', '/profiles');
    expect(screen.queryByRole('button', { name: 'Choose profile' })).not.toBeInTheDocument();
  });

  it('keeps Choose profile when a catalog profile name matches the printer model', async () => {
    vi.spyOn(api, 'getSlicerCatalogBindingSuggestion').mockResolvedValue({ printer_id: 1, suggested_profile_ids: [], requires_confirmation: true, readiness: 'setup_required' });
    renderPanel([printer(1, 'P1S', 'P1S')]);

    await screen.findByText('Not set up yet. Slicing for P1S is unavailable until a profile is chosen.');
    expect(screen.getByRole('button', { name: 'Choose profile' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Profiles' })).not.toBeInTheDocument();
  });

  it('keeps Choose profile when a catalog profile metadata model matches the printer model', async () => {
    vi.spyOn(api, 'listSlicerCatalogProfiles').mockResolvedValue([voronProfile, p1sMetadataProfile]);
    vi.spyOn(api, 'getSlicerCatalogBindingSuggestion').mockResolvedValue({ printer_id: 1, suggested_profile_ids: [], requires_confirmation: true, readiness: 'setup_required' });
    renderPanel([printer(1, 'P1S', 'P1S')]);

    await screen.findByText('Not set up yet. Slicing for P1S is unavailable until a profile is chosen.');
    expect(screen.getByRole('button', { name: 'Choose profile' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Profiles' })).not.toBeInTheDocument();
  });

  it('lands a setup link on the selected printer binding card', async () => {
    renderPanel([printer(1, 'P1S', 'P1S'), printer(2, 'Voron', null, 'moonraker')], '/#slicer-binding-1');
    expect(await screen.findAllByRole('button', { name: 'Choose profile' })).toHaveLength(2);
    expect(document.getElementById('slicer-binding-1')).toHaveTextContent('P1S');
  });

  it('shows Setup required for an unbound Moonraker printer with no model', async () => {
    renderPanel([printer(2, 'Voron', null, 'moonraker')]);
    expect((await screen.findAllByText(/Setup required/)).length).toBeGreaterThan(0);
  });

  it('renders every exact binding and still allows another', async () => {
    vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([
      binding(1, 'P1S 0.4 profile'),
      binding(2, 'P1S 0.6 profile'),
    ]);
    renderPanel([printer(1, 'P1S', 'P1S')]);

    expect(await screen.findByTestId('binding-1')).toHaveTextContent('P1S 0.4 profile');
    expect(screen.getByTestId('binding-2')).toHaveTextContent('P1S 0.6 profile');
    fireEvent.click(screen.getByRole('button', { name: 'Choose profile' }));
    expect(screen.getByRole('heading', { name: 'Choose slicer profile' })).toBeInTheDocument();
  });

  it.each(['blocked', 'ready'] as const)('keeps an unknown readiness reason unverified when the server state is %s', async (state) => {
    vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([{
      ...binding(1, 'Voron 0.4 profile'),
      readiness: { state, reason_codes: ['future_backend_reason'] },
    }]);
    renderPanel([printer(1, 'Voron', null, 'moonraker')]);
    const card = await screen.findByTestId('binding-1');
    await waitFor(() => expect(card).toHaveTextContent('Readiness could not be verified. Reload the profiles and check the printer binding.'));
    expect(card).not.toHaveTextContent('future_backend_reason');
    expect(card).not.toHaveTextContent('Ready to slice');
    expect(card).not.toHaveTextContent('Checks passed.');
    expect(card.querySelector('.text-green-400')).toBeNull();
  });

  it('shows passed checks for a known ready nozzle match', async () => {
    vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([{
      ...binding(1, 'Voron 0.4 profile'),
      readiness: { state: 'ready', reason_codes: ['nozzle_match'] },
    }]);
    renderPanel([printer(1, 'Voron', null, 'moonraker')]);
    const card = await screen.findByTestId('binding-1');
    await waitFor(() => expect(card).toHaveTextContent('Checks passed.'));
    expect(card).toHaveTextContent('Reported nozzle matches this printer profile.');
  });

  it('keeps configured defaults visible when they are no longer compatible', async () => {
    const classification = (profileId: number, profileType: 'process' | 'filament'): SlicerCatalogClassification => ({
      profile_id: profileId,
      revision_id: profileId,
      profile_type: profileType,
      display_name: `${profileType} ${profileId}`,
      source: 'local',
      account_id: 1,
      account_name: null,
      stale: false,
      classification: {
        group: 'selected_printer',
        compatibility: 'match',
        readiness: 'ready',
        reason_codes: [],
        reason_details: [],
        selectable: true,
        auto_selectable: true,
        acknowledgement_required: false,
      },
    });
    vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([{
      ...binding(1, 'P1S 0.4 profile'),
      default_process_profile_id: 31,
      default_filament_profile_id: 41,
    }]);
    vi.spyOn(api, 'getSlicerCatalogGroups').mockResolvedValue({
      ...emptyGroups,
      selected_printer: [classification(30, 'process'), classification(40, 'filament')],
    });

    renderPanel([printer(1, 'P1S', 'P1S')]);

    expect(await screen.findByRole('option', { name: 'Unavailable profile #31' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Unavailable profile #41' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Process default/ })).toHaveValue('31');
    expect(screen.getByRole('combobox', { name: /Filament default/ })).toHaveValue('41');
  });

  it('surfaces create errors without hiding other printers', async () => {
    vi.spyOn(api, 'createSlicerCatalogBinding').mockRejectedValue(new Error('Exact binding already exists'));
    renderPanel([printer(1, 'P1S', 'P1S'), printer(2, 'Ready', 'P1S')]);

    const chooseButtons = await screen.findAllByRole('button', { name: 'Choose profile' });
    await waitFor(() => expect(chooseButtons[0]).toBeEnabled());
    fireEvent.click(chooseButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Exact binding already exists');
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('disables mutation controls without PRINTERS_UPDATE', async () => {
    auth.update = false;
    renderPanel([printer(1, 'P1S', 'P1S')]);
    expect(await screen.findByText(/Binding changes require PRINTERS_UPDATE/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose profile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use suggestion' })).not.toBeInTheDocument();
  });

  it('keeps one printer readable when another binding request fails', async () => {
    vi.spyOn(api, 'listSlicerCatalogBindings').mockImplementation(async (id) => {
      if (id === 1) throw new Error('offline');
      return [];
    });
    renderPanel([printer(1, 'Offline', 'P1S'), printer(2, 'Ready', 'P1S')]);
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
