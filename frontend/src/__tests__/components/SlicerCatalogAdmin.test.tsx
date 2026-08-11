import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlicerCatalogAdmin } from '../../components/SlicerCatalogAdmin';

const auth = vi.hoisted(() => ({ permissions: new Set<string>() }));
const api = vi.hoisted(() => ({
  listSlicerCatalogProfiles: vi.fn(), listSlicerCatalogProfileRevisions: vi.fn(), listSlicerCatalogAccounts: vi.fn(), listSlicerCatalogReviews: vi.fn(),
  listSlicerCatalogBindings: vi.fn(), listSlicerCompatibilityMappings: vi.fn(), getPrinters: vi.fn(),
  syncStandardCatalog: vi.fn(), syncCloudCatalog: vi.fn(), syncOrcaCatalog: vi.fn(), setSlicerCatalogSharing: vi.fn(),
  reviewSlicerCatalogBatch: vi.fn(), activateSlicerCatalogRevision: vi.fn(), rollbackSlicerCatalogRevision: vi.fn(),
  retireSlicerCatalogProfile: vi.fn(),
  freezeSlicerCatalogAccount: vi.fn(), resumeSlicerCatalogAccount: vi.fn(), createSlicerCompatibilityMapping: vi.fn(), deleteSlicerCompatibilityMapping: vi.fn(),
}));

vi.mock('../../api/client', () => ({ api }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ authEnabled: true, hasPermission: (permission: string) => auth.permissions.has(permission) }) }));

function renderAdmin() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><SlicerCatalogAdmin /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.permissions.clear();
  api.listSlicerCatalogAccounts.mockResolvedValue([{ id: 1, source: 'cloud', remote_account_id: 'cloud-1', display_name: 'Owner', sharing_state: 'private', consent_at: null, sync_cursor: null, last_sync_at: null, last_successful_sync_at: 'today', last_sync_error: null }]);
  api.listSlicerCatalogProfiles.mockResolvedValue([{ profile_id: 7, revision_id: 4, latest_revision_id: 4, active_revision_id: 3, active: true, review_state: 'approved', source: 'cloud', account_id: 1, account_name: 'Owner', remote_profile_id: 'p7', profile_type: 'printer', display_name: 'Printer profile', content_hash: 'hash-four', compatibility_metadata: { nozzle: '0.4mm' }, tombstoned: true, stale: true, sharing_state: 'private' }]);
  api.listSlicerCatalogProfileRevisions.mockResolvedValue([
    { id: 2, content_hash: 'hash-two', review_state: 'approved', created_at: 'yesterday', active: false },
    { id: 3, content_hash: 'hash-three', review_state: 'approved', created_at: 'today', active: true },
    { id: 4, content_hash: 'hash-four', review_state: 'approved', created_at: 'tomorrow', active: false },
  ]);
  api.listSlicerCatalogReviews.mockResolvedValue([{ id: 9, status: 'pending', summary: { profiles: 1 }, revisions: [{ id: 4, profile_id: 7, display_name: 'Printer profile' }], sync_cursor_before: null, sync_cursor_after: null, reviewed_at: null, created_at: 'today' }]);
  api.listSlicerCompatibilityMappings.mockResolvedValue([]);
  api.getPrinters.mockResolvedValue([{ id: 4, name: 'Physical', provider: 'bambu' }]);
  vi.clearAllMocks();
});

