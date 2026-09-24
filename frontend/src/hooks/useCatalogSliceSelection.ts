import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  api,
  type PresetRef,
  type SliceRequest,
  type SlicerCatalogClassification,
  type SlicerCatalogGroups,
} from '../api/client';
import {
  catalogClassification,
  catalogClassifications,
  catalogFilamentMaterial,
  catalogMaterialWarnings,
  catalogSelectionReadiness,
  pickCatalogFilament,
  pickCatalogProcess,
  selectableCatalogProfile,
  type CatalogProfileChoice,
} from '../utils/catalogSliceSelection';
import { canonicalFilamentType } from '../utils/amsHelpers';

export interface CatalogFilamentSlot {
  slot_id?: number;
  type: string;
  color: string;
  used_in_plate?: boolean;
}

export interface ResolvedCatalogSliceSelection {
  destinationArtifactKind: NonNullable<SliceRequest['destination_artifact_kind']>;
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
  const [acknowledgementKey, setAcknowledgementKey] = useState<string | null>(null);
  const lastRevisionMismatch = useRef<string | null>(null);

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
    queryKey: ['slicerCatalogBindings'],
    queryFn: () => api.listSlicerCatalogBindings(),
    refetchInterval: 30_000,
  });
  const groupsQuery = useQuery({
    queryKey: ['slicerCatalogGroups', printerId, bindingId],
    queryFn: () => api.getSlicerCatalogGroups(printerId!, bindingId!),
    enabled: printerId !== null && bindingId !== null,
    refetchInterval: 30_000,
  });
  const refetchProfiles = profilesQuery.refetch;
  useEffect(() => {
    const profiles = profilesQuery.data;
    const mismatch = profiles && catalogClassifications(groupsQuery.data)
      .map((classification) => {
        const profile = profiles.find((item) => item.profile_id === classification.profile_id);
        return profile && profile.revision_id !== classification.revision_id
          ? `${profile.profile_id}:${profile.revision_id}:${classification.revision_id}` : null;
      })
      .filter(Boolean).join('|');
    if (!mismatch) {
      lastRevisionMismatch.current = null;
    } else if (mismatch !== lastRevisionMismatch.current) {
      lastRevisionMismatch.current = mismatch;
      void refetchProfiles();
    }
  }, [groupsQuery.data, profilesQuery.data, refetchProfiles]);
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
    () => (bindingsQuery.data ?? []).filter((binding) => binding.is_active && binding.printer_id === printerId),
    [bindingsQuery.data, printerId],
  );
  const printerBindings = bindingsQuery.data ?? [];
  const selectedBinding = activeBindings.find((binding) => binding.id === bindingId) ?? null;
  const selectedPrinter = activePrinters.find((printer) => printer.id === printerId);
  const destinationArtifactKind = selectedPrinter?.provider === 'moonraker'
    ? 'klipper_gcode' as const
    : selectedPrinter?.provider === 'bambu' ? 'bambu_3mf' as const : null;
  const processPreferenceId = preferenceProfileId(preferencesQuery.data, 'process_profile');
  const filamentPreferenceId = preferenceProfileId(preferencesQuery.data, 'filament_profile');

  const setPrinterId = useCallback((next: number | null) => {
    setPrinterIdState(next);
    setBindingIdState(null);
    setProcessChoice(null);
    setFilamentChoices([]);
    setAcknowledgementKey(null);
  }, []);
  const setBindingId = useCallback((next: number | null) => {
    setBindingIdState(next);
    setProcessChoice(null);
    setFilamentChoices([]);
    setAcknowledgementKey(null);
  }, []);

  useEffect(() => {
    if (!bindingsQuery.isSuccess || printerId === null) return;
    if (bindingId !== null && !activeBindings.some((binding) => binding.id === bindingId)) {
      setBindingId(null);
    } else if (bindingId === null && activeBindings.length === 1 && activeBindings[0].confirmed_at) {
      setBindingId(activeBindings[0].id);
    }
  }, [activeBindings, bindingId, bindingsQuery.isSuccess, printerId, setBindingId]);

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
    setAcknowledgementKey(null);
    if (bindingId !== null) savePreference.mutate({ profileId: profile.profile_id, profileType: 'process' });
  }, [bindingId, savePreference]);
  const chooseFilament = useCallback((index: number, profile: SlicerCatalogClassification) => {
    if (!selectableCatalogProfile(profile)) return;
    setFilamentChoices((current) => {
      const next = filamentSlots.map((_, slotIndex) => current[slotIndex] ?? null);
      next[index] = { id: profile.profile_id, reason: 'manual', manual: true };
      return next;
    });
    setAcknowledgementKey(null);
    if (bindingId !== null) savePreference.mutate({ profileId: profile.profile_id, profileType: 'filament' });
  }, [bindingId, filamentSlots, savePreference]);

  const selectedClassifications = useMemo(() => {
    const groups = groupsQuery.data;
    return [
      ...(processChoice ? [catalogClassification(groups, processChoice.id)] : []),
      ...filamentChoices.map((choice) => choice && catalogClassification(groups, choice.id)),
    ].filter((profile): profile is SlicerCatalogClassification => profile !== undefined && profile !== null);
  }, [filamentChoices, groupsQuery.data, processChoice]);
  const selectedFilamentProfiles = useMemo(() => filamentChoices.map((choice) =>
    (profilesQuery.data ?? []).find((profile) => profile.profile_id === choice?.id)),
  [filamentChoices, profilesQuery.data]);
  const materialWarnings = useMemo(() => catalogMaterialWarnings(
    filamentSlots,
    selectedFilamentProfiles,
    filamentChoices.map((choice) => choice && catalogClassification(groupsQuery.data, choice.id)?.revision_id),
  ), [filamentSlots, selectedFilamentProfiles, filamentChoices, groupsQuery.data]);
  const unconfirmedReadiness = useMemo(() => catalogSelectionReadiness({
    binding: selectedBinding,
    process: processChoice ? catalogClassification(groupsQuery.data, processChoice.id) : undefined,
    filaments: filamentChoices.map((choice) => choice && catalogClassification(groupsQuery.data, choice.id)),
    filamentCount: filamentSlots.length,
    materialWarnings,
    unavailable: profilesQuery.isError || bindingsQuery.isError || groupsQuery.isError,
  }), [selectedBinding, processChoice, filamentChoices, filamentSlots.length, groupsQuery.data,
    materialWarnings, profilesQuery.isError, bindingsQuery.isError, groupsQuery.isError]);
  const acknowledgementContext = JSON.stringify({
    binding: selectedBinding,
    profiles: selectedClassifications.map((profile) => [profile.profile_id, profile.revision_id, profile.classification]),
    materials: filamentSlots.map((slot, index) => [slot.slot_id ?? index + 1, slot.type,
      selectedFilamentProfiles[index]?.revision_id, selectedFilamentProfiles[index]?.compatibility_metadata]),
  });
  // Consent applies only to the exact evidence that was displayed, never a later revision/nozzle.
  const acknowledged = acknowledgementKey === acknowledgementContext;
  const setAcknowledged = useCallback((confirmed: boolean) => {
    setAcknowledgementKey(confirmed ? acknowledgementContext : null);
  }, [acknowledgementContext]);
  const needsAcknowledgement = unconfirmedReadiness.state === 'acknowledgement_required';
  const acknowledgementReasons = useMemo(() => needsAcknowledgement ? unconfirmedReadiness.reason_codes : [],
    [needsAcknowledgement, unconfirmedReadiness.reason_codes]);
  const selectionReadiness = useMemo(() => acknowledged && needsAcknowledgement
    ? { state: 'ready' as const, reason_codes: [] }
    : unconfirmedReadiness, [acknowledged, needsAcknowledgement, unconfirmedReadiness]);

  const selectedPrinterProfile = (profilesQuery.data ?? []).find((profile) => profile.profile_id === selectedBinding?.profile_id);

  const equivalentFilamentSlotCounts = filamentSlots.map((slot, index) => {
    const choice = filamentChoices[index];
    const classification = choice && catalogClassification(groupsQuery.data, choice.id);
    const material = classification?.revision_id === selectedFilamentProfiles[index]?.revision_id
      ? catalogFilamentMaterial(selectedFilamentProfiles[index]) : '';
    if (!classification || !selectableCatalogProfile(classification)
      || !material || material !== canonicalFilamentType(slot.type) || slot.used_in_plate === false) return 0;
    return filamentSlots.filter((candidate, candidateIndex) => candidateIndex !== index
      && candidate.used_in_plate !== false
      && canonicalFilamentType(candidate.type) === material
      && filamentChoices[candidateIndex]?.id !== filamentChoices[index]?.id).length;
  });

  const applyFilamentToEquivalentSlots = useCallback((index: number) => {
    const choice = filamentChoices[index];
    const profile = selectedFilamentProfiles[index];
    const classification = choice && catalogClassification(groupsQuery.data, choice.id);
    const material = classification?.revision_id === profile?.revision_id
      ? catalogFilamentMaterial(profile) : '';
    if (!choice || !classification || !selectableCatalogProfile(classification)
      || !material || material !== canonicalFilamentType(filamentSlots[index]?.type)
      || filamentSlots[index]?.used_in_plate === false) return;
    setFilamentChoices((current) => filamentSlots.map((slot, slotIndex) =>
      slot.used_in_plate !== false && canonicalFilamentType(slot.type) === material
        ? { id: choice.id, reason: 'manual', manual: true }
        : current[slotIndex] ?? null));
    setAcknowledgementKey(null);
  }, [filamentChoices, filamentSlots, groupsQuery.data, selectedFilamentProfiles]);

  const selectSavedFilament = useCallback(async (index: number, profileId: number) => {
    const targetBinding = bindingId;
    const [, refreshed] = await Promise.all([profilesQuery.refetch(), groupsQuery.refetch()]);
    if (targetBinding === null) throw new Error('Choose the target printer before using the saved profile.');
    const profile = catalogClassification(refreshed.data, profileId);
    if (!profile || !selectableCatalogProfile(profile)) {
      throw new Error('Profile saved, but it is not selectable for this printer. Check its compatibility in Settings.');
    }
    chooseFilament(index, profile);
  }, [bindingId, chooseFilament, profilesQuery, groupsQuery]);

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
      || destinationArtifactKind === null
      || !selectedBinding
      || !processChoice
      || filamentChoices.length !== filamentSlots.length
      || filamentChoices.some((choice) => choice === null)
      || selectionReadiness.state !== 'ready'
    ) return null;
    if (
      !selectedPrinterPreset
      || !selectedProcessPreset
      || selectedFilamentPresets.some((preset) => preset === null)
    ) return null;
    const processClassification = catalogClassification(groupsQuery.data, processChoice.id);
    const filamentClassifications = filamentChoices.map((choice) =>
      catalogClassification(groupsQuery.data, choice!.id));
    if (
      !processClassification
      || !selectableCatalogProfile(processClassification)
      || filamentClassifications.some(
        (classification) => !classification || !selectableCatalogProfile(classification),
      )
    ) return null;
    return {
      destinationArtifactKind,
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
        printer_revision_id: selectedPrinterProfile?.revision_id,
        process: {
          profile_id: processChoice.id,
          revision_id: processClassification.revision_id,
          reason: processChoice.reason,
          group: processClassification?.classification.group,
          reason_codes: processClassification?.classification.reason_codes ?? [],
        },
        filaments: filamentChoices.map((choice, index) => {
          const classification = filamentClassifications[index];
          return {
            slot_id: filamentSlots[index]?.slot_id ?? index + 1,
            profile_id: choice!.id,
            revision_id: classification?.revision_id,
            reason: choice!.reason,
            group: classification?.classification.group,
            reason_codes: classification?.classification.reason_codes ?? [],
          };
        }),
        binding_readiness: selectedBinding.readiness,
        selection_readiness: selectionReadiness,
        nozzle: selectedBinding.nozzle,
      },
    };
  }, [
    acknowledgementReasons,
    destinationArtifactKind,
    filamentChoices,
    filamentSlots,
    groupsQuery.data,
    needsAcknowledgement,
    printerId,
    processChoice,
    selectedBinding,
    selectedFilamentPresets,
    selectedPrinterPreset,
    selectedPrinterProfile?.revision_id,
    selectedProcessPreset,
    selectionReadiness,
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
    printerBindings,
    destinationArtifactKind,
    printerId,
    setPrinterId,
    bindingId,
    setBindingId,
    selectedBinding,
    groups: groupsQuery.data as SlicerCatalogGroups | undefined,
    catalogProfiles: profilesQuery.data,
    allClassifications: catalogClassifications(groupsQuery.data),
    processChoice,
    filamentChoices,
    selectedPrinterPreset,
    selectedPrinterProfile,
    selectedFilamentProfiles,
    equivalentFilamentSlotCounts,
    applyFilamentToEquivalentSlots,
    selectSavedFilament,
    selectedProcessPreset,
    selectedFilamentPresets,
    chooseProcess,
    chooseFilament,
    acknowledged,
    setAcknowledged,
    needsAcknowledgement,
    acknowledgementReasons,
    materialWarnings,
    resolvedSelection,
    selectionReadiness,
    loading,
    error,
  };
}

export type CatalogSliceSelectionState = ReturnType<typeof useCatalogSliceSelection>;
