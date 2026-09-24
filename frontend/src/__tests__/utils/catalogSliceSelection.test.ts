import { describe, expect, it, vi } from 'vitest';
import type {
  SpoolAssignment,
  SlicerCatalogBinding,
  SlicerCatalogClassification,
  SlicerCatalogGroups,
  SlicerCatalogProfile,
  SlicerFilamentRule,
} from '../../api/client';
import { catalogSelectionReadiness, pickCatalogFilament, pickCatalogProcess } from '../../utils/catalogSliceSelection';

const classified = (
  profileId: number,
  profileType: 'process' | 'filament',
  displayName: string,
  group: SlicerCatalogClassification['classification']['group'] = 'selected_printer',
): SlicerCatalogClassification => ({
  profile_id: profileId,
  revision_id: profileId,
  profile_type: profileType,
  display_name: displayName,
  source: 'local',
  account_id: 1,
  account_name: null,
  stale: false,
  classification: {
    group,
    compatibility: group === 'unclassified' ? 'unknown' : group === 'selected_printer' ? 'match' : 'mismatch',
    readiness: 'ready',
    reason_codes: [],
    reason_details: [],
    selectable: group === 'selected_printer' || group === 'unclassified',
    auto_selectable: group === 'selected_printer',
    acknowledgement_required: group === 'unclassified',
  },
});
const groups = (selected: SlicerCatalogClassification[], unclassified: SlicerCatalogClassification[] = []): SlicerCatalogGroups => ({
  selected_printer: selected,
  other_installed_printers: [],
  unclassified,
  incompatible: [],
});
const binding: SlicerCatalogBinding = {
  id: 5,
  printer_id: 1,
  printer_name: 'P1S',
  profile_id: 4,
  profile_name: 'P1S 0.4',
  expected_nozzle_diameter: 0.4,
  tool_index: 0,
  default_process_profile_id: 12,
  default_filament_profile_id: 22,
  enforcement_state: 'shadow',
  is_active: true,
  confirmed_at: null,
  readiness: { state: 'ready', reason_codes: [] },
  nozzle: { status: 'confirmed', diameter: 0.4, tool_index: 0 },
};

function profile(profileId: number, material: string): SlicerCatalogProfile {
  return {
    profile_id: profileId,
    revision_id: profileId,
    source: 'local',
    account_id: 1,
    account_name: null,
    remote_profile_id: String(profileId),
    profile_type: 'filament',
    display_name: `${material} profile`,
    content_hash: String(profileId),
    compatibility_metadata: { filament_type: material },
    tombstoned: false,
    stale: false,
    sharing_state: 'shared',
  };
}

