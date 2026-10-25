import { useEffect, useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import {
  api,
  type Printer,
  type PrinterStatus,
  type SlicerCatalogBinding,
  type SlicerCatalogBindingInput,
  type SlicerCatalogClassification,
  type SlicerCatalogProfile,
  type UnifiedPreset,
} from '../api/client';
import { queryKeys } from '../api/queryKeys';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './Button';
import { Card, CardContent } from './Card';
import { ConfirmModal } from './ConfirmModal';
import { displayedSlicerReadiness, slicerReadinessReasons, slicerReadinessState } from '../utils/slicerReadiness';

const selectClass = 'rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-white';
const inputClass = `${selectClass} w-24`;
const DEFAULT_NOZZLE_MM = 0.4;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isP1S(printer: Printer) {
  return printer.provider === 'bambu' && /p1s/i.test(`${printer.model ?? ''} ${printer.name}`);
}

// `model` must be non-empty: an empty needle would match every profile.
function profileMatchesModel(profile: SlicerCatalogProfile, model: string) {
  const metadata = profile.compatibility_metadata;
  const metadataModel = metadata.model ?? metadata.printer_model;
  const needle = model.toLowerCase();
  return [profile.display_name, metadataModel].some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
  );
}

function reportedNozzle(status: PrinterStatus | undefined): number | null {
  const diameter = Number(status?.nozzles?.[0]?.nozzle_diameter);
  return Number.isFinite(diameter) && diameter > 0 ? diameter : null;
}

// Standard preset names carry their nozzle, e.g. "Bambu Lab P1S 0.4 nozzle".
function presetNozzle(name: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*nozzle/i.exec(name);
  return match ? Number(match[1]) : null;
}

// Prefers the printer's reported nozzle, then the 0.4 default, then any preset for the model.
function standardPresetFor(presets: UnifiedPreset[], model: string, nozzle: number) {
  const needle = model.toLowerCase();
  const matches = presets.filter((preset) => preset.name.toLowerCase().includes(needle));
  return matches.find((preset) => presetNozzle(preset.name) === nozzle)
    ?? matches.find((preset) => presetNozzle(preset.name) === DEFAULT_NOZZLE_MM)
    ?? matches[0];
}

// The standard library enters the catalog as pending review, and a preset is listed only once its
// revision is approved and activated. The sync has no filter, so the approved batch covers the whole
// library, while only the chosen preset is activated.
async function importStandardPreset(presetName: string) {
  await api.syncStandardCatalog();
  const match = (await api.listSlicerCatalogProfiles({ includeInactive: true, search: presetName })).find(
    (profile) =>
      profile.source === 'standard'
      && profile.profile_type === 'printer'
      && profile.display_name === presetName
      && !profile.tombstoned,
  );
  if (!match) throw new Error(`${presetName} is not in the standard library`);
  const pendingBatches = (await api.listSlicerCatalogReviews(match.account_id)).filter(
    (batch) => batch.status === 'pending' && batch.revisions.some((revision) => revision.profile_id === match.profile_id),
  );
  for (const batch of pendingBatches) {
    await api.reviewSlicerCatalogBatch(batch.id, true);
  }
  const approved = (await api.listSlicerCatalogProfileRevisions(match.profile_id))
    .filter((revision) => revision.review_state === 'approved')
    .sort((a, b) => b.id - a.id)[0];
  if (!approved) throw new Error(`${presetName} has no approved revision`);
  await api.activateSlicerCatalogRevision(match.profile_id, approved.id);
}

