import type {
  SpoolAssignment,
  SlicerCatalogBinding,
  SlicerCatalogClassification,
  SlicerCatalogGroups,
  SlicerCatalogProfile,
  SlicerFilamentRule,
} from '../api/client';
import { canonicalFilamentType, normalizeColorForCompare } from './amsHelpers';

export type CatalogSelectionReason =
  | 'embedded_process'
  | 'exact_external_assignment'
  | 'promoted_signature'
  | 'unique_metadata_match'
  | 'user_preference'
  | 'binding_default'
  | 'manual';

export interface CatalogProfileChoice {
  id: number;
  reason: CatalogSelectionReason;
  manual: boolean;
}

export interface SpoolmanSlotAssignment {
  printer_id: number;
  ams_id: number;
  tray_id: number;
  spoolman_spool_id: number;
}

export function catalogClassifications(groups: SlicerCatalogGroups | undefined) {
  if (!groups) return [];
  return [
    ...groups.selected_printer,
    ...groups.other_installed_printers,
    ...groups.unclassified,
    ...groups.incompatible,
  ];
}

export function catalogClassification(
  groups: SlicerCatalogGroups | undefined,
  profileId: number,
) {
  return catalogClassifications(groups).find((profile) => profile.profile_id === profileId);
}

export function catalogFilamentMaterial(profile: SlicerCatalogProfile | undefined): string {
  const metadata = profile?.compatibility_metadata ?? {};
  const material = metadata.filament_type ?? metadata.material_type;
  return typeof material === 'string' ? canonicalFilamentType(material.trim()) : '';
}

function autoCandidate(
  groups: SlicerCatalogGroups | undefined,
  profileId: number | null | undefined,
  type: 'process' | 'filament',
) {
  if (profileId == null) return undefined;
  return groups?.selected_printer.find(
    (profile) =>
      profile.profile_id === profileId
      && profile.profile_type === type
      && profile.classification.auto_selectable,
  );
}

function normalizedName(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
}

export function pickCatalogProcess(
  groups: SlicerCatalogGroups | undefined,
  embeddedProcess: string | null | undefined,
  preferenceProfileId: number | null | undefined,
  bindingDefaultProfileId: number | null | undefined,
): CatalogProfileChoice | null {
  const embeddedName = normalizedName(embeddedProcess);
  if (embeddedName) {
    const matches = (groups?.selected_printer ?? []).filter(
      (profile) =>
        profile.profile_type === 'process'
        && profile.classification.auto_selectable
        && normalizedName(profile.display_name) === embeddedName,
    );
    if (matches.length === 1) {
      return { id: matches[0].profile_id, reason: 'embedded_process', manual: false };
    }
  }
  const preference = autoCandidate(groups, preferenceProfileId, 'process');
  if (preference) return { id: preference.profile_id, reason: 'user_preference', manual: false };
  const fallback = autoCandidate(groups, bindingDefaultProfileId, 'process');
  if (fallback) return { id: fallback.profile_id, reason: 'binding_default', manual: false };
  return null;
}

function sameSlot(
  slot: { type: string; color: string },
  assignment: SpoolAssignment,
) {
  const spool = assignment.spool;
  if (!spool || canonicalFilamentType(spool.material) !== canonicalFilamentType(slot.type)) return false;
  const requiredColor = normalizeColorForCompare(slot.color);
  return !requiredColor || normalizeColorForCompare(spool.rgba ?? undefined) === requiredColor;
}

function unique<T>(items: T[]) {
  return items.length === 1 ? items[0] : undefined;
}

function ruleAppliesToBinding(rule: SlicerFilamentRule, binding: SlicerCatalogBinding) {
  return rule.is_active && (rule.binding_id == null || rule.binding_id === binding.id);
}

function oneCandidateProfile(
  groups: SlicerCatalogGroups | undefined,
  profileIds: number[],
) {
  const uniqueIds = [...new Set(profileIds)];
  if (uniqueIds.length !== 1) return undefined;
  return autoCandidate(groups, uniqueIds[0], 'filament');
}

