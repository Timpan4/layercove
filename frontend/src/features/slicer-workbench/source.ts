import type { SlicerContractIdentity } from '../../api/client';
import type { WorkbenchSource } from './useSlicerWorkbench';

export function supportsSlicerWorkbench(contract: SlicerContractIdentity | undefined): boolean {
  return contract?.capabilities.process_schema === true && contract.capabilities.model_state === true;
}

export function parsePositiveInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveWorkbenchSource(params: URLSearchParams): WorkbenchSource | null {
  const archive = parsePositiveInteger(params.get('archive'));
  const libraryFile = parsePositiveInteger(params.get('library_file'));
  if ((archive === null) === (libraryFile === null)) return null;
  return archive !== null ? { kind: 'archive', id: archive } : { kind: 'libraryFile', id: libraryFile! };
}
