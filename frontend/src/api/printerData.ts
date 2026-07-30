export function reducePrinterStatus(
  old: Record<string, unknown> | undefined,
  update: Record<string, unknown>,
) {
  const merged = { ...old, ...update };
  if (merged.wifi_signal == null && old?.wifi_signal != null) {
    merged.wifi_signal = old.wifi_signal;
  }
  return merged;
}
