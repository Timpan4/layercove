import type { InventorySpool, SlicerCatalogProfile } from '../api/client';

// Spools keep the slicer preset they were set up with. Ids and full names match
// directly; built-in presets store a base name such as "Bambu PLA Basic", while
// catalog profiles add the printer ("Bambu PLA Basic @BBL P1S").
export function spoolProfileMatches(spool: Pick<InventorySpool, 'slicer_filament' | 'slicer_filament_name'>,
  profiles: SlicerCatalogProfile[], compatibleIds: Set<number>) {
  const code = spool.slicer_filament?.trim();
  const name = spool.slicer_filament_name?.trim();
  const exact = profiles.filter(profile => (!!code && profile.remote_profile_id === code) || (!!name && profile.display_name === name));
  const candidates = exact.length ? exact : name ? profiles.filter(profile => profile.display_name.startsWith(`${name} @`)) : [];
  const compatible = candidates.filter(profile => compatibleIds.has(profile.profile_id));
  return compatible.length ? compatible : candidates;
}