describe('catalog slice defaulting', () => {
  it('uses embedded process, then preference, then binding default', () => {
    const choices = groups([
      classified(10, 'process', 'Embedded process'),
      classified(11, 'process', 'Preference'),
      classified(12, 'process', 'Fallback'),
    ]);
    expect(pickCatalogProcess(choices, ' embedded   PROCESS ', 11, 12)).toEqual({
      id: 10,
      reason: 'embedded_process',
      manual: false,
    });
    expect(pickCatalogProcess(choices, null, 11, 12)?.id).toBe(11);
    expect(pickCatalogProcess(choices, null, null, 12)?.id).toBe(12);
  });

  it('matches embedded process names independently of browser locale', () => {
    const localeLower = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function () {
      return String(this).replaceAll('I', 'ı').toLowerCase();
    });

    expect(pickCatalogProcess(
      groups([classified(10, 'process', 'I Process')]),
      'i process',
      null,
      null,
    )).toEqual({ id: 10, reason: 'embedded_process', manual: false });

    localeLower.mockRestore();
  });

  it('never auto-selects an unclassified process', () => {
    expect(pickCatalogProcess(groups([], [classified(13, 'process', 'Unknown', 'unclassified')]), 'Unknown', 13, 13)).toBeNull();
  });

  it('rejects production Dremel and Afinia ordering for the P1S target', () => {
    const p1sProcess = classified(12, 'process', 'P1S process');
    const p1sFilament = classified(22, 'filament', 'P1S filament');
    const choices: SlicerCatalogGroups = {
      selected_printer: [p1sProcess, p1sFilament],
      other_installed_printers: [],
      unclassified: [],
      incompatible: [
        classified(30, 'process', 'Dremel process', 'incompatible'),
        classified(31, 'filament', 'Afinia filament', 'incompatible'),
      ],
    };

    expect(pickCatalogProcess(choices, 'Dremel process', null, 12)).toEqual({
      id: 12,
      reason: 'binding_default',
      manual: false,
    });
    expect(pickCatalogFilament(
      choices,
      [profile(31, 'PLA'), profile(22, 'PLA')],
      [],
      binding,
      { type: 'PLA', color: '' },
      [],
      [],
      null,
    )).toEqual({ id: 22, reason: 'unique_metadata_match', manual: false });
  });

  it('uses an exact stable Spoolman assignment before metadata and fallback', () => {
    const choices = groups([
      classified(20, 'filament', 'Exact PLA'),
      classified(21, 'filament', 'Metadata PLA'),
      classified(22, 'filament', 'Fallback PLA'),
    ]);
    const assignment = {
      printer_id: 1,
      ams_id: 0,
      tray_id: 0,
      spool: { material: 'PLA', rgba: '#ff0000', brand: 'Vendor' },
    } as SpoolAssignment;
    const rule = {
      id: 1,
      scope: 'exact_external',
      filament_profile_id: 20,
      binding_id: 5,
      external_source: 'spoolman',
      external_identity: 'spool:42',
      material_type: null,
      vendor: null,
      nozzle_diameter_min: null,
      nozzle_diameter_max: null,
      is_active: true,
    } as SlicerFilamentRule;

    expect(pickCatalogFilament(
      choices,
      [profile(21, 'PLA')],
      [rule],
      binding,
      { type: 'PLA', color: '#ff0000' },
      [assignment],
      [{ printer_id: 1, ams_id: 0, tray_id: 0, spoolman_spool_id: 42 }],
      22,
    )).toEqual({ id: 20, reason: 'exact_external_assignment', manual: false });
  });

  it('leaves ambiguous metadata unresolved instead of picking list order', () => {
    const choices = groups([
      classified(20, 'filament', 'PLA one'),
      classified(21, 'filament', 'PLA two'),
    ]);
    expect(pickCatalogFilament(
      choices,
      [profile(20, 'PLA'), profile(21, 'PLA')],
      [],
      { ...binding, default_filament_profile_id: null },
      { type: 'PLA', color: '' },
      [],
      [],
      null,
    )).toBeNull();
  });

  it('does not auto-select material metadata from an older revision', () => {
    expect(pickCatalogFilament(
      groups([{ ...classified(20, 'filament', 'Former PLA'), revision_id: 200 }]),
      [profile(20, 'PLA')],
      [],
      { ...binding, default_filament_profile_id: null },
      { type: 'PLA', color: '' },
      [],
      [],
      null,
    )).toBeNull();
  });
});


describe('selected combination readiness', () => {
  const process = classified(12, 'process', 'Process');
  const filaments = [classified(22, 'filament', 'Filament')];
  const noDefaults: SlicerCatalogBinding = {
    ...binding,
    default_process_profile_id: null,
    default_filament_profile_id: null,
    readiness: { state: 'blocked', reason_codes: ['default_unavailable'] },
  };
  const evaluate = (selected = noDefaults) => catalogSelectionReadiness({
    binding: selected, process, filaments, filamentCount: 1,
  });

  it('requires real selections, not fallback defaults', () => {
    expect(evaluate().state).toBe('ready');
    expect(catalogSelectionReadiness({ binding: noDefaults, process: undefined, filaments, filamentCount: 1 }).state).toBe('blocked');
    expect(catalogSelectionReadiness({ binding: noDefaults, process, filaments: [], filamentCount: 1 }).state).toBe('blocked');
  });

  it('does not mask nozzle or tool mismatches with a missing-default error', () => {
    expect(evaluate({ ...noDefaults, nozzle: { ...binding.nozzle, diameter: 0.6 } }).reason_codes).toContain('nozzle_mismatch');
    expect(evaluate({ ...noDefaults, tool_index: 1 }).reason_codes).toContain('tool_mismatch');
  });

  it('preserves unavailable binding and incompatible profile blocks', () => {
    expect(evaluate({ ...noDefaults, readiness: { state: 'blocked', reason_codes: ['profile_unavailable'] } }).state).toBe('blocked');
    expect(catalogSelectionReadiness({ binding, process: classified(30, 'process', 'Other machine', 'incompatible'), filaments, filamentCount: 1 }).state).toBe('blocked');
  });

  it('requires explicit acknowledgement for unknown compatibility and stale telemetry', () => {
    expect(catalogSelectionReadiness({ binding: noDefaults, process: classified(30, 'process', 'Unknown', 'unclassified'), filaments, filamentCount: 1 }).state).toBe('acknowledgement_required');
    expect(evaluate({ ...noDefaults, nozzle: { ...binding.nozzle, status: 'stale' } }).reason_codes).toContain('telemetry_stale');
  });
});
