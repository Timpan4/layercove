import type { SliceResponse } from '../api/client';
import { formatDuration } from '../utils/date';

export function SliceEstimates({ result }: { result: Pick<SliceResponse, 'print_time_seconds' | 'filament_used_g'> }) {
  const time = Number.isFinite(result.print_time_seconds) && result.print_time_seconds > 0
    ? result.print_time_seconds < 60 ? `${result.print_time_seconds}s` : formatDuration(result.print_time_seconds) : 'Unavailable';
  const filament = Number.isFinite(result.filament_used_g) && result.filament_used_g > 0
    ? `${result.filament_used_g} g` : 'Unavailable';

  return <section aria-label="Slice estimates" className="shrink-0 text-sm text-white">
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      <div><dt className="text-bambu-gray-light">Estimated time</dt><dd>{time}</dd></div>
      <div><dt className="text-bambu-gray-light">Estimated filament</dt><dd>{filament}</dd></div>
    </dl>
  </section>;
}
