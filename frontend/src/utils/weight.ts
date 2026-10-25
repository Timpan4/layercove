export function formatWeight(grams: number): string {
  if (grams >= 1_000_000) {
    const tonnes = grams / 1_000_000;
    return `${tonnes % 1 === 0 ? tonnes.toFixed(0) : tonnes.toFixed(1)}t`;
  }
  if (grams >= 1000) {
    const kg = grams / 1000;
    return `${kg % 1 === 0 ? kg.toFixed(0) : kg.toFixed(1)}kg`;
  }
  return `${Math.round(grams)}g`;
}

// Archives store 0 g for prints archived without a 3MF, so filament totals fall
// back to spool consumption. Pass undefined for spoolGrams where the spool counters
// do not apply. Null means no source has any weight.
export function resolveFilamentGrams(archiveGrams: number, spoolGrams: number | undefined): { grams: number; fromSpool: boolean } | null {
  if (archiveGrams > 0) return { grams: archiveGrams, fromSpool: false };
  if (spoolGrams !== undefined && spoolGrams > 0) return { grams: spoolGrams, fromSpool: true };
  return null;
}
