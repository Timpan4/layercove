export type NormalizedPrintState = 'printing' | 'paused' | 'finished' | 'failed' | 'idle';

export function normalizePrintState(state: string | null | undefined): NormalizedPrintState {
  switch (state?.toUpperCase()) {
    case 'RUNNING':
    case 'PRINTING':
      return 'printing';
    case 'PAUSE':
    case 'PAUSED':
      return 'paused';
    case 'FINISH':
    case 'FINISHED':
    case 'COMPLETE':
    case 'COMPLETED':
      return 'finished';
    case 'FAILED':
    case 'ERROR':
      return 'failed';
    default:
      return 'idle';
  }
}

export function isActivePrintState(state: string | null | undefined): boolean {
  const normalized = normalizePrintState(state);
  return normalized === 'printing' || normalized === 'paused';
}