export function pickCatalogFilament(
  groups: SlicerCatalogGroups | undefined,
  profiles: SlicerCatalogProfile[],
  rules: SlicerFilamentRule[],
  binding: SlicerCatalogBinding,
  slot: { type: string; color: string },
  assignments: SpoolAssignment[],
  spoolmanAssignments: SpoolmanSlotAssignment[],
  preferenceProfileId: number | null | undefined,
): CatalogProfileChoice | null {
  const assignment = unique(assignments.filter((item) => sameSlot(slot, item)));
  if (assignment) {
    const spoolman = spoolmanAssignments.find(
      (item) => item.printer_id === assignment.printer_id
        && item.ams_id === assignment.ams_id
        && item.tray_id === assignment.tray_id,
    );
    if (spoolman) {
      const exact = oneCandidateProfile(
        groups,
        rules
          .filter(
            (rule) =>
              rule.scope === 'exact_external'
              && ruleAppliesToBinding(rule, binding)
              && rule.external_source === 'spoolman'
              && rule.external_identity === `spool:${spoolman.spoolman_spool_id}`,
          )
          .map((rule) => rule.filament_profile_id),
      );
      if (exact) return { id: exact.profile_id, reason: 'exact_external_assignment', manual: false };
    }
  }

  const material = canonicalFilamentType(slot.type);
  if (material) {
    const signature = oneCandidateProfile(
      groups,
      rules
        .filter((rule) => {
          if (rule.scope !== 'signature' || !ruleAppliesToBinding(rule, binding)) return false;
          if (rule.material_type && canonicalFilamentType(rule.material_type) !== material) return false;
          if (rule.vendor && normalizedName(rule.vendor) !== normalizedName(assignment?.spool?.brand)) return false;
          if (
            rule.nozzle_diameter_min != null
            && binding.expected_nozzle_diameter < rule.nozzle_diameter_min
          ) return false;
          if (
            rule.nozzle_diameter_max != null
            && binding.expected_nozzle_diameter > rule.nozzle_diameter_max
          ) return false;
          return Boolean(rule.material_type || rule.vendor);
        })
        .map((rule) => rule.filament_profile_id),
    );
    if (signature) return { id: signature.profile_id, reason: 'promoted_signature', manual: false };

    const metadataMatches = (groups?.selected_printer ?? []).filter((candidate) => {
      if (candidate.profile_type !== 'filament' || !candidate.classification.auto_selectable) return false;
      const profile = profiles.find((item) => item.profile_id === candidate.profile_id
        && item.revision_id === candidate.revision_id);
      const metadata = profile?.compatibility_metadata ?? {};
      const candidateMaterial = metadata.filament_type ?? metadata.material_type;
      if (typeof candidateMaterial !== 'string' || canonicalFilamentType(candidateMaterial) !== material) {
        return false;
      }
      const vendor = metadata.vendor;
      return typeof vendor !== 'string'
        || !assignment?.spool?.brand
        || normalizedName(vendor) === normalizedName(assignment.spool.brand);
    });
    if (metadataMatches.length === 1) {
      return { id: metadataMatches[0].profile_id, reason: 'unique_metadata_match', manual: false };
    }
  }

  const preference = autoCandidate(groups, preferenceProfileId, 'filament');
  if (preference) return { id: preference.profile_id, reason: 'user_preference', manual: false };
  const fallback = autoCandidate(groups, binding.default_filament_profile_id, 'filament');
  if (fallback) return { id: fallback.profile_id, reason: 'binding_default', manual: false };
  return null;
}

export function selectableCatalogProfile(profile: SlicerCatalogClassification) {
  return profile.classification.selectable
    && (profile.classification.group === 'selected_printer'
      || profile.classification.group === 'unclassified');
}

