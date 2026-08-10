import { useState } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type Printer,
  type SlicerCatalogBinding,
  type SlicerCatalogBindingInput,
  type SlicerCatalogClassification,
} from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './Button';
import { Card, CardContent } from './Card';
import { ConfirmModal } from './ConfirmModal';

const selectClass = 'rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 py-1 text-white';
const inputClass = `${selectClass} w-24`;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Binding request failed';
}

function isP1S(printer: Printer) {
  return printer.provider === 'bambu' && /p1s/i.test(`${printer.model ?? ''} ${printer.name}`);
}

export function PrinterSlicerBindings({ printers }: { printers: Printer[] }) {
  const { hasPermission, authEnabled } = useAuth();
  const queryClient = useQueryClient();
  const canUpdate = !authEnabled || hasPermission('printers:update');
  const activePrinters = printers.filter((printer) => printer.is_active);
  const [draft, setDraft] = useState<SlicerCatalogBindingInput | null>(null);
  const [suggestedDraft, setSuggestedDraft] = useState<SlicerCatalogBindingInput | null>(null);

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
    queryClient.invalidateQueries({ queryKey: ['slicerCatalogBindings', printerId] });
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

  const printerProfiles = (profiles.data ?? []).filter(
    (profile) => profile.profile_type === 'printer' && !profile.tombstoned,
  );
  const startDraft = (printerId: number, profileId = printerProfiles[0]?.profile_id ?? 0) => {
    setDraft({
      printer_id: printerId,
      profile_id: profileId,
      expected_nozzle_diameter: 0.4,
      tool_index: 0,
      enforcement_state: 'shadow',
    });
  };

  if (!activePrinters.length) return null;
  return (
    <Card>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-white">Installed printer slicer bindings</h2>
            <p className="text-sm text-bambu-gray">
              Exact printer profile, nozzle, tool, compatible defaults, and rollout state.
            </p>
          </div>
          {!canUpdate && <span className="text-sm text-amber-400">Binding changes require PRINTERS_UPDATE.</span>}
        </div>

        <div className="space-y-4">
          {activePrinters.map((printer, printerIndex) => {
            const query = bindingQueries[printerIndex];
            const bindings = (query.data ?? []).filter((binding) => binding.is_active);
            const suggestionIndex = p1sPrinters.findIndex((item) => item.id === printer.id);
            const suggestion = suggestionIndex >= 0 ? suggestionQueries[suggestionIndex]?.data : undefined;
            const setupRequired = printer.provider === 'moonraker' && bindings.length === 0;

            return (
              <section key={printer.id} className="rounded-lg border border-bambu-dark-tertiary p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium text-white">{printer.name}</h3>
                  <span className="text-xs text-bambu-gray">
                    {printer.provider} · {printer.model || 'model unknown'}
                  </span>
                  {setupRequired && <span className="text-xs text-amber-400">setup_required</span>}
                  <div className="ml-auto flex gap-2">
                    {canUpdate && suggestion?.suggested_profile_ids[0] && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          setSuggestedDraft({
                            printer_id: printer.id,
                            profile_id: suggestion.suggested_profile_ids[0],
                            expected_nozzle_diameter: 0.4,
                            tool_index: 0,
                            enforcement_state: 'shadow',
                          })
                        }
                      >
                        Use suggested profile
                      </Button>
                    )}
                    {canUpdate && (
                      <Button size="sm" onClick={() => startDraft(printer.id)} disabled={!printerProfiles.length}>
                        Add binding
                      </Button>
                    )}
                  </div>
                </div>

                {query.error && <p role="alert" className="mt-2 text-sm text-red-400">{errorMessage(query.error)}</p>}
                {!query.isLoading && !query.error && bindings.length === 0 && (
                  <p className="mt-2 text-sm text-bambu-gray">No active slicer binding.</p>
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
                <h3 className="text-lg font-semibold text-white">Create slicer binding</h3>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-bambu-gray">
                    Printer profile
                    <select
                      aria-label="Printer profile"
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
                    Expected nozzle
                    <input
                      aria-label="Expected nozzle"
                      className={`${inputClass} mt-1 block`}
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={draft.expected_nozzle_diameter}
                      onChange={(event) => setDraft({ ...draft, expected_nozzle_diameter: Number(event.target.value) })}
                    />
                  </label>
                  <label className="text-sm text-bambu-gray">
                    Tool index
                    <input
                      aria-label="Tool index"
                      className={`${inputClass} mt-1 block`}
                      type="number"
                      min="0"
                      value={draft.tool_index ?? 0}
                      onChange={(event) => setDraft({ ...draft, tool_index: Number(event.target.value) })}
                    />
                  </label>
                </div>
                {create.error && <p role="alert" className="mt-3 text-sm text-red-400">{errorMessage(create.error)}</p>}
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="secondary" onClick={() => setDraft(null)}>Cancel</Button>
                  <Button
                    onClick={() => create.mutate(draft)}
                    disabled={create.isPending || !draft.profile_id || draft.expected_nozzle_diameter <= 0}
                  >
                    Bind
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {suggestedDraft && (
          <ConfirmModal
            title="Confirm suggested slicer binding"
            message="Suggestion uses printer identity only. Confirm exact printer profile and nozzle before saving."
            confirmText="Confirm and bind"
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
        <span className="text-bambu-gray">{binding.expected_nozzle_diameter} mm · tool {binding.tool_index}</span>
        <span className={binding.readiness.state === 'ready' ? 'text-green-400' : 'text-amber-400'}>
          {binding.readiness.state}
        </span>
        <span className="text-xs text-bambu-gray">{binding.readiness.reason_codes.join(', ') || 'ready'}</span>
        {canUpdate && (
          <Button className="ml-auto" size="sm" variant="danger" disabled={disablePending} onClick={onDisable}>
            Disable
          </Button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        <label className="text-sm text-bambu-gray">
          Process default
          <select
            aria-label={`Process default for ${binding.profile_name}`}
            className={`${selectClass} ml-2`}
            value={binding.default_process_profile_id ?? ''}
            disabled={!canUpdate || updatePending || classificationsLoading}
            onChange={(event) => onUpdate({ default_process_profile_id: event.target.value ? Number(event.target.value) : null })}
          >
            <option value="">None</option>
            {missingProcessDefault && (
              <option value={binding.default_process_profile_id ?? ''}>
                Unavailable profile #{binding.default_process_profile_id}
              </option>
            )}
            {processProfiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>{profile.display_name}</option>)}
          </select>
        </label>
        <label className="text-sm text-bambu-gray">
          Filament default
          <select
            aria-label={`Filament default for ${binding.profile_name}`}
            className={`${selectClass} ml-2`}
            value={binding.default_filament_profile_id ?? ''}
            disabled={!canUpdate || updatePending || classificationsLoading}
            onChange={(event) => onUpdate({ default_filament_profile_id: event.target.value ? Number(event.target.value) : null })}
          >
            <option value="">None</option>
            {missingFilamentDefault && (
              <option value={binding.default_filament_profile_id ?? ''}>
                Unavailable profile #{binding.default_filament_profile_id}
              </option>
            )}
            {filamentProfiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>{profile.display_name}</option>)}
          </select>
        </label>
        <label className="text-sm text-bambu-gray">
          Rollout
          <select
            aria-label={`Rollout for ${binding.profile_name}`}
            className={`${selectClass} ml-2`}
            value={binding.enforcement_state}
            disabled={!canUpdate || updatePending}
            onChange={(event) => onUpdate({ enforcement_state: event.target.value as 'shadow' | 'enforced' })}
          >
            <option value="shadow">Shadow</option>
            <option value="enforced">Enforced</option>
          </select>
        </label>
      </div>
      {updateError != null && <p role="alert" className="mt-2 text-sm text-red-400">{errorMessage(updateError)}</p>}
    </div>
  );
}
