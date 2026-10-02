import type { TFunction } from 'i18next';

const reasonKeys: Record<string, string> = {
  binding_unavailable: 'binding', binding_inactive: 'binding',
  profile_unavailable: 'profile', profile_tombstoned: 'profile', profile_inactive: 'profile', profile_not_selectable: 'profile',
  revision_unreviewed: 'review', tool_mismatch: 'tool',
  profile_nozzle_invalid: 'nozzle', profile_nozzle_mismatch: 'nozzle', nozzle_mismatch: 'nozzle',
  default_unavailable: 'defaults',
  offline_unknown: 'nozzleUnverified', nozzle_offline: 'nozzleUnverified', telemetry_stale: 'nozzleUnverified', nozzle_unknown: 'nozzleUnverified',
  nozzle_match: 'nozzleMatch',
  resolved_metadata_match: 'compatible', administrator_mapping: 'compatible',
  resolved_metadata_mismatch: 'incompatible', administrator_mapping_other_printer: 'incompatible', other_installed_printer: 'incompatible', explicit_mismatch: 'incompatible',
  compatibility_unknown: 'compatibilityUnverified',
  process_selection_required: 'process', filament_selection_required: 'filament', catalog_unavailable: 'catalog',
  material_mismatch: 'materialMismatch', material_unverified: 'materialUnverified',
};

export function displayedSlicerReadiness(state: string, reasons: string[]): string {
  return reasons.some((reason) => !Object.hasOwn(reasonKeys, reason)) ? 'unknown' : state;
}

export function slicerReadinessState(t: TFunction, state: string): string {
  const key = state === 'ready' ? 'passed' : state === 'blocked' ? 'blocked'
    : state === 'acknowledgement_required' ? 'confirmation' : 'unknown';
  return t(`slicerReadiness.${key}`);
}

export function slicerReadinessReasons(t: TFunction, reasons: string[]): string[] {
  return [...new Set(reasons.map((reason) => t(`slicerReadiness.${Object.hasOwn(reasonKeys, reason) ? reasonKeys[reason] : 'unknown'}`)))];
}
