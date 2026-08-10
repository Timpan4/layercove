import { describe, expect, it } from 'vitest';
import type {
  SpoolAssignment,
  SlicerCatalogBinding,
  SlicerCatalogClassification,
  SlicerCatalogGroups,
  SlicerCatalogProfile,
  SlicerFilamentRule,
} from '../../api/client';
import { pickCatalogFilament, pickCatalogProcess } from '../../utils/catalogSliceSelection';

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
});