describe('SlicerCatalogAdmin', () => {
  it('requires explicit consent before sharing', async () => {
    auth.permissions.add('cloud:auth');
    renderAdmin();
    const share = await screen.findByRole('checkbox', { name: 'Share' });
    fireEvent.click(share);
    expect(await screen.findByText('Share catalog account?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm sharing' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('I consent to sharing this account.'));
    expect(screen.getByRole('button', { name: 'Confirm sharing' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm sharing' }));
    await waitFor(() => expect(api.setSlicerCatalogSharing).toHaveBeenCalledWith(1, true));
  });

  it('disables lifecycle mutations for a normal user', async () => {
    renderAdmin();
    expect(await screen.findByRole('button', { name: 'Activate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Rollback' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Freeze' })).toBeDisabled();
    expect(await screen.findByRole('button', { name: 'Approve selected' })).toBeDisabled();
  });

  it('targets exact pending and historical revisions', async () => {
    auth.permissions.add('settings:update');
    api.activateSlicerCatalogRevision.mockResolvedValue({ profile_id: 7, revision_id: 4 });
    api.rollbackSlicerCatalogRevision.mockResolvedValue({ profile_id: 7, revision_id: 2 });
    renderAdmin();

    fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(api.activateSlicerCatalogRevision).toHaveBeenCalledWith(7, 4));
    fireEvent.click(screen.getByRole('button', { name: 'Rollback' }));
    await waitFor(() => expect(api.rollbackSlicerCatalogRevision).toHaveBeenCalledWith(7, 2));
  });

  it('requires permission and confirmation before retiring a profile', async () => {
    api.listSlicerCatalogProfiles.mockResolvedValue([{ profile_id: 7, revision_id: 4, latest_revision_id: 4, active_revision_id: 3, active: true, review_state: 'approved', source: 'cloud', account_id: 1, account_name: 'Owner', remote_profile_id: 'p7', profile_type: 'printer', display_name: 'Printer profile', content_hash: 'hash-four', compatibility_metadata: {}, tombstoned: false, stale: false, sharing_state: 'private' }]);
    const unprivileged = renderAdmin();
    expect(await screen.findByRole('button', { name: 'Retire' })).toBeDisabled();
    unprivileged.unmount();

    auth.permissions.add('settings:update');
    api.retireSlicerCatalogProfile.mockResolvedValue({ profile_id: 7, replacement_profile_id: null, disabled_binding_ids: [2], retired: true });
    renderAdmin();
    fireEvent.click(await screen.findByRole('button', { name: 'Retire' }));
    expect(await screen.findByRole('dialog', { name: 'Retire Printer profile?' })).toBeInTheDocument();
    expect(api.retireSlicerCatalogProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Retire profile' }));
    await waitFor(() => expect(api.retireSlicerCatalogProfile).toHaveBeenCalledWith(7, { disableReferences: true }));
  });

  it('selects revisions before approving and can reject the whole batch', async () => {
    auth.permissions.add('settings:update');
    api.reviewSlicerCatalogBatch.mockResolvedValue({ id: 9, status: 'approved' });
    renderAdmin();
    const approve = await screen.findByRole('button', { name: 'Approve selected' });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Printer profile' }));
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(api.reviewSlicerCatalogBatch).toHaveBeenCalledWith(9, true, [4]));
  });

  it('renders frozen accounts with a resume action', async () => {
    api.listSlicerCatalogAccounts.mockResolvedValue([{ id: 1, source: 'cloud', remote_account_id: 'cloud-1', display_name: 'Owner', sharing_state: 'private', sync_frozen: true, consent_at: null, sync_cursor: null, last_sync_at: null, last_successful_sync_at: 'today', last_sync_error: null }]);
    auth.permissions.add('settings:update');
    api.resumeSlicerCatalogAccount.mockResolvedValue({ id: 1, stale: false });
    renderAdmin();
    expect(await screen.findByText('frozen')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.resumeSlicerCatalogAccount).toHaveBeenCalledWith(1));
  });

  it('loads one catalog profile page at a time', async () => {
    const profiles = Array.from({ length: 27 }, (_, index) => ({
      profile_id: index + 1,
      revision_id: index + 1,
      latest_revision_id: index + 1,
      active_revision_id: index + 1,
      active: true,
      review_state: 'approved',
      source: 'standard',
      account_id: 1,
      account_name: 'Standard',
      remote_profile_id: `profile-${index + 1}`,
      profile_type: 'process',
      display_name: `Profile ${index + 1}`,
      content_hash: `hash-${index + 1}`,
      compatibility_metadata: {},
      tombstoned: false,
      stale: false,
      sharing_state: 'shared',
    }));
    api.listSlicerCatalogProfiles.mockImplementation((options: { offset?: number; limit?: number } = {}) => {
      const { offset = 0, limit } = options;
      return Promise.resolve(profiles.slice(offset, limit === undefined ? undefined : offset + limit));
    });
    api.listSlicerCatalogProfileRevisions.mockResolvedValue([]);

    renderAdmin();

    expect(await screen.findByRole('article', { name: 'Profile 1' })).toBeInTheDocument();
    await waitFor(() => expect(api.listSlicerCatalogProfiles).toHaveBeenCalledWith({ includeInactive: true, limit: 26, offset: 0 }));
    await waitFor(() => expect(api.listSlicerCatalogProfileRevisions).toHaveBeenCalledTimes(25));
    expect(screen.queryByRole('article', { name: 'Profile 26' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByRole('article', { name: 'Profile 26' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Profile 27' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Profile 1' })).not.toBeInTheDocument();
    expect(api.listSlicerCatalogProfiles).toHaveBeenLastCalledWith({ includeInactive: true, limit: 26, offset: 25 });
  });

  it('collapses catalog sections', async () => {
    renderAdmin();
    const section = await screen.findByRole('button', { name: 'Catalog profiles' });
    expect(section).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('article', { name: 'Printer profile' })).toBeInTheDocument();

    fireEvent.click(section);

    expect(section).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('article', { name: 'Printer profile' })).not.toBeInTheDocument();
  });

  it('shows stale and tombstoned profiles', async () => {
    renderAdmin();
    expect(await screen.findByText('stale')).toBeInTheDocument();
    expect(screen.getByText('tombstone')).toBeInTheDocument();
    expect(screen.getByText('nozzle: 0.4mm')).toBeInTheDocument();
  });
});
