export const queryKeys = {
  printerStatus: (printerId: number | null) => ['printerStatus', printerId] as const,
  archiveStats: () => ['archiveStats'] as const,
  archiveStatsForRange: (dateFrom: string | undefined, dateTo: string | undefined, createdById: number | 'all') =>
    [...queryKeys.archiveStats(), dateFrom, dateTo, createdById] as const,
};
