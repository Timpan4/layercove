import { describe, expect, it } from 'vitest';
import type { SlicerContractIdentity } from '../../api/client';
import {
  canonicalRequest,
  shouldRefreshSlicerSchema,
} from '../../features/slicer-workbench/useSlicerWorkbench';
import {
  parsePositiveInteger,
  resolveWorkbenchSource,
  supportsSlicerWorkbench,
} from '../../features/slicer-workbench/source';

describe('slicer workbench route source', () => {
  it('accepts exactly one positive safe source id', () => {
    expect(resolveWorkbenchSource(new URLSearchParams('archive=12'))).toEqual({ kind: 'archive', id: 12 });
    expect(resolveWorkbenchSource(new URLSearchParams('library_file=7'))).toEqual({ kind: 'libraryFile', id: 7 });
  });

  it.each(['', 'archive=0', 'archive=-1', 'archive=nope', 'archive=1&library_file=2'])(
    'rejects malformed source query %s',
    (query) => expect(resolveWorkbenchSource(new URLSearchParams(query))).toBeNull(),
  );

  it('rejects unsafe integer ids', () => {
    expect(parsePositiveInteger(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });
});


describe('slicer workbench capability gate', () => {
  const contract: SlicerContractIdentity = {
    contract_version: '1',
    engine: { name: 'OrcaSlicer', version: '2.4.2', commit: 'pinned' },
    image_identity: { digest: `sha256:${'a'.repeat(64)}` },
    schema_hash: 'b'.repeat(64),
    capabilities: { process_schema: true, model_state: true, progress: true, cancel: false },
    supported_scopes: ['global', 'object'],
  };

  it('requires process schema and model state support', () => {
    expect(supportsSlicerWorkbench(contract)).toBe(true);
    expect(supportsSlicerWorkbench({
      ...contract,
      capabilities: { ...contract.capabilities, model_state: false },
    })).toBe(false);
  });

  it('refreshes only failed schema-mismatch jobs', () => {
    expect(shouldRefreshSlicerSchema({ status: 'failed', error_code: 'slicer_schema_mismatch' })).toBe(true);
    expect(shouldRefreshSlicerSchema({ status: 'failed', error_code: 'slice_failed' })).toBe(false);
    expect(shouldRefreshSlicerSchema({ status: 'running', error_code: null })).toBe(false);
  });
});

describe('canonicalRequest', () => {
  it('is stable across object key order', () => {
    const left = canonicalRequest({
      schema_hash: 'a'.repeat(64),
      printer_preset: { source: 'local', id: '1' },
      process_preset: { source: 'local', id: '2' },
      filament_preset: { source: 'local', id: '3' },
    });
    const right = canonicalRequest({
      filament_preset: { id: '3', source: 'local' },
      process_preset: { id: '2', source: 'local' },
      printer_preset: { id: '1', source: 'local' },
      schema_hash: 'a'.repeat(64),
    });
    expect(left).toBe(right);
  });

  it('omits model-state defaults like backend fingerprinting', () => {
    const request = canonicalRequest({
      printer_preset: { source: 'local', id: '1' },
      process_preset: { source: 'local', id: '2' },
      filament_preset: { source: 'local', id: '3' },
      filament_presets: [{ source: 'local', id: '3' }],
      schema_hash: 'a'.repeat(64),
      model_state: {
        objects: [{ id: 'part-1', overrides: {} }],
        hidden_object_ids: [],
        lay_flat_object_ids: [],
        arrange: false,
      },
    });

    expect(JSON.parse(request).model_state).toEqual({ objects: [{ id: 'part-1' }] });
  });
});
