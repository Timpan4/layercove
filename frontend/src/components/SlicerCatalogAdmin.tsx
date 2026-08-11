import { useState, useEffect } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type Printer,
  type SlicerCatalogAccount,
  type SlicerCatalogProfile,
  type SlicerCatalogRevision,
} from '../api/client';
import { Button } from './Button';
import { Card, CardContent } from './Card';
import { Collapsible } from './Collapsible';
import { useAuth } from '../contexts/AuthContext';

const disabledTitle = 'Requires SETTINGS_UPDATE permission';
const PROFILE_PAGE_SIZE = 25;

export function SlicerCatalogAdmin() {
  const { hasPermission, authEnabled } = useAuth();
  const queryClient = useQueryClient();
  const canUpdate = !authEnabled || hasPermission('settings:update');
  const canCloud = !authEnabled || hasPermission('cloud:auth');
  const canOrca = !authEnabled || hasPermission('orca_cloud:auth');
  const [consentAccount, setConsentAccount] = useState<SlicerCatalogAccount | null>(null);
  const [retireProfile, setRetireProfile] = useState<SlicerCatalogProfile | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<number>();
  const [selectedRevisions, setSelectedRevisions] = useState<Record<number, number[]>>({});
  const [profileId, setProfileId] = useState('');
  const [printerId, setPrinterId] = useState('');
  const [profileOffset, setProfileOffset] = useState(0);

  const profiles = useQuery({
    queryKey: ['slicerCatalogProfiles', 'management', profileOffset],
    queryFn: () => api.listSlicerCatalogProfiles({
      includeInactive: true,
      limit: PROFILE_PAGE_SIZE + 1,
      offset: profileOffset,
    }),
  });
  const visibleProfiles = (profiles.data ?? []).slice(0, PROFILE_PAGE_SIZE);
  const hasNextProfilePage = (profiles.data?.length ?? 0) > PROFILE_PAGE_SIZE;
  const mappingProfiles = useQuery({
    queryKey: ['slicerCatalogProfiles', 'mapping'],
    queryFn: () => api.listSlicerCatalogProfiles(),
  });
  const revisionQueries = useQueries({
    queries: visibleProfiles.map((profile) => ({
      queryKey: ['slicerCatalogProfileRevisions', profile.profile_id],
      queryFn: () => api.listSlicerCatalogProfileRevisions(profile.profile_id),
    })),
  });
  const accounts = useQuery({ queryKey: ['slicerCatalogAccounts'], queryFn: api.listSlicerCatalogAccounts });
  const printers = useQuery<Printer[]>({ queryKey: ['printers'], queryFn: api.getPrinters });
  const mappings = useQuery({ queryKey: ['slicerCatalogMappings'], queryFn: api.listSlicerCompatibilityMappings });
  const reviews = useQuery({
    queryKey: ['slicerCatalogReviews', selectedAccount],
    queryFn: () => api.listSlicerCatalogReviews(selectedAccount!),
    enabled: selectedAccount !== undefined,
  });
  useEffect(() => {
    if (selectedAccount === undefined && accounts.data?.[0]) setSelectedAccount(accounts.data[0].id);
  }, [accounts.data, selectedAccount]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['slicerCatalog'] });
    queryClient.invalidateQueries({ queryKey: ['slicerCatalogProfiles'] });
    queryClient.invalidateQueries({ queryKey: ['slicerCatalogProfileRevisions'] });
    queryClient.invalidateQueries({ queryKey: ['slicerCatalogAccounts'] });
    queryClient.invalidateQueries({ queryKey: ['slicerCatalogMappings'] });
    if (selectedAccount !== undefined) queryClient.invalidateQueries({ queryKey: ['slicerCatalogReviews', selectedAccount] });
  };
  const sync = useMutation({ mutationFn: api.syncStandardCatalog, onSuccess: refresh });
  const syncCloud = useMutation({ mutationFn: api.syncCloudCatalog, onSuccess: refresh });
  const syncOrca = useMutation({ mutationFn: api.syncOrcaCatalog, onSuccess: refresh });
  const share = useMutation({
    mutationFn: () => api.setSlicerCatalogSharing(consentAccount!.id, true),
    onSuccess: () => { setConsentAccount(null); setConsentChecked(false); refresh(); },
  });
  const unshare = useMutation({
    mutationFn: (accountId: number) => api.setSlicerCatalogSharing(accountId, false),
    onSuccess: refresh,
  });
  const review = useMutation({ mutationFn: ({ id, approved, revisionIds }: { id: number; approved: boolean; revisionIds?: number[] }) => api.reviewSlicerCatalogBatch(id, approved, revisionIds), onSuccess: refresh });
  const lifecycle = useMutation({ mutationFn: ({ profile, revision, rollback }: { profile: number; revision: number; rollback?: boolean }) => rollback ? api.rollbackSlicerCatalogRevision(profile, revision) : api.activateSlicerCatalogRevision(profile, revision), onSuccess: refresh });
  const retire = useMutation({
    mutationFn: (profile: SlicerCatalogProfile) => api.retireSlicerCatalogProfile(
      profile.profile_id,
      { disableReferences: true },
    ),
    onSuccess: () => { setRetireProfile(null); refresh(); },
  });
  const freeze = useMutation({ mutationFn: (id: number) => api.freezeSlicerCatalogAccount(id), onSuccess: refresh });
  const resume = useMutation({ mutationFn: (id: number) => api.resumeSlicerCatalogAccount(id), onSuccess: refresh });
  const createMapping = useMutation({ mutationFn: () => api.createSlicerCompatibilityMapping(Number(profileId), Number(printerId)), onSuccess: () => { setProfileId(''); refresh(); } });
  const deleteMapping = useMutation({ mutationFn: (id: number) => api.deleteSlicerCompatibilityMapping(id), onSuccess: refresh });

  const syncButton = (label: string, mutation: typeof sync, enabled: boolean) => (
    <Button size="sm" variant="secondary" onClick={() => mutation.mutate()} disabled={!enabled || mutation.isPending} title={!enabled ? 'Requires cloud authentication permission' : undefined}>{label}</Button>
  );
  const updateTitle = canUpdate ? undefined : disabledTitle;
  const canShareAccount = (account: SlicerCatalogAccount) =>
    account.source === 'orca_cloud' ? canOrca : account.source === 'cloud' ? canCloud : false;

  return <div className="space-y-6" aria-label="Shared Profiles catalog administration">
    <Card><CardContent><Collapsible defaultOpen summary={<h2 className="text-lg font-semibold text-white">Shared Profiles catalog</h2>}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4"><p className="text-sm text-bambu-gray">Accounts, health, revisions, and compatibility.</p><div className="flex gap-2">{syncButton('Sync standard', sync, canUpdate)}{syncButton('Sync cloud', syncCloud, canCloud)}{syncButton('Sync Orca', syncOrca, canOrca)}</div></div>
      <div className="space-y-3">{(accounts.data || []).map(account => <div key={account.id} className="rounded-lg border border-bambu-dark-tertiary p-3">
        <div className="flex flex-wrap items-center gap-2"><strong className="text-white">{account.display_name || account.remote_account_id}</strong><span className="text-xs text-bambu-gray">{account.source} · {account.sharing_state}</span><span className={`text-xs ${account.last_sync_error ? 'text-red-400' : 'text-bambu-gray'}`}>{account.last_sync_error || (account.last_successful_sync_at ? `healthy · ${account.last_successful_sync_at}` : 'not synced')}</span><span className="text-xs text-bambu-gray">{account.sync_frozen && 'frozen'}</span><span className="ml-auto flex gap-2"><label className="flex items-center gap-1 text-sm text-bambu-gray"><input type="checkbox" checked={account.sharing_state === 'shared'} disabled={!canShareAccount(account)} onChange={() => { setSelectedAccount(account.id); if (account.sharing_state === 'shared') { unshare.mutate(account.id); } else { setConsentAccount(account); setConsentChecked(false); } }} /> Share</label><Button size="sm" variant="secondary" disabled={!canUpdate} title={updateTitle} onClick={() => { setSelectedAccount(account.id); (account.sync_frozen ? resume : freeze).mutate(account.id); }}>{account.sync_frozen ? 'Resume' : 'Freeze'}</Button></span></div>
        <p className="mt-2 text-xs text-bambu-gray">Consent: {account.consent_at || 'none'} · Cursor: {account.sync_cursor || 'none'}</p>
      </div>)}</div>
    </Collapsible></CardContent></Card>

    <Card><CardContent><Collapsible defaultOpen summary={<h3 className="text-base font-semibold text-white">Catalog profiles</h3>}>
      <div className="space-y-2">{visibleProfiles.map((profile, index) => <ProfileRow key={profile.profile_id} profile={profile} revisions={revisionQueries[index]?.data ?? []} revisionsLoading={revisionQueries[index]?.isLoading ?? false} canUpdate={canUpdate} updateTitle={updateTitle} onLifecycle={(revision, rollback) => lifecycle.mutate({ profile: profile.profile_id, revision, rollback })} onRetire={() => { retire.reset(); setRetireProfile(profile); }} />)}</div>
      {(profileOffset > 0 || hasNextProfilePage) && <div className="mt-4 flex items-center justify-between gap-3"><Button size="sm" variant="secondary" disabled={profileOffset === 0} onClick={() => setProfileOffset(Math.max(0, profileOffset - PROFILE_PAGE_SIZE))}>Previous</Button><span className="text-sm text-bambu-gray">Page {Math.floor(profileOffset / PROFILE_PAGE_SIZE) + 1}</span><Button size="sm" variant="secondary" disabled={!hasNextProfilePage} onClick={() => setProfileOffset(profileOffset + PROFILE_PAGE_SIZE)}>Next</Button></div>}
    </Collapsible></CardContent></Card>

    <Card><CardContent><Collapsible defaultOpen summary={<h3 className="text-base font-semibold text-white">Pending review batches</h3>}>
      <div className="flex justify-end mb-3"><select aria-label="Review account" className="bg-bambu-dark text-white border border-bambu-dark-tertiary rounded px-2 py-1" value={selectedAccount ?? ''} onChange={e => setSelectedAccount(e.target.value ? Number(e.target.value) : undefined)}><option value="">Select account</option>{(accounts.data || []).map(a => <option key={a.id} value={a.id}>{a.display_name || a.remote_account_id}</option>)}</select></div>{(reviews.data || []).filter(r => r.status === 'pending').map(batch => { const selected = selectedRevisions[batch.id] || []; return <div key={batch.id} className="flex flex-wrap items-center gap-2 text-sm text-white py-2"><span>Batch {batch.id} · {batch.summary?.profiles || 0} profiles</span><div className="flex flex-wrap gap-2">{batch.revisions.map(revision => <label key={revision.id} className="flex items-center gap-1"><input type="checkbox" aria-label={revision.display_name} checked={selected.includes(revision.id)} onChange={e => setSelectedRevisions(current => ({ ...current, [batch.id]: e.target.checked ? [...selected, revision.id] : selected.filter(id => id !== revision.id) }))} /> {revision.display_name}</label>)}</div><Button size="sm" disabled={!canUpdate || selected.length === 0} title={updateTitle} onClick={() => review.mutate({ id: batch.id, approved: true, revisionIds: selected })}>Approve selected</Button><Button size="sm" variant="danger" disabled={!canUpdate} title={updateTitle} onClick={() => review.mutate({ id: batch.id, approved: false })}>Reject</Button></div>; })}
    </Collapsible></CardContent></Card>

    <Card><CardContent><Collapsible defaultOpen summary={<h3 className="text-base font-semibold text-white">Compatibility mappings</h3>}>
      <div className="flex flex-wrap gap-2 mb-3"><select aria-label="Catalog profile" value={profileId} onChange={e => setProfileId(e.target.value)} className="bg-bambu-dark text-white border border-bambu-dark-tertiary rounded px-2 py-1"><option value="">Profile</option>{(mappingProfiles.data || []).filter(p => !p.tombstoned).map(p => <option key={p.profile_id} value={p.profile_id}>{p.display_name}</option>)}</select><select aria-label="Physical printer" value={printerId} onChange={e => setPrinterId(e.target.value)} className="bg-bambu-dark text-white border border-bambu-dark-tertiary rounded px-2 py-1"><option value="">Printer</option>{(printers.data || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><Button size="sm" disabled={!canUpdate || !profileId || !printerId} title={updateTitle} onClick={() => createMapping.mutate()}>Create mapping</Button></div>{(mappings.data || []).map(mapping => <div key={mapping.id} className="flex items-center gap-2 text-sm text-white py-1"><span>Profile {mapping.profile_id} → Printer {mapping.printer_id}</span><Button size="sm" variant="danger" disabled={!canUpdate} title={updateTitle} onClick={() => deleteMapping.mutate(mapping.id)}>Delete</Button></div>)}
    </Collapsible></CardContent></Card>

    {consentAccount && <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"><Card className="max-w-md"><CardContent><h3 className="text-lg font-semibold text-white">Share catalog account?</h3><p className="text-sm text-bambu-gray my-3">Sharing sends this account's catalog profiles to other authorized users.</p><label className="flex gap-2 text-sm text-white"><input type="checkbox" checked={consentChecked} onChange={e => setConsentChecked(e.target.checked)} /> I consent to sharing this account.</label><div className="flex gap-2 mt-4"><Button variant="secondary" onClick={() => setConsentAccount(null)}>Cancel</Button><Button disabled={!consentChecked || share.isPending} onClick={() => share.mutate()}>Confirm sharing</Button></div></CardContent></Card></div>}
    {retireProfile && <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="retire-profile-title"><Card className="max-w-md"><CardContent><h3 id="retire-profile-title" className="text-lg font-semibold text-white">Retire {retireProfile.display_name}?</h3><p className="text-sm text-bambu-gray my-3">This tombstones the profile and disables bindings, defaults, rules, and preferences that still reference it. Historical jobs retain exact revisions.</p>{retire.error && <p className="mb-3 text-sm text-red-400" role="alert">{retire.error instanceof Error ? retire.error.message : 'Unable to retire profile'}</p>}<div className="flex gap-2"><Button variant="secondary" disabled={retire.isPending} onClick={() => setRetireProfile(null)}>Cancel</Button><Button variant="danger" disabled={retire.isPending} onClick={() => retire.mutate(retireProfile)}>Retire profile</Button></div></CardContent></Card></div>}
  </div>;
}

function ProfileRow({
  profile,
  revisions,
  revisionsLoading,
  canUpdate,
  updateTitle,
  onLifecycle,
  onRetire,
}: {
  profile: SlicerCatalogProfile;
  revisions: SlicerCatalogRevision[];
  revisionsLoading: boolean;
  canUpdate: boolean;
  updateTitle?: string;
  onLifecycle: (revisionId: number, rollback: boolean) => void;
  onRetire: () => void;
}) {
  const compatibility = Object.entries(profile.compatibility_metadata || {})
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ');
  const activeRevisionId = profile.active_revision_id ?? revisions.find((revision) => revision.active)?.id ?? null;

  return <article aria-label={profile.display_name} className="rounded border border-bambu-dark-tertiary p-2 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-white font-medium">{profile.display_name}</span>
      <span className="text-bambu-gray">{profile.source} · {profile.account_name || profile.account_id}</span>
      {compatibility && <span className="text-bambu-gray">{compatibility}</span>}
      <span className={profile.stale ? 'text-amber-400' : 'text-green-400'}>{profile.stale ? 'stale' : 'current'}</span>
      {profile.tombstoned && <span className="text-red-400">tombstone</span>}
      {!activeRevisionId && <span className="text-amber-400">not active</span>}
      {!profile.tombstoned && <Button className="ml-auto" size="sm" variant="danger" disabled={!canUpdate} title={updateTitle} onClick={onRetire}>Retire</Button>}
    </div>
    <div className="mt-2 space-y-1">
      {revisionsLoading && <p className="text-bambu-gray">Loading revisions…</p>}
      {revisions.map((revision) => {
        const rollback = activeRevisionId !== null && revision.id < activeRevisionId;
        const canActivate = revision.review_state === 'approved' && !revision.active;
        return <div key={revision.id} className="flex flex-wrap items-center gap-2 rounded bg-bambu-dark px-2 py-1">
          <span className="text-white">Revision {revision.id}</span>
          <span className="text-bambu-gray">{revision.review_state} · {revision.content_hash.slice(0, 12)}</span>
          {revision.active && <span className="text-green-400">active</span>}
          {canActivate && <Button className="ml-auto" size="sm" variant={rollback ? 'secondary' : 'primary'} disabled={!canUpdate} title={updateTitle} onClick={() => onLifecycle(revision.id, rollback)}>{rollback ? 'Rollback' : 'Activate'}</Button>}
        </div>;
      })}
    </div>
  </article>;
}
