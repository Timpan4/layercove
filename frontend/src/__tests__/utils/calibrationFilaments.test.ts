import { describe, expect, it } from 'vitest';
import type { SlicerCatalogProfile } from '../../api/client';
import { spoolProfileMatches } from '../../utils/calibrationFilaments';

const profile = (profile_id: number, display_name: string, remote_profile_id = `remote-${profile_id}`) =>
  ({ profile_id, display_name, remote_profile_id }) as SlicerCatalogProfile;
const profiles = [
  profile(1, 'Bambu PLA Basic @BBL X1C'),
  profile(2, 'Bambu PLA Basic @BBL P1S'),
  profile(3, 'My cloud PETG', 'PFUS0123'),
  profile(4, 'Bambu PLA Basic Silk @BBL P1S'),
];

describe('spoolProfileMatches', () => {
  it('matches a stored preset id exactly', () => {
    expect(spoolProfileMatches({ slicer_filament: 'PFUS0123', slicer_filament_name: 'Other name' }, profiles, new Set()))
      .toEqual([profiles[2]]);
  });

  it('expands a built-in base name to its printer variants without matching longer names', () => {
    expect(spoolProfileMatches({ slicer_filament: 'GFSA00', slicer_filament_name: 'Bambu PLA Basic' }, profiles, new Set()))
      .toEqual([profiles[0], profiles[1]]);
  });

  it('keeps only the variants compatible with the chosen printer profile', () => {
    expect(spoolProfileMatches({ slicer_filament: 'GFSA00', slicer_filament_name: 'Bambu PLA Basic' }, profiles, new Set([2])))
      .toEqual([profiles[1]]);
  });

  it('finds nothing for a spool without a catalog preset', () => {
    expect(spoolProfileMatches({ slicer_filament: null, slicer_filament_name: null }, profiles, new Set())).toEqual([]);
  });
});
