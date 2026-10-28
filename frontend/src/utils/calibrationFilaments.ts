import type { InventorySpool, SlicerCatalogProfile } from '../api/client';

// Spools keep the slicer preset they were set up with. Ids and full names match
// directly; built-in presets store a base name such as "Bambu PLA Basic", while
// catalog profiles add the printer ("Bambu PLA Basic @BBL P1S").
export function spoolProfileMatches(spool: Pick<InventorySpool, 'slicer_filament' | 'slicer_filament_name'>,
  profiles: SlicerCatalogProfile[], compatibleIds: Set<number>) {
  const code = spool.slicer_filament?.trim();
  const name = spool.slicer_filament_name?.trim();
  const isCompatible = (profile: SlicerCatalogProfile) => compatibleIds.has(profile.profile_id);
  const exact = profiles.filter(profile => (!!code && profile.remote_profile_id === code) || (!!name && profile.display_name === name));
  const variants = name ? profiles.filter(profile => profile.display_name.startsWith(`${name} @`)) : [];
  // Exact matches win, but printer variants still count when no exact match fits the printer profile.
  const candidates = exact.length && (compatibleIds.size === 0 || exact.some(isCompatible)) ? exact : [...exact, ...variants];
  const compatible = candidates.filter(isCompatible);
  return compatible.length ? compatible : exact.length ? exact : candidates;
}
