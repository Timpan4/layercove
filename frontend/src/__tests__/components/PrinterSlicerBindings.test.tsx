import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrinterSlicerBindings } from '../../components/PrinterSlicerBindings';
import { api, type Printer, type SlicerCatalogBinding, type SlicerCatalogClassification } from '../../api/client';

const auth = vi.hoisted(() => ({ enabled: true, update: true }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ authEnabled: auth.enabled, hasPermission: (permission: string) => permission === 'printers:update' && auth.update }),
}));
vi.mock('../../components/ConfirmModal', () => ({
  ConfirmModal: ({ title, message, onConfirm, onCancel }: { title: string; message: string; onConfirm: () => void; onCancel: () => void }) => <div role="dialog"><h2>{title}</h2><p>{message}</p><button onClick={onConfirm}>Confirm and bind</button><button onClick={onCancel}>Cancel</button></div>,
}));

const printer = (id: number, name: string, model: string | null, provider: Printer['provider'] = 'bambu') => ({ id, name, model, provider, is_active: true } as Printer);
const profile = { profile_id: 10, revision_id: 1, source: 'local', account_id: 1, account_name: null, remote_profile_id: 'p', profile_type: 'printer', display_name: 'P1S profile', content_hash: 'hash', compatibility_metadata: {}, tombstoned: false, stale: false, sharing_state: 'private' } as const;
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

function renderPanel(printers: Printer[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><PrinterSlicerBindings printers={printers} /></QueryClientProvider>);
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
  });

  it('requires explicit confirmation for a P1S suggestion', async () => {
    renderPanel([printer(1, 'P1S', 'P1S')]);
    fireEvent.click(await screen.findByRole('button', { name: /Use suggested profile/i }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Confirm suggested slicer binding/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and bind' }));
    expect(await screen.findByRole('heading', { name: 'Create slicer binding' })).toBeInTheDocument();
  });

  it('shows setup_required for an unbound Moonraker printer with no model', async () => {
    renderPanel([printer(2, 'Voron', null, 'moonraker')]);
    expect((await screen.findAllByText(/setup_required/)).length).toBeGreaterThan(0);
  });

  it('renders every exact binding and still allows another', async () => {
    vi.spyOn(api, 'listSlicerCatalogBindings').mockResolvedValue([
      binding(1, 'P1S 0.4 profile'),
      binding(2, 'P1S 0.6 profile'),
    ]);
    renderPanel([printer(1, 'P1S', 'P1S')]);

    expect(await screen.findByTestId('binding-1')).toHaveTextContent('P1S 0.4 profile');
    expect(screen.getByTestId('binding-2')).toHaveTextContent('P1S 0.6 profile');
    fireEvent.click(screen.getByRole('button', { name: 'Add binding' }));
    expect(screen.getByRole('heading', { name: 'Create slicer binding' })).toBeInTheDocument();
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

    const addButtons = await screen.findAllByRole('button', { name: 'Add binding' });
    await waitFor(() => expect(addButtons[0]).toBeEnabled());
    fireEvent.click(addButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Bind' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Exact binding already exists');
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('disables mutation controls without PRINTERS_UPDATE', async () => {
    auth.update = false;
    renderPanel([printer(1, 'P1S', 'P1S')]);
    expect(await screen.findByText(/Binding changes require PRINTERS_UPDATE/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bind' })).not.toBeInTheDocument();
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