export function catalogMaterialWarnings(
  slots: Array<{ type: string }>,
  profiles: Array<SlicerCatalogProfile | undefined>,
  revisions: Array<number | null | undefined>,
) {
  return slots.flatMap((slot, index) => {
    const profile = profiles[index];
    if (!profile) return [];
    const declared = canonicalFilamentType(slot.type.trim());
    const metadata = profile.compatibility_metadata ?? {};
    const profileType = metadata.filament_type ?? metadata.material_type;
    const selected = profile.revision_id === revisions[index] && typeof profileType === 'string'
      ? canonicalFilamentType(profileType.trim()) : '';
    if (declared && selected && declared === selected) return [];
    const reason = declared && selected ? 'material_mismatch' : 'material_unverified';
    const detail = declared
      ? `project ${declared}, selected ${selected || 'profile material unknown'}`
      : `source material unknown, selected ${selected || 'profile material unknown'}`;
    return [{ reason, message: `Filament ${index + 1}: ${detail}` }];
  });
}

/** Readiness of the chosen combination, not the binding's fallback defaults. */
export function catalogSelectionReadiness({
  binding,
  process,
  filaments,
  filamentCount,
  materialWarnings = [],
  unavailable = false,
}: {
  binding: SlicerCatalogBinding | null | undefined;
  process: SlicerCatalogClassification | undefined;
  filaments: Array<SlicerCatalogClassification | null | undefined>;
  filamentCount: number;
  materialWarnings?: Array<{ reason: string }>;
  unavailable?: boolean;
}): SlicerCatalogBinding['readiness'] {
  const blocked = (reason_codes: string[]): SlicerCatalogBinding['readiness'] => ({
    state: 'blocked', reason_codes: [...new Set(reason_codes)],
  });
  if (unavailable) return blocked(['catalog_unavailable']);
  if (!binding) return blocked(['binding_unavailable']);
  if (!binding.is_active) return blocked(['binding_inactive']);
  if (!process) return blocked(['process_selection_required']);
  if (filaments.length !== filamentCount || filaments.some((profile) => !profile)) {
    return blocked(['filament_selection_required']);
  }
  const profiles = [process, ...filaments.filter((profile): profile is SlicerCatalogClassification => !!profile)];
  // Only a missing fallback is irrelevant to a complete explicit selection.
  const hardReasons = binding.readiness.state === 'blocked'
    ? binding.readiness.reason_codes.filter((reason) => reason !== 'default_unavailable')
    : [];
  if (binding.readiness.state === 'blocked' && binding.readiness.reason_codes.length === 0) {
    hardReasons.push('binding_unavailable');
  }
  const warnings: string[] = binding.readiness.state === 'acknowledgement_required'
    ? [...binding.readiness.reason_codes] : [];
  const nozzle = binding.nozzle;
  if (nozzle.tool_index !== binding.tool_index) hardReasons.push('tool_mismatch');
  if (nozzle.status === 'confirmed' && nozzle.diameter != null) {
    if (nozzle.diameter !== binding.expected_nozzle_diameter) hardReasons.push('nozzle_mismatch');
  } else {
    warnings.push(nozzle.status === 'offline' ? 'offline_unknown' : nozzle.status === 'stale' ? 'telemetry_stale' : 'nozzle_unknown');
  }
  for (const profile of profiles) {
    if (!selectableCatalogProfile(profile) || profile.classification.readiness === 'blocked') {
      hardReasons.push(...profile.classification.reason_codes, 'profile_not_selectable');
    } else if (profile.classification.acknowledgement_required) {
      warnings.push(...(profile.classification.reason_codes.length ? profile.classification.reason_codes : ['compatibility_unknown']));
    }
  }
  warnings.push(...materialWarnings.map((warning) => warning.reason));
  if (hardReasons.length > 0) return blocked(hardReasons);
  return warnings.length > 0
    ? { state: 'acknowledgement_required', reason_codes: [...new Set(warnings)] }
    : { state: 'ready', reason_codes: [] };
}
