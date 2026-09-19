import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { QueueDispatchProgress as Progress } from '../api/client';
import { formatFileSize } from '../utils/file';

export function QueueDispatchProgress({ progress }: { progress: Progress }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // REST timestamps are UTC; tolerate older naive timestamps on reconciliation.
  const timestamp = /(?:Z|[+-]\d\d:\d\d)$/.test(progress.stage_started_at)
    ? progress.stage_started_at : `${progress.stage_started_at}Z`;
  const elapsed = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  const percent = progress.total_bytes && progress.bytes_transferred != null
    ? Math.max(0, Math.min(100, progress.bytes_transferred / progress.total_bytes * 100)) : null;
  const label = progress.stage === 'preparing' ? 'Preparing transfer'
    : progress.stage === 'uploading' ? 'Uploading to printer' : 'Waiting for printer confirmation';
  return <div className="mt-2 space-y-1 text-xs text-bambu-gray-light" role="status" aria-label="Print dispatch progress">
    <div className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>{label}</span>{Number.isFinite(elapsed) && <span className="ml-auto">{elapsed}s</span>}
    </div>
    {progress.stage === 'uploading' && percent !== null && <>
      <div role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} className="h-1.5 overflow-hidden rounded bg-bambu-dark-tertiary">
        <div className="h-full bg-bambu-green transition-all" style={{ width: `${percent}%` }} />
      </div>
      <span>{formatFileSize(progress.bytes_transferred ?? 0)} / {formatFileSize(progress.total_bytes!)} ({Math.round(percent)}%)</span>
      {percent === 100 && <p>File sent; waiting for the upload response.</p>}
    </>}
    {progress.stage === 'awaiting_printer' && <p>Upload accepted. The print start has not yet been confirmed.</p>}
  </div>;
}
