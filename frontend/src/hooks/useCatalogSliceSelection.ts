import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  api,
  type PresetRef,
  type SlicerCatalogClassification,
  type SlicerCatalogGroups,
} from '../api/client';
import {
  catalogClassification,
  catalogClassifications,
  pickCatalogFilament,
  pickCatalogProcess,
  selectableCatalogProfile,
  type CatalogProfileChoice,
} from '../utils/catalogSliceSelection';

export interface CatalogFilamentSlot {
  slot_id?: number;
  type: string;
  color: string;
  used_in_plate?: boolean;
}

export interface ResolvedCatalogSliceSelection {
  printerId: number;
  bindingId: number;
  processProfileId: number;
  filamentProfileIds: number[];
  printerPreset: PresetRef;
  processPreset: PresetRef;
  filamentPresets: PresetRef[];
  acknowledgement: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
}

function preferenceProfileId(
  preferences: Array<{ key: string; value: { profile_id: number } }> | undefined,
  key: 'process_profile' | 'filament_profile',
) {
  return preferences?.find((preference) => preference.key === key)?.value.profile_id ?? null;
}

export function useCatalogSliceSelection({
  filamentSlots,
  embeddedProcess,
}: {
  filamentSlots: CatalogFilamentSlot[];
  embeddedProcess?: string | null;
}) {
  const [printerId, setPrinterIdState] = useState<number | null>(null);
  const [bindingId, setBindingIdState] = useState<number | null>(null);
  const [processChoice, setProcessChoice] = useState<CatalogProfileChoice | null>(null);
  const [filamentChoices, setFilamentChoices] = useState<Array<CatalogProfileChoice | null>>([]);
  const [acknowledged, setAcknowledged] = useState(false);

  const printersQuery = useQuery({
    queryKey: ['printers'],
    queryFn: api.getPrinters,
  });
  const profilesQuery = useQuery({
    queryKey: ['slicerCatalogProfiles'],
    queryFn: () => api.listSlicerCatalogProfiles(),
  });
  const rulesQuery = useQuery({
    queryKey: ['slicerCatalogFilamentRules'],
    queryFn: api.listSlicerFilamentRules,
  });
  const bindingsQuery = useQuery({
    queryKey: ['slicerCatalogBindings', printerId],
    queryFn: () => api.listSlicerCatalogBindings(printerId!),
    enabled: printerId !== null,
  });
  const groupsQuery = useQuery({
    queryKey: ['slicerCatalogGroups', printerId, bindingId],
    queryFn: () => api.getSlicerCatalogGroups(printerId!, bindingId!),
    enabled: printerId !== null && bindingId !== null,
  });
  const preferencesQuery = useQuery({
    queryKey: ['slicerCatalogPreferences', bindingId],
    queryFn: () => api.listSlicerCatalogPreferences(bindingId!),
    enabled: bindingId !== null,
    retry: false,
  });
  const assignmentsQuery = useQuery({
    queryKey: ['inventory-assignments', printerId],
    queryFn: () => api.getAssignments(printerId!),
    enabled: printerId !== null,
    retry: false,
  });
  const spoolmanAssignmentsQuery = useQuery({
    queryKey: ['spoolman-slot-assignments', printerId],
    queryFn: () => api.getSpoolmanSlotAssignments(printerId!),
    enabled: printerId !== null,
    retry: false,
  });
  const savePreference = useMutation({
    mutationFn: ({ profileId, profileType }: { profileId: number; profileType: 'process' | 'filament' }) =>
      api.saveSlicerCatalogPreference(bindingId!, profileId, profileType),
  });

  const activePrinters = useMemo(
    () => (printersQuery.data ?? []).filter((printer) => printer.is_active),
    [printersQuery.data],
  );
  const activeBindings = useMemo(
    () => (bindingsQuery.data ?? []).filter((binding) => binding.is_active),
    [bindingsQuery.data],
  );
  const selectedBinding = activeBindings.find((binding) => binding.id === bindingId) ?? null;
  const processPreferenceId = preferenceProfileId(preferencesQuery.data, 'process_profile');
  const filamentPreferenceId = preferenceProfileId(preferencesQuery.data, 'filament_profile');

  const setPrinterId = useCallback((next: number | null) => {
    setPrinterIdState(next);
    setBindingIdState(null);
    setProcessChoice(null);
    setFilamentChoices([]);
    setAcknowledged(false);
  }, []);
  const setBindingId = useCallback((next: number | null) => {
    setBindingIdState(next);
    setProcessChoice(null);
    setFilamentChoices([]);
    setAcknowledged(false);
  }, []);

  useEffect(() => {
    if (bindingId !== null && bindingsQuery.isSuccess && !activeBindings.some((binding) => binding.id === bindingId)) {
      setBindingId(null);
    }
  }, [activeBindings, bindingId, bindingsQuery.isSuccess, setBindingId]);

  useEffect(() => {
    const groups = groupsQuery.data;
    if (!groups || !selectedBinding) return;
    setProcessChoice((current) => {
      if (current) {
        const profile = catalogClassification(groups, current.id);
        if (profile && selectableCatalogProfile(profile)) return current;
      }
      return pickCatalogProcess(
        groups,
        embeddedProcess,
        processPreferenceId,
        selectedBinding.default_process_profile_id,
      );
    });
  }, [embeddedProcess, groupsQuery.data, processPreferenceId, selectedBinding]);

  useEffect(() => {
    const groups = groupsQuery.data;
    if (!groups || !selectedBinding) return;
    setFilamentChoices((current) => filamentSlots.map((slot, index) => {
      const existing = current[index];
      if (existing?.manual) {
        const profile = catalogClassification(groups, existing.id);
        if (profile && selectableCatalogProfile(profile)) return existing;
      }
      return pickCatalogFilament(
        groups,
        profilesQuery.data ?? [],
        rulesQuery.data ?? [],
        selectedBinding,
        slot,
        assignmentsQuery.data ?? [],
        spoolmanAssignmentsQuery.data ?? [],
        filamentPreferenceId,
      );
    }));
  }, [
    assignmentsQuery.data,
    filamentPreferenceId,
    filamentSlots,
    groupsQuery.data,
    profilesQuery.data,
    rulesQuery.data,
    selectedBinding,
    spoolmanAssignmentsQuery.data,
  ]);

  const chooseProcess = useCallback((profile: SlicerCatalogClassification) => {
    if (!selectableCatalogProfile(profile)) return;
    setProcessChoice({ id: profile.profile_id, reason: 'manual', manual: true });
    setAcknowledged(false);
    if (bindingId !== null) savePreference.mutate({ profileId: profile.profile_id, profileType: 'process' });
  }, [bindingId, savePreference]);
  const chooseFilament = useCallback((index: number, profile: SlicerCatalogClassification) => {
    if (!selectableCatalogProfile(profile)) return;
    setFilamentChoices((current) => {
      const next = filamentSlots.map((_, slotIndex) => current[slotIndex] ?? null);
      next[index] = { id: profile.profile_id, reason: 'manual', manual: true };
      return next;
    });
    setAcknowledged(false);
    if (bindingId !== null) savePreference.mutate({ profileId: profile.profile_id, profileType: 'filament' });
  }, [bindingId, filamentSlots, savePreference]);

  const selectedClassifications = useMemo(() => {
    const groups = groupsQuery.data;
    return [
      ...(processChoice ? [catalogClassification(groups, processChoice.id)] : []),
      ...filamentChoices.map((choice) => choice && catalogClassification(groups, choice.id)),
    ].filter((profile): profile is SlicerCatalogClassification => profile !== undefined && profile !== null);
  }, [filamentChoices, groupsQuery.data, processChoice]);
  const acknowledgementReasons = useMemo(() => [
    ...(selectedBinding?.readiness.state === 'acknowledgement_required'
      ? selectedBinding.readiness.reason_codes
      : []),
    ...selectedClassifications.flatMap((profile) =>
      profile.classification.acknowledgement_required
        ? profile.classification.reason_codes
        : [],
    ),
  ].filter((reason, index, all) => all.indexOf(reason) === index), [selectedBinding, selectedClassifications]);
  const needsAcknowledgement = acknowledgementReasons.length > 0;

  const selectedPrinterPreset = useMemo<PresetRef | null>(() => {
    const profile = (profilesQuery.data ?? []).find((item) => item.profile_id === selectedBinding?.profile_id);
    return profile ? { source: profile.source, id: profile.remote_profile_id } : null;
  }, [profilesQuery.data, selectedBinding?.profile_id]);
  const selectedProcessPreset = useMemo<PresetRef | null>(() => {
    const profile = (profilesQuery.data ?? []).find((item) => item.profile_id === processChoice?.id);
    return profile ? { source: profile.source, id: profile.remote_profile_id } : null;
  }, [processChoice?.id, profilesQuery.data]);
  const selectedFilamentPresets = useMemo<Array<PresetRef | null>>(
    () => filamentChoices.map((choice) => {
      const profile = (profilesQuery.data ?? []).find((item) => item.profile_id === choice?.id);
      return profile ? { source: profile.source, id: profile.remote_profile_id } : null;
    }),
    [filamentChoices, profilesQuery.data],
  );

  const resolvedSelection = useMemo<ResolvedCatalogSliceSelection | null>(() => {
    if (
      printerId === null
      || !selectedBinding
      || !processChoice
      || filamentChoices.length !== filamentSlots.length
      || filamentChoices.some((choice) => choice === null)
      || selectedBinding.readiness.state === 'blocked'
      || (needsAcknowledgement && !acknowledged)
    ) return null;
    if (
      !selectedPrinterPreset
      || !selectedProcessPreset
      || selectedFilamentPresets.some((preset) => preset === null)
    ) return null;
    const processClassification = catalogClassification(groupsQuery.data, processChoice.id);
    return {
      printerId,
      bindingId: selectedBinding.id,
      processProfileId: processChoice.id,
      filamentProfileIds: filamentChoices.map((choice) => choice!.id),
      printerPreset: selectedPrinterPreset,
      processPreset: selectedProcessPreset,
      filamentPresets: selectedFilamentPresets as PresetRef[],
      acknowledgement: needsAcknowledgement
        ? { confirmed: true, reason_codes: acknowledgementReasons }
        : null,
      evidence: {
        process: {
          profile_id: processChoice.id,
          reason: processChoice.reason,
          group: processClassification?.classification.group,
          reason_codes: processClassification?.classification.reason_codes ?? [],
        },
        filaments: filamentChoices.map((choice, index) => {
          const classification = catalogClassification(groupsQuery.data, choice!.id);
          return {
            slot_id: filamentSlots[index]?.slot_id ?? index + 1,
            profile_id: choice!.id,
            reason: choice!.reason,
            group: classification?.classification.group,
            reason_codes: classification?.classification.reason_codes ?? [],
          };
        }),
        binding_readiness: selectedBinding.readiness,
        nozzle: selectedBinding.nozzle,
      },
    };
  }, [
    acknowledged,
    acknowledgementReasons,
    filamentChoices,
    filamentSlots,
    groupsQuery.data,
    needsAcknowledgement,
    printerId,
    processChoice,
    selectedBinding,
    selectedFilamentPresets,
    selectedPrinterPreset,
    selectedProcessPreset,
  ]);

  const loading = printersQuery.isLoading
    || profilesQuery.isLoading
    || (printerId !== null && bindingsQuery.isLoading)
    || (bindingId !== null && groupsQuery.isLoading);
  const error = printersQuery.error
    ?? profilesQuery.error
    ?? bindingsQuery.error
    ?? groupsQuery.error
    ?? rulesQuery.error;

  return {
    activePrinters,
    activeBindings,
    printerId,
    setPrinterId,
    bindingId,
    setBindingId,
    selectedBinding,
    groups: groupsQuery.data as SlicerCatalogGroups | undefined,
    allClassifications: catalogClassifications(groupsQuery.data),
    processChoice,
    filamentChoices,
    selectedPrinterPreset,
    selectedProcessPreset,
    selectedFilamentPresets,
    chooseProcess,
    chooseFilament,
    acknowledged,
    setAcknowledged,
    needsAcknowledgement,
    acknowledgementReasons,
    resolvedSelection,
    loading,
    error,
  };
}

export type CatalogSliceSelectionState = ReturnType<typeof useCatalogSliceSelection>;
