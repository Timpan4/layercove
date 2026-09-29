import { useQuery } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { api, spoolbuddyApi } from './client';
import type { InventorySpool, SpoolKProfileInput, SpoolmanBulkCreateResult } from './client';

export type InventorySource = 'local' | 'spoolman';
type SpoolData = Omit<InventorySpool, 'id' | 'archived_at' | 'created_at' | 'updated_at' | 'k_profiles'>;
type BulkResult = { not_found?: number[]; errors?: Array<{ id: number; status: number; detail: string }> };

export const inventoryQueryKeys = {
  settings: ['spoolman-settings'] as const,
  locations: ['inventory-locations'] as const,
  spools: (source: InventorySource) => [source === 'spoolman' ? 'spoolman-inventory-spools' : 'inventory-spools'] as const,
  spool: (source: InventorySource, id: number | null) => [source === 'spoolman' ? 'spoolman-inventory-spool' : 'inventory-spool', id] as const,
  assignments: ['spool-assignments'] as const,
  spoolmanAssignments: ['spoolman-slot-assignments-all'] as const,
  spoolmanAssignmentSlots: ['spoolman-slot-assignments'] as const,
  spoolmanFilaments: ['spoolman-inventory-filaments'] as const,
};

export function useInventorySource() {
  const query = useQuery({
    queryKey: inventoryQueryKeys.settings,
    queryFn: api.getSpoolmanSettings,
    staleTime: 5 * 60 * 1000,
  });
  return {
    source: query.data?.spoolman_enabled === 'true' && !!query.data.spoolman_url ? 'spoolman' as const : 'local' as const,
    isReady: query.data !== undefined,
  };
}

const localInventory = {
  source: 'local' as const,
  supports: { coreWeight: true, usageHistory: true, filamentCatalog: false },
  getSpools: () => api.getSpools(true),
  getSpool: api.getSpool,
  create: (data: SpoolData) => api.createSpool(data),
  bulkCreate: (data: SpoolData, quantity: number) => api.bulkCreateSpools(data, quantity),
  update: (id: number, data: Partial<SpoolData>) => api.updateSpool(id, data),
  delete: api.deleteSpool,
  archive: api.archiveSpool,
  restore: api.restoreSpool,
  resetConsumed: api.resetSpoolConsumedCounter,
  bulkResetConsumed: api.bulkResetSpoolConsumedCounter,
  bulkUpdate: api.bulkUpdateSpools,
  bulkDelete: api.bulkDeleteSpools,
  bulkArchive: api.bulkArchiveSpools,
  bulkRestore: api.bulkRestoreSpools,
  saveKProfiles: api.saveSpoolKProfiles,
  unassign: (_spoolId: number, assignment?: { printer_id: number; ams_id: number; tray_id: number }) => {
    if (!assignment) return Promise.reject(new Error('No assignment'));
    return api.unassignSpool(assignment.printer_id, assignment.ams_id, assignment.tray_id);
  },
  syncWeight: spoolbuddyApi.updateSpoolWeight,
};

const spoolmanInventory = {
  source: 'spoolman' as const,
  supports: { coreWeight: false, usageHistory: false, filamentCatalog: true },
  getSpools: () => api.getSpoolmanInventorySpools(true),
  getSpool: api.getSpoolmanInventorySpool,
  create: (data: SpoolData) => api.createSpoolmanInventorySpool(data),
  bulkCreate: (data: SpoolData, quantity: number) => api.bulkCreateSpoolmanInventorySpools(data, quantity),
  update: (id: number, data: Partial<SpoolData>) => api.updateSpoolmanInventorySpool(id, data),
  delete: api.deleteSpoolmanInventorySpool,
  archive: api.archiveSpoolmanInventorySpool,
  restore: api.restoreSpoolmanInventorySpool,
  resetConsumed: api.resetSpoolmanInventorySpoolConsumedCounter,
  bulkResetConsumed: api.bulkResetSpoolmanInventorySpoolConsumedCounter,
  bulkUpdate: api.bulkUpdateSpoolmanInventorySpools,
  bulkDelete: api.bulkDeleteSpoolmanInventorySpools,
  bulkArchive: api.bulkArchiveSpoolmanInventorySpools,
  bulkRestore: api.bulkRestoreSpoolmanInventorySpools,
  saveKProfiles: api.saveSpoolmanKProfiles,
  unassign: (spoolId: number) => api.unassignSpoolmanSlot(spoolId),
  syncWeight: api.syncSpoolmanSpoolWeight,
};

export function inventoryData(source: InventorySource) {
  return source === 'spoolman' ? spoolmanInventory : localInventory;
}

export function normalizeBulkCreate(result: InventorySpool[] | SpoolmanBulkCreateResult) {
  if ('created' in result) {
    return { created: result.created, requested: result.requested_count, failed: result.failed_count };
  }
  return { created: result, requested: result.length, failed: 0 };
}

export function failedBulkCount(result: BulkResult) {
  return (result.not_found?.length ?? 0) + (result.errors?.length ?? 0);
}

export function invalidateInventory(queryClient: QueryClient, source: InventorySource, includeLocations = true) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.spools(source) }),
    ...(includeLocations ? [queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.locations })] : []),
  ]);
}

export function invalidateInventoryLocations(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.locations });
}

export function invalidateInventoryAssignments(queryClient: QueryClient, source: InventorySource) {
  return source === 'spoolman'
    ? Promise.all([
      queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.spoolmanAssignments }),
      queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.spoolmanAssignmentSlots }),
    ])
    : queryClient.invalidateQueries({ queryKey: inventoryQueryKeys.assignments });
}

export type InventoryDisplayItem =
  | { type: 'single'; spool: InventorySpool }
  | { type: 'group'; key: string; spools: InventorySpool[]; representative: InventorySpool };

export function inventoryGroupKey(spool: InventorySpool) {
  return `${spool.material}|${spool.subtype || ''}|${spool.brand || ''}|${spool.color_name || ''}|${spool.rgba || ''}|${spool.extra_colors || ''}|${spool.effect_type || ''}|${spool.label_weight}`;
}

export function groupInventorySpools(spools: InventorySpool[], assignedIds: Record<number, unknown>): InventoryDisplayItem[] {
  const groups = new Map<string, InventorySpool[]>();
  for (const spool of spools) {
    if (spool.weight_used > 0 || assignedIds[spool.id]) continue;
    const key = inventoryGroupKey(spool);
    groups.set(key, [...(groups.get(key) ?? []), spool]);
  }
  const seen = new Set<string>();
  return spools.flatMap((spool): InventoryDisplayItem[] => {
    if (spool.weight_used > 0 || assignedIds[spool.id]) return [{ type: 'single' as const, spool }];
    const key = inventoryGroupKey(spool);
    if (seen.has(key)) return [];
    seen.add(key);
    const members = groups.get(key)!;
    return members.length === 1
      ? [{ type: 'single' as const, spool: members[0] }]
      : [{ type: 'group' as const, key, spools: members, representative: members[0] }];
  });
}

export function aggregateInventoryGroup(spools: InventorySpool[]): InventorySpool {
  const base = spools[0];
  return spools.reduce((aggregate, spool) => ({
    ...aggregate,
    label_weight: aggregate.label_weight + spool.label_weight,
    weight_used: aggregate.weight_used + spool.weight_used,
    core_weight: aggregate.core_weight + spool.core_weight,
  }), { ...base, label_weight: 0, weight_used: 0, core_weight: 0 });
}

export type { SpoolData, SpoolKProfileInput };
