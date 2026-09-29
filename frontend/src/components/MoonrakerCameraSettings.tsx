import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Loader2, RefreshCw, RotateCw, Trash2, Undo2 } from 'lucide-react';
import { api, type Printer, type PrinterCamera, type PrinterCameraUpdate } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

interface Props {
  printer: Printer;
}

export function MoonrakerCameraSettings({ printer }: Props) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { authEnabled, hasPermission } = useAuth();
  const canUpdate = !authEnabled || hasPermission('printers:update');
  const [error, setError] = useState<string | null>(null);
  const [manualEdits, setManualEdits] = useState<Record<number, PrinterCameraUpdate>>({});
  const queryKey = ['printerCameras', printer.id, canUpdate ? 'history' : 'active'];
  const { data: cameras = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => api.listPrinterCameras(printer.id, canUpdate),
  });

  const refresh = useMutation({
    mutationFn: () => api.syncPrinterCameras(printer.id),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['printerCameras', printer.id] });
    },
    onError: (cause: Error) => setError(cause.message),
  });
  const update = useMutation({
    mutationFn: ({ camera, patch }: { camera: PrinterCamera; patch: PrinterCameraUpdate }) =>
      api.updatePrinterCamera(printer.id, camera.id, patch),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['printerCameras', printer.id] });
    },
    onError: (cause: Error) => setError(cause.message),
  });
  const restore = useMutation({
    mutationFn: (camera: PrinterCamera) => api.restorePrinterCameraAsManual(printer.id, camera.id),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['printerCameras', printer.id] });
    },
    onError: (cause: Error) => setError(cause.message),
  });
  const remove = useMutation({
    mutationFn: (camera: PrinterCamera) => api.deletePrinterCamera(printer.id, camera.id),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['printerCameras', printer.id] });
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const active = cameras.filter((camera) => !camera.history);
  const history = cameras.filter((camera) => camera.history);

  const cameraRow = (camera: PrinterCamera) => {
    const compatible = camera.supported_live || camera.snapshot_available;
    return (
      <div key={camera.id} className="space-y-2 rounded border border-bambu-dark-tertiary p-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-white">{camera.name}</div>
            <div className="text-[11px] text-bambu-gray">
              {[camera.source, camera.service, camera.location].filter(Boolean).join(' · ')}
            </div>
          </div>
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${compatible ? 'bg-bambu-green/20 text-bambu-green' : 'bg-amber-500/20 text-amber-400'}`}>
            {compatible ? camera.camera_type : t('camera.moonraker.unsupported')}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-bambu-gray">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={`primary-camera-${printer.id}`}
              checked={camera.is_primary}
              disabled={!canUpdate || !compatible || !camera.available}
              onChange={() => update.mutate({ camera, patch: { is_primary: true } })}
            />
            {t('camera.moonraker.primary')}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={camera.enabled}
              disabled={!canUpdate}
              onChange={(event) => update.mutate({ camera, patch: { enabled: event.target.checked } })}
            />
            {t('common.enabled')}
          </label>
          <label className="flex items-center gap-1">
            <RotateCw className="h-3 w-3" />
            <select
              value={camera.rotation}
              disabled={!canUpdate}
              onChange={(event) => update.mutate({
                camera,
                patch: { rotation: Number(event.target.value) as 0 | 90 | 180 | 270 },
              })}
              className="rounded bg-bambu-dark-secondary px-1 py-0.5 text-white"
            >
              {[0, 90, 180, 270].map((rotation) => <option key={rotation} value={rotation}>{rotation}°</option>)}
            </select>
          </label>
          {!camera.available && <span className="text-amber-400">{t('camera.unavailable')}</span>}
          {!camera.source_enabled && <span className="text-amber-400">{t('camera.moonraker.disabledInMoonraker')}</span>}
        </div>
        {canUpdate && camera.source === 'manual' && (
          <details className="text-xs text-bambu-gray">
            <summary className="cursor-pointer">{t('camera.moonraker.editManual')}</summary>
            <div className="mt-2 space-y-2">
              <input
                aria-label={t('common.name')}
                placeholder={camera.name}
                value={manualEdits[camera.id]?.name ?? ''}
                onChange={(event) => setManualEdits((edits) => ({ ...edits, [camera.id]: { ...edits[camera.id], name: event.target.value } }))}
                className="w-full rounded bg-bambu-dark-secondary px-2 py-1 text-white"
              />
              <input
                aria-label={t('camera.moonraker.streamUrl')}
                placeholder={t('camera.moonraker.newStreamOrSnapshotUrl')}
                value={manualEdits[camera.id]?.stream_url ?? ''}
                onChange={(event) => setManualEdits((edits) => ({ ...edits, [camera.id]: { ...edits[camera.id], stream_url: event.target.value } }))}
                className="w-full rounded bg-bambu-dark-secondary px-2 py-1 text-white"
              />
              <input
                aria-label={t('camera.moonraker.snapshotUrl')}
                placeholder={t('camera.moonraker.newSnapshotUrl')}
                value={manualEdits[camera.id]?.snapshot_url ?? ''}
                onChange={(event) => setManualEdits((edits) => ({ ...edits, [camera.id]: { ...edits[camera.id], snapshot_url: event.target.value } }))}
                className="w-full rounded bg-bambu-dark-secondary px-2 py-1 text-white"
              />
              <select
                aria-label={t('common.type')}
                value={manualEdits[camera.id]?.camera_type ?? camera.camera_type}
                onChange={(event) => setManualEdits((edits) => ({
                  ...edits,
                  [camera.id]: { ...edits[camera.id], camera_type: event.target.value as 'mjpeg' | 'rtsp' | 'snapshot' },
                }))}
                className="w-full rounded bg-bambu-dark-secondary px-2 py-1 text-white"
              >
                <option value="mjpeg">MJPEG</option>
                <option value="rtsp">RTSP</option>
                <option value="snapshot">Snapshot</option>
              </select>
              <button
                type="button"
                disabled={!Object.keys(manualEdits[camera.id] ?? {}).length}
                onClick={() => update.mutate({ camera, patch: manualEdits[camera.id] ?? {} })}
                className="rounded bg-bambu-green px-2 py-1 text-black disabled:opacity-40"
              >
                {t('common.save')}
              </button>
            </div>
          </details>
        )}
        {canUpdate && camera.source === 'manual' && (
          <button type="button" onClick={() => remove.mutate(camera)} className="flex items-center gap-1 text-xs text-red-400">
            <Trash2 className="h-3 w-3" /> {t('common.remove')}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3 rounded-lg bg-bambu-dark p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-white">{printer.name}</div>
          <div className="text-xs text-bambu-gray">{t('camera.moonraker.title')}</div>
        </div>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={!canUpdate || refresh.isPending}
          className="flex items-center gap-1 rounded bg-bambu-dark-secondary px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          {refresh.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {t('camera.moonraker.refresh')}
        </button>
      </div>
      {error && <div className="rounded bg-red-500/10 px-2 py-1 text-xs text-red-400">{error}</div>}
      {isLoading ? (
        <div className="text-xs text-bambu-gray">{t('common.loading')}</div>
      ) : active.length ? (
        <div className="space-y-2">{active.map(cameraRow)}</div>
      ) : (
        <div className="text-xs text-bambu-gray">{t('camera.moonraker.noCameras')}</div>
      )}
      {history.length > 0 && (
        <details className="border-t border-bambu-dark-tertiary pt-2">
          <summary className="flex cursor-pointer items-center gap-1 text-xs text-bambu-gray">
            <History className="h-3 w-3" /> {t('camera.moonraker.history', { count: history.length })}
          </summary>
          <div className="mt-2 space-y-2">
            {history.map((camera) => (
              <div key={camera.id} className="rounded border border-bambu-dark-tertiary p-2 text-xs">
                <div className="font-medium text-white">{camera.name}</div>
                <div className="text-bambu-gray">{t('camera.moonraker.lastSeen', { date: new Date(camera.last_seen_at).toLocaleString() })}</div>
                <div className="mt-2 flex gap-3">
                  <button type="button" onClick={() => restore.mutate(camera)} className="flex items-center gap-1 text-bambu-green">
                    <Undo2 className="h-3 w-3" /> {t('camera.moonraker.restoreAsManual')}
                  </button>
                  <button type="button" onClick={() => remove.mutate(camera)} className="flex items-center gap-1 text-red-400">
                    <Trash2 className="h-3 w-3" /> {t('camera.moonraker.removeHistory')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
