import type { TFunction } from 'i18next';

// Spool consumption that stands in for archive weight. Only the all-time, all-users view has one, and it is
// unavailable while the spools are still loading or when the viewer cannot read the inventory.
export type SpoolFallback =
  | { status: 'ready'; grams: number; gramsByMaterial: Map<string, number> }
  | { status: 'unavailable' };

export function spoolFallbackGrams(fallback: SpoolFallback | undefined): number | undefined {
  return fallback?.status === 'ready' ? fallback.grams : undefined;
}

// The label shown in place of a weight when no source reports one.
export function untrackedFilamentLabel(t: TFunction, fallback: SpoolFallback | undefined): string {
  if (!fallback) return t('stats.notTrackedForRange');
  return fallback.status === 'ready' ? t('stats.notTracked') : t('stats.spoolsUnavailable');
}