export function PrinterSlicerBindings({ printers }: { printers: Printer[] }) {
  const { t } = useTranslation();
  const location = useLocation();
  const { hasPermission, authEnabled } = useAuth();
  const queryClient = useQueryClient();
  const canUpdate = !authEnabled || hasPermission('printers:update');
  // The sync, review and activation endpoints that back the standard-library import require settings:update.
  const canImportStandard = canUpdate && (!authEnabled || hasPermission('settings:update'));
  const activePrinters = printers.filter((printer) => printer.is_active);
  useEffect(() => {
    const target = printers.find((printer) => printer.is_active && location.hash === `#slicer-binding-${printer.id}`);
    if (target) document.getElementById(`slicer-binding-${target.id}`)?.scrollIntoView?.();
  }, [printers, location.hash]);
  const [draft, setDraft] = useState<SlicerCatalogBindingInput | null>(null);
  const [suggestedDraft, setSuggestedDraft] = useState<SlicerCatalogBindingInput | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [importCandidate, setImportCandidate] = useState<{ printerId: number; presetName: string } | null>(null);

  const profiles = useQuery({
    queryKey: ['slicerCatalogProfiles'],
    queryFn: () => api.listSlicerCatalogProfiles(),
  });
  const bindingQueries = useQueries({
    queries: activePrinters.map((printer) => ({
      queryKey: ['slicerCatalogBindings', printer.id],
      queryFn: () => api.listSlicerCatalogBindings(printer.id),
    })),
  });
  const statusQueries = useQueries({
    queries: activePrinters.map((printer) => ({
      queryKey: queryKeys.printerStatus(printer.id),
      queryFn: () => api.getPrinterStatus(printer.id),
      staleTime: 30 * 1000,
    })),
  });
  const p1sPrinters = activePrinters.filter(isP1S);
  const suggestionQueries = useQueries({
    queries: p1sPrinters.map((printer) => ({
      queryKey: ['slicerCatalogSuggestion', printer.id],
      queryFn: () => api.getSlicerCatalogBindingSuggestion(printer.id),
    })),
  });
  const activeBindings = bindingQueries.flatMap((query) =>
    (query.data ?? []).filter((binding) => binding.is_active),
  );
  const classificationQueries = useQueries({
    queries: activeBindings.map((binding) => ({
      queryKey: ['slicerCatalogGroups', binding.printer_id, binding.id],
      queryFn: () => api.getSlicerCatalogGroups(binding.printer_id, binding.id),
    })),
  });
  const classifications = new Map(
    activeBindings.map((binding, index) => [binding.id, classificationQueries[index]]),
  );

  const refreshPrinter = (printerId: number) => {
    queryClient.invalidateQueries({ queryKey: ['slicerCatalogBindings'] });
    queryClient.invalidateQueries({ queryKey: ['slicerCatalogSuggestion', printerId] });
    queryClient.invalidateQueries({ queryKey: ['slicerCatalogGroups'] });
  };
  const create = useMutation({
    mutationFn: api.createSlicerCatalogBinding,
    onSuccess: (binding) => {
      setDraft(null);
      refreshPrinter(binding.printer_id);
    },
  });
  const update = useMutation({
    mutationFn: ({ bindingId, data }: { bindingId: number; data: Partial<SlicerCatalogBindingInput> }) =>
      api.updateSlicerCatalogBinding(bindingId, data),
    onSuccess: (binding) => refreshPrinter(binding.printer_id),
  });
  const disable = useMutation({
    mutationFn: ({ bindingId }: { bindingId: number; printerId: number }) =>
      api.disableSlicerCatalogBinding(bindingId),
    onSuccess: (_, variables) => refreshPrinter(variables.printerId),
  });
  const importStandard = useMutation({
    mutationFn: ({ presetName }: { printerId: number; presetName: string }) => importStandardPreset(presetName),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['slicerCatalogProfiles'] });
      queryClient.invalidateQueries({ queryKey: ['slicerCatalogSuggestion'] });
      queryClient.invalidateQueries({ queryKey: ['slicerCatalogBindings'] });
    },
  });

  const printerProfiles = (profiles.data ?? []).filter(
    (profile) => profile.profile_type === 'printer' && !profile.tombstoned,
  );
  const nozzleFor = (printerId: number) => {
    const index = activePrinters.findIndex((printer) => printer.id === printerId);
    return reportedNozzle(statusQueries[index]?.data) ?? DEFAULT_NOZZLE_MM;
  };
  const startDraft = (printerId: number, profileId = printerProfiles[0]?.profile_id ?? 0) => {
    setAdvancedOpen(false);
    setDraft({
      printer_id: printerId,
      profile_id: profileId,
      expected_nozzle_diameter: nozzleFor(printerId),
      tool_index: 0,
      enforcement_state: 'shadow',
    });
  };

  const suggestedProfileFor = (printer: Printer) => {
    const index = p1sPrinters.findIndex((item) => item.id === printer.id);
    const suggestion = index >= 0 ? suggestionQueries[index]?.data : undefined;
    return printerProfiles.find((profile) => profile.profile_id === suggestion?.suggested_profile_ids[0]);
  };
  const needsCatalogImport = (printer: Printer) => {
    const model = printer.model?.trim() ?? '';
    return profiles.isSuccess
      && printer.provider === 'bambu'
      && model !== ''
      && !suggestedProfileFor(printer)
      && !printerProfiles.some((profile) => profileMatchesModel(profile, model));
  };
  const standardPresetsNeeded = activePrinters.some(
    (printer, index) => needsCatalogImport(printer) && !(bindingQueries[index]?.data ?? []).some((binding) => binding.is_active),
  );
  const standardPresets = useQuery({
    queryKey: ['slicer-presets'],
    queryFn: () => api.getSlicerPresets(),
    enabled: standardPresetsNeeded && canImportStandard,
  });

  if (!activePrinters.length) return null;
  return (
    <Card>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-white">{t('printerSlicerBindings.title')}</h2>
            <p className="text-sm text-bambu-gray">{t('printerSlicerBindings.subtitle')}</p>
          </div>
          {!canUpdate && <span className="text-sm text-amber-400">{t('printerSlicerBindings.permissionRequired')}</span>}
        </div>

        <div className="space-y-4">
          {activePrinters.map((printer, printerIndex) => {
            const query = bindingQueries[printerIndex];
            const bindings = (query.data ?? []).filter((binding) => binding.is_active);
            const suggestedProfile = suggestedProfileFor(printer);
            const setupRequired = printer.provider === 'moonraker' && bindings.length === 0;
            const model = printer.model?.trim() ?? '';
            const importNeeded = needsCatalogImport(printer);
            const standardPreset = importNeeded && canImportStandard
              ? standardPresetFor(standardPresets.data?.standard.printer ?? [], model, nozzleFor(printer.id))
              : undefined;
            const pendingImport = importStandard.isPending && importStandard.variables?.printerId === printer.id
              ? importStandard.variables
              : null;
            const failedImport = importStandard.isError && importStandard.variables?.printerId === printer.id
              ? importStandard.variables
              : null;

            return (
              <section id={`slicer-binding-${printer.id}`} key={printer.id} className="scroll-mt-4 rounded-lg border border-bambu-dark-tertiary p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-white">{printer.name}</h3>
                  <span className="text-xs text-bambu-gray">
                    {printer.provider} · {printer.model || t('printerSlicerBindings.modelUnknown')}
                  </span>
                  {setupRequired && <span className="text-xs text-amber-400">{t('printerSlicerBindings.setupRequired')}</span>}
                  <div className="ml-auto flex gap-2">
                    {canUpdate && !importNeeded && (
                      <Button variant="secondary" size="sm" onClick={() => startDraft(printer.id)} disabled={!printerProfiles.length}>
                        {t('printerSlicerBindings.chooseProfile')}
                      </Button>
                    )}
                  </div>
                </div>

                {query.error && <p role="alert" className="mt-2 text-sm text-red-400">{errorMessage(query.error, t('printerSlicerBindings.requestFailed'))}</p>}
                {!query.isLoading && !query.error && bindings.length === 0 && importNeeded && (
                  <div className="mt-2 space-y-2 text-sm text-bambu-gray">
                    {standardPresets.isLoading && <p role="status">{t('printerSlicerBindings.checkingStandard')}</p>}
                    {!standardPresets.isLoading && standardPreset && (
                      <>
                        <Button
                          size="sm"
                          disabled={pendingImport !== null}
                          onClick={() => setImportCandidate({ printerId: printer.id, presetName: standardPreset.name })}
                        >
                          {t('printerSlicerBindings.addStandardPreset', { preset: standardPreset.name })}
                        </Button>
                        <p>
                          <Trans
                            i18nKey="printerSlicerBindings.importFromProfiles"
                            components={{ profiles: <Link to="/profiles" className="text-bambu-green hover:underline" /> }}
                          />
                        </p>
                      </>
                    )}
                    {!standardPresets.isLoading && !standardPreset && (
                      <p>
                        <Trans
                          i18nKey="printerSlicerBindings.importProfile"
                          values={{ model }}
                          components={{ profiles: <Link to="/profiles" className="text-bambu-green hover:underline" /> }}
                        />
                      </p>
                    )}
                    {pendingImport && (
                      <p role="status">{t('printerSlicerBindings.addingStandardPreset', { preset: pendingImport.presetName })}</p>
                    )}
                    {failedImport && (
                      <p role="alert">
                        {t('printerSlicerBindings.importFailed', {
                          detail: errorMessage(importStandard.error, t('printerSlicerBindings.requestFailed')),
                        })}
                        <Button className="ml-2" size="sm" variant="secondary" onClick={() => importStandard.mutate(failedImport)}>
                          {t('common.retry')}
                        </Button>
                      </p>
                    )}
                  </div>
                )}
                {!query.isLoading && !query.error && bindings.length === 0 && !importNeeded && (
                  <p className="mt-2 text-sm text-bambu-gray">{t('printerSlicerBindings.notSetUp', { printer: printer.name })}</p>
                )}
                {suggestedProfile && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-bambu-gray">
                      {t('printerSlicerBindings.suggestion', { profile: suggestedProfile.display_name, nozzle: nozzleFor(printer.id) })}
                    </span>
                    {canUpdate && (
                      <Button size="sm" onClick={() =>
                        setSuggestedDraft({
                          printer_id: printer.id,
                          profile_id: suggestedProfile.profile_id,
                          expected_nozzle_diameter: nozzleFor(printer.id),
                          tool_index: 0,
                          enforcement_state: 'shadow',
                        })
                      }>
                        {t('printerSlicerBindings.useSuggestion')}
                      </Button>
                    )}
                  </div>
                )}
                <div className="mt-3 space-y-3">
                  {bindings.map((binding) => (
                    <BindingEditor
                      key={binding.id}
                      binding={binding}
                      compatibleProfiles={classifications.get(binding.id)?.data?.selected_printer ?? []}
                      classificationsLoading={classifications.get(binding.id)?.isLoading ?? false}
                      canUpdate={canUpdate}
                      updatePending={update.isPending && update.variables?.bindingId === binding.id}
                      updateError={update.variables?.bindingId === binding.id ? update.error : null}
                      disablePending={disable.isPending && disable.variables?.bindingId === binding.id}
                      onUpdate={(data) => update.mutate({ bindingId: binding.id, data })}
                      onDisable={() => disable.mutate({ bindingId: binding.id, printerId: printer.id })}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        {draft && (
          <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
            <Card className="w-full max-w-lg">
              <CardContent>
                <h3 className="text-lg font-semibold text-white">{t('printerSlicerBindings.createTitle')}</h3>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-bambu-gray">
                    {t('printerSlicerBindings.printerProfile')}
                    <select
                      aria-label={t('printerSlicerBindings.printerProfile')}
                      className={`${selectClass} mt-1 w-full`}
                      value={draft.profile_id}
                      onChange={(event) => setDraft({ ...draft, profile_id: Number(event.target.value) })}
                    >
                      {printerProfiles.map((profile) => (
                        <option key={profile.profile_id} value={profile.profile_id}>{profile.display_name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm text-bambu-gray">
                    {t('printerSlicerBindings.nozzle')}
                    <input
                      aria-label={t('printerSlicerBindings.nozzle')}
                      className={`${inputClass} mt-1 block`}
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={draft.expected_nozzle_diameter}
                      onChange={(event) => setDraft({ ...draft, expected_nozzle_diameter: Number(event.target.value) })}
                    />
                  </label>
                </div>
                <Button
                  className="mt-4"
                  size="sm"
                  variant="secondary"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((open) => !open)}
                >
                  {t('printerSlicerBindings.advanced')}
                </Button>
                {advancedOpen && (
                  <div className="mt-3 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-sm text-bambu-gray">
                        {t('printerSlicerBindings.toolIndex')}
                        <input
                          aria-label={t('printerSlicerBindings.toolIndex')}
                          className={`${inputClass} mt-1 block`}
                          type="number"
                          min="0"
                          value={draft.tool_index ?? 0}
                          onChange={(event) => setDraft({ ...draft, tool_index: Number(event.target.value) })}
                        />
                      </label>
                      <label className="text-sm text-bambu-gray">
                        {t('printerSlicerBindings.rollout')}
                        <select
                          aria-label={t('printerSlicerBindings.rollout')}
                          className={`${selectClass} mt-1 block w-full`}
                          value={draft.enforcement_state ?? 'shadow'}
                          onChange={(event) => setDraft({ ...draft, enforcement_state: event.target.value as 'shadow' | 'enforced' })}
                        >
                          <option value="shadow">{t('printerSlicerBindings.rolloutShadow')}</option>
                          <option value="enforced">{t('printerSlicerBindings.rolloutEnforced')}</option>
                        </select>
                      </label>
                    </div>
                    <p className="text-xs text-bambu-gray">{t('printerSlicerBindings.rolloutShadowHelp')}</p>
                    <p className="text-xs text-bambu-gray">{t('printerSlicerBindings.rolloutEnforcedHelp')}</p>
                  </div>
                )}
                {create.error && <p role="alert" className="mt-3 text-sm text-red-400">{errorMessage(create.error, t('printerSlicerBindings.requestFailed'))}</p>}
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
                  <Button
                    onClick={() => create.mutate(draft)}
                    disabled={create.isPending || !draft.profile_id || draft.expected_nozzle_diameter <= 0}
                  >
                    {t('printerSlicerBindings.save')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {importCandidate && (
          <ConfirmModal
            title={t('printerSlicerBindings.confirmImportTitle', { preset: importCandidate.presetName })}
            message={t('printerSlicerBindings.confirmImportMessage', { preset: importCandidate.presetName })}
            confirmText={t('printerSlicerBindings.confirmImportAction')}
            onConfirm={() => {
              importStandard.mutate(importCandidate);
              setImportCandidate(null);
            }}
            onCancel={() => setImportCandidate(null)}
          />
        )}

        {suggestedDraft && (
          <ConfirmModal
            title={t('printerSlicerBindings.confirmTitle')}
            message={t('printerSlicerBindings.confirmMessage')}
            confirmText={t('printerSlicerBindings.confirmAction')}
            onConfirm={() => {
              setDraft(suggestedDraft);
              setSuggestedDraft(null);
            }}
            onCancel={() => setSuggestedDraft(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}

function BindingEditor({
  binding,
  compatibleProfiles,
  classificationsLoading,
  canUpdate,
  updatePending,
  updateError,
  disablePending,
  onUpdate,
  onDisable,
}: {
  binding: SlicerCatalogBinding;
  compatibleProfiles: SlicerCatalogClassification[];
  classificationsLoading: boolean;
  canUpdate: boolean;
  updatePending: boolean;
  updateError: unknown;
  disablePending: boolean;
  onUpdate: (data: Partial<SlicerCatalogBindingInput>) => void;
  onDisable: () => void;
}) {
  const { t } = useTranslation();
  const displayedReadiness = displayedSlicerReadiness(binding.readiness.state, binding.readiness.reason_codes);
  const readinessText = slicerReadinessState(t, displayedReadiness);
  const processProfiles = compatibleProfiles.filter((profile) => profile.profile_type === 'process');
  const filamentProfiles = compatibleProfiles.filter((profile) => profile.profile_type === 'filament');
  const missingProcessDefault = binding.default_process_profile_id != null
    && !processProfiles.some((profile) => profile.profile_id === binding.default_process_profile_id);
  const missingFilamentDefault = binding.default_filament_profile_id != null
    && !filamentProfiles.some((profile) => profile.profile_id === binding.default_filament_profile_id);

  return (
    <div className="rounded border border-bambu-dark-tertiary p-3" data-testid={`binding-${binding.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <strong className="text-white">{binding.profile_name}</strong>
        <span className="text-bambu-gray">
          {t('printerSlicerBindings.bindingSummary', { nozzle: binding.expected_nozzle_diameter, tool: binding.tool_index })}
        </span>
        <span className={displayedReadiness === 'ready' ? 'text-green-400' : 'text-amber-400'}>
          {readinessText}
        </span>
        {slicerReadinessReasons(t, binding.readiness.reason_codes).filter((reason) => reason !== readinessText).map((reason) => <span key={reason} className="text-xs text-bambu-gray">{reason}</span>)}
        {canUpdate && (
          <Button className="ml-auto" size="sm" variant="danger" disabled={disablePending} onClick={onDisable}>
            {t('printerSlicerBindings.disable')}
          </Button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        <label className="text-sm text-bambu-gray">
          {t('printerSlicerBindings.processDefault')}
          <select
            aria-label={t('printerSlicerBindings.processDefaultFor', { name: binding.profile_name })}
            className={`${selectClass} ml-2`}
            value={binding.default_process_profile_id ?? ''}
            disabled={!canUpdate || updatePending || classificationsLoading}
            onChange={(event) => onUpdate({ default_process_profile_id: event.target.value ? Number(event.target.value) : null })}
          >
            <option value="">{t('printerSlicerBindings.noDefault')}</option>
            {missingProcessDefault && (
              <option value={binding.default_process_profile_id ?? ''}>
                {t('printerSlicerBindings.unavailableDefault', { id: binding.default_process_profile_id })}
              </option>
            )}
            {processProfiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>{profile.display_name}</option>)}
          </select>
        </label>
        <label className="text-sm text-bambu-gray">
          {t('printerSlicerBindings.filamentDefault')}
          <select
            aria-label={t('printerSlicerBindings.filamentDefaultFor', { name: binding.profile_name })}
            className={`${selectClass} ml-2`}
            value={binding.default_filament_profile_id ?? ''}
            disabled={!canUpdate || updatePending || classificationsLoading}
            onChange={(event) => onUpdate({ default_filament_profile_id: event.target.value ? Number(event.target.value) : null })}
          >
            <option value="">{t('printerSlicerBindings.noDefault')}</option>
            {missingFilamentDefault && (
              <option value={binding.default_filament_profile_id ?? ''}>
                {t('printerSlicerBindings.unavailableDefault', { id: binding.default_filament_profile_id })}
              </option>
            )}
            {filamentProfiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>{profile.display_name}</option>)}
          </select>
        </label>
        <label className="text-sm text-bambu-gray">
          {t('printerSlicerBindings.rollout')}
          <select
            aria-label={t('printerSlicerBindings.rolloutFor', { name: binding.profile_name })}
            className={`${selectClass} ml-2`}
            value={binding.enforcement_state}
            disabled={!canUpdate || updatePending}
            onChange={(event) => onUpdate({ enforcement_state: event.target.value as 'shadow' | 'enforced' })}
          >
            <option value="shadow">{t('printerSlicerBindings.rolloutShadow')}</option>
            <option value="enforced">{t('printerSlicerBindings.rolloutEnforced')}</option>
          </select>
        </label>
      </div>
      {updateError != null && <p role="alert" className="mt-2 text-sm text-red-400">{errorMessage(updateError, t('printerSlicerBindings.requestFailed'))}</p>}
    </div>
  );
}
