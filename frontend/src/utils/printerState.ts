export type NormalizedPrintState = 'preparing' | 'printing' | 'paused' | 'finished' | 'failed' | 'idle';

export function normalizePrintState(state: string | null | undefined): NormalizedPrintState {
  switch (state?.toUpperCase()) {
    case 'RUNNING':
    case 'PRINTING':
      return 'printing';
    case 'PREPARING':
    case 'PREPARE':
    case 'SLICING':
      return 'preparing';
    case 'PAUSE':
    case 'PAUSED':
      return 'paused';
    case 'FINISH':
    case 'FINISHED':
    case 'COMPLETE':
    case 'COMPLETED':
    case 'CANCELLED':
    case 'CANCELED':
    case 'STOPPED':
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
  return normalized === 'preparing' || normalized === 'printing' || normalized === 'paused';
}
