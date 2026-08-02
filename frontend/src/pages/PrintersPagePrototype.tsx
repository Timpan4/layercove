import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Box,
  ChevronRight,
  Clock3,
  DoorOpen,
  HardDrive,
  Layers3,
  MapPin,
  Plus,
  Printer as PrinterIcon,
  Radio,
  Search,
  Thermometer,
  VideoOff,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import type { Printer, PrinterStatus } from '../api/client';
import { getPrinterImage } from '../utils/printer';
import { CameraTile } from '../components/CameraTile';
import { filterKnownHMSErrors } from '../components/HMSErrorModal';
import './printers-prototype.css';

type SortOption = 'name' | 'status' | 'model' | 'location' | 'eta';
type PrototypeVariant = 'a' | 'b' | 'c' | 'd';
type PrinterState = 'printing' | 'paused' | 'finished' | 'idle' | 'offline' | 'problem';

export interface PrototypePrinter {
  printer: Printer;
  status?: PrinterStatus;
}

interface PrintersPagePrototypeProps {
  printers: PrototypePrinter[];
  totalPrinters: number;
  isLoading: boolean;
  search: string;
  statusFilter: string;
  locationFilter: string;
  availableLocations: string[];
  hideOffline: boolean;
  sortBy: SortOption;
  canAdd: boolean;
  onSearchChange: (value: string) => void;
  onStatusFilterChange: (value: string) => void;
  onLocationFilterChange: (value: string) => void;
  onHideOfflineChange: () => void;
  onSortChange: (value: SortOption) => void;
  onAddPrinter?: () => void;
  onOpenControls?: (printerId: number) => void;
  production?: boolean;
}

const variants: Array<{ key: PrototypeVariant; name: string }> = [
  { key: 'a', name: 'Command Drawer' },
  { key: 'b', name: 'Inline Deck' },
  { key: 'c', name: 'Focus Banner' },
  { key: 'd', name: 'Command Deck' },
];

const stateMeta: Record<PrinterState, { label: string; dot: string; chip: string }> = {
  printing: { label: 'Printing', dot: 'bg-bambu-green', chip: 'border-bambu-green/30 bg-bambu-green/10 text-bambu-green' },
  paused: { label: 'Paused', dot: 'bg-amber-400', chip: 'border-amber-400/30 bg-amber-400/10 text-amber-300' },
  finished: { label: 'Finished', dot: 'bg-blue-400', chip: 'border-blue-400/30 bg-blue-400/10 text-blue-300' },
  idle: { label: 'Ready', dot: 'bg-emerald-400', chip: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' },
  offline: { label: 'Offline', dot: 'bg-zinc-500', chip: 'border-white/10 bg-white/5 text-zinc-400' },
  problem: { label: 'Needs attention', dot: 'bg-red-400', chip: 'border-red-400/30 bg-red-400/10 text-red-300' },
};

function getState(status?: PrinterStatus, supportsHms = true): PrinterState {
  if (!status?.connected) return 'offline';
  if (supportsHms && status.hms_errors && filterKnownHMSErrors(status.hms_errors).length) return 'problem';
  const state = status.state?.toLowerCase() ?? '';
  if (state.includes('pause')) return 'paused';
  if (state.includes('print') || state.includes('prepare')) return 'printing';
  if (state.includes('finish') || state.includes('complete') || state.includes('fail')) return 'finished';
  return 'idle';
}

function formatTime(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return 'Ready now';
  const hours = Math.floor(minutes / 60);
  const remaining = Math.round(minutes % 60);
  return hours ? `${hours}h ${remaining}m left` : `${remaining}m left`;
}

function StatusChip({ status, supportsHms }: { status?: PrinterStatus; supportsHms: boolean }) {
  const state = getState(status, supportsHms);
  const meta = stateMeta[state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6875rem] font-semibold tracking-[0.01em] ${meta.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${state === 'printing' ? 'animate-pulse' : ''}`} />
      {meta.label}
    </span>
  );
}

function SearchField({ value, onChange, className = '' }: { value: string; onChange: (value: string) => void; className?: string }) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">Search printers</span>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bambu-gray" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search printers"
        className="h-10 w-full rounded-xl border border-white/10 bg-black/25 pl-9 pr-3 text-sm text-white outline-none transition placeholder:text-bambu-gray/70 focus:border-bambu-green/70 focus:ring-2 focus:ring-bambu-green/15"
      />
    </label>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="relative">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 appearance-none rounded-xl border border-white/10 bg-black/25 py-0 pl-3 pr-8 text-sm font-medium text-white outline-none transition focus:border-bambu-green/70 focus:ring-2 focus:ring-bambu-green/15"
      >
        {children}
      </select>
      <ChevronRight className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-90 text-bambu-gray" />
    </label>
  );
}

function FilterCluster(props: PrintersPagePrototypeProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect label="Status" value={props.statusFilter} onChange={props.onStatusFilterChange}>
        <option value="all">All statuses</option>
        <option value="printing">Printing</option>
        <option value="paused">Paused</option>
        <option value="idle">Ready</option>
        <option value="finished">Finished</option>
        <option value="error">Needs attention</option>
        <option value="offline">Offline</option>
      </FilterSelect>
      {props.availableLocations.length > 0 && (
        <FilterSelect label="Location" value={props.locationFilter} onChange={props.onLocationFilterChange}>
          <option value="all">All locations</option>
          {props.availableLocations.map((location) => <option key={location} value={location}>{location}</option>)}
        </FilterSelect>
      )}
      <FilterSelect label="Sort" value={props.sortBy} onChange={(value) => props.onSortChange(value as SortOption)}>
        <option value="name">Name</option>
        <option value="status">Status</option>
        <option value="model">Model</option>
        <option value="location">Location</option>
        <option value="eta">Availability</option>
      </FilterSelect>
      <button
        type="button"
        aria-pressed={props.hideOffline}
        onClick={props.onHideOfflineChange}
        className={`lc-pressable h-10 rounded-xl border px-3 text-sm font-medium ${props.hideOffline ? 'border-bambu-green/50 bg-bambu-green/15 text-bambu-green' : 'border-white/10 bg-black/25 text-white'}`}
      >
        {props.hideOffline ? 'Offline hidden' : 'Hide offline'}
      </button>
    </div>
  );
}

function ReadOnlyAction({ children, onAction, primary = false, disabled = false }: { children: React.ReactNode; onAction: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onAction}
      className={`lc-pressable inline-flex h-10 items-center justify-center gap-2 rounded-xl border px-3.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-45 ${primary ? 'border-bambu-green/70 bg-bambu-green text-white shadow-[0_10px_28px_rgba(124,80,255,0.2)]' : 'border-white/10 bg-white/5 text-white'}`}
    >
      {children}
    </button>
  );
}

function Summary({ printers }: { printers: PrototypePrinter[] }) {
  const counts = useMemo(() => printers.reduce<Record<PrinterState, number>>((result, item) => {
    result[getState(item.status, item.printer.provider !== 'moonraker')] += 1;
    return result;
  }, { printing: 0, paused: 0, finished: 0, idle: 0, offline: 0, problem: 0 }), [printers]);

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-bambu-gray">
      {(Object.keys(stateMeta) as PrinterState[]).map((state) => counts[state] > 0 && (
        <span key={state} className="inline-flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${stateMeta[state].dot}`} />
          <strong className="font-semibold text-white">{counts[state]}</strong> {stateMeta[state].label.toLowerCase()}
        </span>
      ))}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl bg-black/25 px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-medium text-bambu-gray">{icon}{label}</div>
      <div className="text-sm font-semibold tabular-nums text-white">{value}</div>
    </div>
  );
}

function PrinterSnapshotCard({
  item,
  onAction,
  onInspect,
  selected = false,
  portrait = false,
}: {
  item: PrototypePrinter;
  onAction: () => void;
  onInspect?: () => void;
  selected?: boolean;
  portrait?: boolean;
}) {
  const { printer, status } = item;
  const state = getState(status, printer.provider !== 'moonraker');
  const progress = Math.round(status?.progress ?? 0);
  const active = state === 'printing' || state === 'paused';
  const printName = status?.current_print || status?.gcode_file || (state === 'finished' ? 'Print finished' : 'No active job');
  const temperatures = status?.temperatures;
  const amsSlots = status?.ams?.reduce((count, unit) => count + (unit.tray?.filter((tray) => tray.tray_type).length ?? 0), 0) ?? 0;
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!onInspect || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onInspect();
  };

  return (
    <article
      role={onInspect ? 'button' : undefined}
      tabIndex={onInspect ? 0 : undefined}
      aria-label={onInspect ? `Inspect ${printer.name}` : undefined}
      aria-current={onInspect && selected ? 'true' : undefined}
      onClick={onInspect}
      onKeyDown={handleKeyDown}
      className={`lc-printer-card lc-glass group flex flex-col overflow-hidden rounded-[1.375rem] border p-4 shadow-[0_24px_60px_rgba(0,0,0,0.24)] ${portrait ? 'min-h-[32rem]' : 'min-h-[25rem]'} ${onInspect ? 'cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green focus-visible:ring-offset-2 focus-visible:ring-offset-bambu-dark' : ''} ${selected ? 'border-bambu-green/60 ring-2 ring-bambu-green/15' : 'border-white/10'}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-black/30 p-2 ring-1 ring-white/5">
          <img src={getPrinterImage(printer.model)} alt="" className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.04]" />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="mb-1 flex items-start justify-between gap-2">
            <h2 className="truncate text-[1.0625rem] font-semibold tracking-[-0.015em] text-white">{printer.name}</h2>
            <StatusChip status={status} supportsHms={printer.provider !== 'moonraker'} />
          </div>
          <p className="truncate text-sm text-bambu-gray">{printer.model || 'Unknown model'}</p>
          <p className="mt-1 flex items-center gap-1 text-xs text-bambu-gray/80"><MapPin className="h-3 w-3" />{printer.location || 'Unassigned'}</p>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-white/5 bg-black/30 p-3.5">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-bambu-gray"><Box className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <p className="truncate text-sm font-medium text-white">{printName}</p>
              <span className="text-xs tabular-nums text-bambu-gray">{active ? `${progress}%` : stateMeta[state].label}</span>
            </div>
            <p className="mt-1 text-xs text-bambu-gray">{active ? formatTime(status?.remaining_time) : state === 'offline' ? 'Reconnect to view telemetry' : 'Ready for next job'}</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
              <div className="h-full rounded-full bg-bambu-green transition-[width] duration-300" style={{ width: `${active ? Math.max(progress, 2) : 0}%` }} />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Metric icon={<Thermometer className="h-3 w-3 text-orange-300" />} label="Nozzle" value={temperatures?.nozzle != null ? `${Math.round(temperatures.nozzle)}°C` : '—'} />
        <Metric icon={<Thermometer className="h-3 w-3 text-blue-300" />} label="Bed" value={temperatures?.bed != null ? `${Math.round(temperatures.bed)}°C` : '—'} />
        <Metric icon={<Layers3 className="h-3 w-3 text-bambu-green" />} label="Filament" value={amsSlots ? `${amsSlots} loaded` : 'External'} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <span className="inline-flex items-center gap-1.5 text-xs text-bambu-gray">
          {status?.connected ? <Wifi className="h-3.5 w-3.5 text-emerald-400" /> : <WifiOff className="h-3.5 w-3.5" />}
          {status?.connected ? 'Live telemetry' : 'Last known state'}
        </span>
        {onInspect ? (
          <span className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-bambu-green/40 bg-bambu-green/10 px-3.5 text-sm font-semibold text-bambu-green" aria-hidden="true">
            Inspect <ChevronRight className="h-4 w-4" />
          </span>
        ) : (
          <ReadOnlyAction onAction={onAction} primary>Open printer</ReadOnlyAction>
        )}
      </div>
    </article>
  );
}

function EmptyState({ isLoading }: { isLoading: boolean }) {
  return (
    <div className="lc-glass rounded-[1.375rem] border border-white/10 px-6 py-16 text-center text-bambu-gray">
      <PrinterIcon className="mx-auto mb-3 h-8 w-8 opacity-50" />
      {isLoading ? 'Loading live printer state…' : 'No printers match these filters.'}
    </div>
  );
}

function CommandDrawerVariant(props: PrintersPagePrototypeProps & { onAction: () => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = props.printers.find((item) => item.printer.id === selectedId);

  useEffect(() => {
    if (selectedId !== null && !props.printers.some((item) => item.printer.id === selectedId)) setSelectedId(null);
  }, [props.printers, selectedId]);

  return (
    <main className="relative mx-auto max-w-[118rem] p-4 pb-28 md:p-8 md:pb-28">
      <div className="lc-ambient" aria-hidden="true" />
      <header className="relative mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-bambu-green">Uninterrupted fleet</p><h1 className="text-3xl font-semibold tracking-[-0.035em] text-white md:text-[2.5rem] md:leading-none">Command drawer</h1><div className="mt-3"><Summary printers={props.printers} /></div></div>
        <ReadOnlyAction onAction={props.onAddPrinter ?? props.onAction} primary disabled={!props.canAdd}><Plus className="h-4 w-4" />Add printer</ReadOnlyAction>
      </header>
      <div className="lc-glass sticky top-3 z-20 mb-5 flex flex-col gap-3 rounded-2xl border border-white/10 p-3 shadow-[0_18px_50px_rgba(0,0,0,0.28)] xl:flex-row xl:items-center"><SearchField value={props.search} onChange={props.onSearchChange} className="min-w-0 flex-1 xl:max-w-xl" /><FilterCluster {...props} /></div>

      {props.printers.length ? (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {props.printers.map((item) => <PrinterSnapshotCard key={item.printer.id} item={item} onAction={props.onAction} onInspect={() => setSelectedId(item.printer.id)} selected={item.printer.id === selectedId} />)}
          </div>
          {selected && <div className="mt-4 xl:fixed xl:bottom-20 xl:right-4 xl:top-4 xl:z-40 xl:mt-0 xl:w-[min(44rem,46vw)] xl:overflow-y-auto xl:rounded-[1.75rem] xl:shadow-[0_30px_100px_rgba(0,0,0,0.55)]"><FocusDetail item={selected} onAction={props.onAction} onClose={() => setSelectedId(null)} compact /></div>}
        </>
      ) : <EmptyState isLoading={props.isLoading} />}
    </main>
  );
}

function FocusDetail({ item, onAction, onOpenControls, compact = false, onClose }: { item: PrototypePrinter; onAction: () => void; onOpenControls?: (printerId: number) => void; compact?: boolean; onClose?: () => void }) {
  const { printer, status } = item;
  const state = getState(status, printer.provider !== 'moonraker');
  const progress = Math.round(status?.progress ?? 0);
  const temperatures = status?.temperatures;
  const active = state === 'printing' || state === 'paused';
  const hasCamera = printer.capabilities?.camera ?? printer.provider !== 'moonraker';
  const knownHmsCount = printer.provider !== 'moonraker' && status?.hms_errors
    ? filterKnownHMSErrors(status.hms_errors).length
    : 0;
  const jobName = status?.subtask_name || status?.current_print || status?.gcode_file || 'No active job';
  const connection = status?.wired_network
    ? 'Ethernet'
    : status?.wifi_signal != null
      ? `${status.wifi_signal} dBm`
      : status?.connected ? 'Online' : 'Offline';
  const temperature = (current?: number, target?: number) => {
    if (current == null) return '—';
    return `${Math.round(current)}°${target != null && target > 0 ? ` / ${Math.round(target)}°` : ''}`;
  };
  const filamentSlots = [
    ...(status?.ams ?? []).flatMap((unit) => unit.tray.map((tray) => ({
      key: `ams-${unit.id}-${tray.id}`,
      name: tray.tray_type || 'Empty',
      detail: tray.tray_sub_brands || (tray.tray_type ? `${Math.round(tray.remain)}%` : 'AMS'),
      color: tray.tray_color,
    }))),
    ...(status?.vt_tray ?? []).map((tray) => ({
      key: `external-${tray.id}`,
      name: tray.tray_type || 'Empty',
      detail: tray.tray_sub_brands || 'External',
      color: tray.tray_color,
    })),
  ];
  const notices: string[] = [];
  if (knownHmsCount) notices.push(`${knownHmsCount} machine ${knownHmsCount === 1 ? 'alert' : 'alerts'}`);
  if (status?.awaiting_plate_clear) notices.push('Build plate needs clearing');
  if (status?.door_open) notices.push('Enclosure door open');

  return (
    <section className={`lc-glass overflow-hidden rounded-[1.75rem] border border-white/10 shadow-[0_30px_80px_rgba(0,0,0,0.3)] ${compact ? '' : 'min-h-[42rem]'}`}>
      <header className="flex flex-col gap-5 border-b border-white/[0.07] p-5 sm:flex-row sm:items-center sm:justify-between md:p-7">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-[1.25rem] bg-black/30 p-2 ring-1 ring-white/5">
            <img src={getPrinterImage(printer.model)} alt="" className="h-full w-full object-contain" />
          </div>
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2"><h1 className="truncate text-2xl font-semibold tracking-[-0.03em] text-white">{printer.name}</h1><StatusChip status={status} supportsHms={printer.provider !== 'moonraker'} /></div>
            <p className="text-sm text-bambu-gray">{printer.model || 'Unknown model'} · {printer.location || 'Unassigned'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ReadOnlyAction onAction={onOpenControls ? () => onOpenControls(item.printer.id) : onAction} primary>Open controls</ReadOnlyAction>
          {onClose && <button type="button" onClick={onClose} className="lc-pressable flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-bambu-gray hover:text-white" aria-label="Close inspector"><X className="h-4 w-4" /></button>}
        </div>
      </header>

      <div className={`grid gap-4 p-5 md:p-7 ${compact ? '' : 'md:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.6fr)]'}`}>
        <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <div className="overflow-hidden rounded-[1.375rem] border border-white/[0.07] bg-black/30 p-3">
            <div className="mb-3 flex items-center justify-between gap-3 px-1">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-bambu-gray">Camera</p>
              <span className="inline-flex items-center gap-1.5 text-xs text-bambu-gray">
                <span className={`h-1.5 w-1.5 rounded-full ${status?.connected && hasCamera ? 'bg-red-400' : 'bg-zinc-500'}`} />
                {status?.connected && hasCamera ? 'Live' : 'Unavailable'}
              </span>
            </div>
            {hasCamera ? (
              <CameraTile
                printerId={printer.id}
                printerName={printer.name}
                provider={printer.provider}
                cameraRotation={printer.camera_rotation}
                mode="live"
                snapshotIntervalMs={10_000}
                connected={status?.connected ?? false}
              />
            ) : (
              <div className="flex aspect-video items-center justify-center rounded-xl border border-white/[0.07] bg-black/50 text-bambu-gray">
                <div className="text-center">
                  <VideoOff className="mx-auto h-8 w-8 opacity-70" aria-hidden="true" />
                  <p className="mt-2 text-sm">No camera configured</p>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-[1.375rem] border border-white/[0.07] bg-black/30 p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-bambu-gray">Current job</p>
              <h2 className="mt-2 truncate text-xl font-semibold tracking-[-0.02em] text-white">{jobName}</h2>
              <p className="mt-1 text-sm text-bambu-gray">{status?.stg_cur_name || (active ? 'Printing' : stateMeta[state].label)}{status?.current_plate_id != null ? ` · Plate ${status.current_plate_id}` : ''}</p>
            </div>
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white/[0.05] text-bambu-gray"><Box className="h-7 w-7" /></div>
          </div>
          <div className="mt-8 flex items-end justify-between gap-4"><span className="text-5xl font-semibold tracking-[-0.05em] tabular-nums text-white">{active ? progress : 0}<span className="text-2xl text-bambu-gray">%</span></span><span className="mb-1 inline-flex items-center gap-1.5 text-sm text-bambu-gray"><Clock3 className="h-4 w-4" />{formatTime(status?.remaining_time)}</span></div>
          <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-bambu-green transition-[width] duration-300" style={{ width: `${active ? Math.max(progress, 2) : 0}%` }} /></div>
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Metric icon={<Thermometer className="h-3 w-3 text-orange-300" />} label={temperatures?.nozzle_2 != null ? 'Nozzle L' : 'Nozzle'} value={temperature(temperatures?.nozzle, temperatures?.nozzle_target)} />
            {temperatures?.nozzle_2 != null && <Metric icon={<Thermometer className="h-3 w-3 text-orange-300" />} label="Nozzle R" value={temperature(temperatures.nozzle_2, temperatures.nozzle_2_target)} />}
            <Metric icon={<Thermometer className="h-3 w-3 text-blue-300" />} label="Bed" value={temperature(temperatures?.bed, temperatures?.bed_target)} />
            {temperatures?.chamber != null && <Metric icon={<Thermometer className="h-3 w-3 text-emerald-300" />} label="Chamber" value={temperature(temperatures.chamber, temperatures.chamber_target)} />}
            <Metric icon={<Layers3 className="h-3 w-3 text-bambu-green" />} label="Layer" value={status?.total_layers ? `${status.layer_num ?? 0}/${status.total_layers}` : '—'} />
            <Metric icon={<Radio className="h-3 w-3 text-emerald-300" />} label="Connection" value={connection} />
          </div>
        </div>
        </div>

        <aside className="flex flex-col gap-3">
          <div className="rounded-[1.375rem] border border-white/[0.07] bg-black/25 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-bambu-gray">Next best action</p>
            <p className="mt-3 text-base font-medium text-white">{state === 'finished' ? 'Clear plate and prepare next job' : active ? 'Monitor this print' : state === 'offline' ? 'Check printer connection' : 'Choose a file to print'}</p>
            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <span className="rounded-lg bg-white/[0.05] px-2.5 py-2 text-bambu-gray"><HardDrive className="mr-1.5 inline h-3.5 w-3.5" />{status?.firmware_version || 'Firmware unknown'}</span>
              <span className="rounded-lg bg-white/[0.05] px-2.5 py-2 text-bambu-gray"><DoorOpen className="mr-1.5 inline h-3.5 w-3.5" />{status?.door_open ? 'Door open' : 'Door closed'}</span>
            </div>
          </div>

          <div className="rounded-[1.375rem] border border-white/[0.07] bg-black/25 p-5">
            <div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-bambu-gray">Filament</p><span className="text-xs text-bambu-gray">{filamentSlots.filter((slot) => slot.name !== 'Empty').length} loaded</span></div>
            {filamentSlots.length ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {filamentSlots.slice(0, 8).map((slot) => {
                  const color = slot.color ? `#${slot.color.replace('#', '').slice(0, 6)}` : undefined;
                  return <div key={slot.key} className="flex min-w-0 items-center gap-2 rounded-xl bg-white/[0.05] p-2"><span className="h-6 w-6 shrink-0 rounded-full border border-white/15 bg-white/10" style={color ? { backgroundColor: color } : undefined} /><span className="min-w-0"><span className="block truncate text-xs font-semibold text-white">{slot.name}</span><span className="block truncate text-[0.625rem] text-bambu-gray">{slot.detail}</span></span></div>;
                })}
              </div>
            ) : <p className="mt-3 text-sm text-bambu-gray">External spool or no AMS telemetry.</p>}
          </div>

          <div className={`rounded-[1.375rem] border p-4 ${notices.length ? 'border-amber-400/20 bg-amber-400/[0.07]' : 'border-white/[0.07] bg-black/25'}`}>
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-bambu-gray"><AlertTriangle className={`h-4 w-4 ${notices.length ? 'text-amber-300' : 'text-emerald-300'}`} />Machine state</p>
            <p className="mt-2 text-sm font-medium text-white">{notices.length ? notices.join(' · ') : 'No action needed'}</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

function InlineDeckVariant(props: PrintersPagePrototypeProps & { onAction: () => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(props.printers[0]?.printer.id ?? null);
  const selected = props.printers.find((item) => item.printer.id === selectedId) ?? props.printers[0];

  useEffect(() => {
    if (!props.printers.length) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!props.printers.some((item) => item.printer.id === selectedId)) setSelectedId(props.printers[0].printer.id);
  }, [props.printers, selectedId]);

  return (
    <main className="relative mx-auto max-w-[118rem] p-4 pb-28 md:p-8 md:pb-28">
      <div className="lc-ambient" aria-hidden="true" />
      <header className="relative mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-end"><div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-bambu-green">Context where selected</p><h1 className="text-3xl font-semibold tracking-[-0.035em] text-white md:text-[2.5rem] md:leading-none">Inline deck</h1><div className="mt-3"><Summary printers={props.printers} /></div></div><ReadOnlyAction onAction={props.onAddPrinter ?? props.onAction} primary disabled={!props.canAdd}><Plus className="h-4 w-4" />Add printer</ReadOnlyAction></header>
      <div className="lc-glass sticky top-3 z-20 mb-5 flex flex-col gap-3 rounded-2xl border border-white/10 p-3 shadow-[0_18px_50px_rgba(0,0,0,0.28)] xl:flex-row xl:items-center"><SearchField value={props.search} onChange={props.onSearchChange} className="min-w-0 flex-1 xl:max-w-xl" /><FilterCluster {...props} /></div>

      {props.printers.length && selected ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {props.printers.map((item) => {
            const isSelected = item.printer.id === selected.printer.id;
            return (
              <div key={item.printer.id} className={isSelected ? 'lg:col-span-2 2xl:col-span-3' : ''}>
                {isSelected ? (
                  <div className="grid items-start gap-4 xl:grid-cols-[minmax(22rem,0.7fr)_minmax(30rem,1.3fr)]">
                    <PrinterSnapshotCard item={item} onAction={props.onAction} onInspect={() => setSelectedId(item.printer.id)} selected />
                    <FocusDetail item={item} onAction={props.onAction} compact />
                  </div>
                ) : <PrinterSnapshotCard item={item} onAction={props.onAction} onInspect={() => setSelectedId(item.printer.id)} />}
              </div>
            );
          })}
        </div>
      ) : <EmptyState isLoading={props.isLoading} />}
    </main>
  );
}

function CommandDeckVariant(props: PrintersPagePrototypeProps & { onAction: () => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(props.printers[0]?.printer.id ?? null);
  const selected = props.printers.find((item) => item.printer.id === selectedId) ?? props.printers[0];

  useEffect(() => {
    if (!props.printers.length) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!props.printers.some((item) => item.printer.id === selectedId)) setSelectedId(props.printers[0].printer.id);
  }, [props.printers, selectedId]);

  return (
    <main className="relative mx-auto max-w-[118rem] p-4 pb-28 md:p-8 md:pb-28">
      <div className="lc-ambient" aria-hidden="true" />
      <header className="relative mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-bambu-green">Fleet plus focus</p>
          <h1 className="text-3xl font-semibold tracking-[-0.035em] text-white md:text-[2.5rem] md:leading-none">Command deck</h1>
          <div className="mt-3"><Summary printers={props.printers} /></div>
        </div>
        <ReadOnlyAction onAction={props.onAddPrinter ?? props.onAction} primary disabled={!props.canAdd}><Plus className="h-4 w-4" />Add printer</ReadOnlyAction>
      </header>

      <div className="lc-glass sticky top-3 z-20 mb-5 flex flex-col gap-3 rounded-2xl border border-white/10 p-3 shadow-[0_18px_50px_rgba(0,0,0,0.28)] xl:flex-row xl:items-center">
        <SearchField value={props.search} onChange={props.onSearchChange} className="min-w-0 flex-1 xl:max-w-xl" />
        <FilterCluster {...props} />
      </div>

      {props.printers.length && selected ? (
        <div className="grid items-start justify-center gap-4 xl:grid-cols-[minmax(24rem,30rem)_minmax(36rem,60rem)]">
          <div className="grid grid-cols-1 gap-4">
            {props.printers.map((item) => (
              <PrinterSnapshotCard
                key={item.printer.id}
                item={item}
                onAction={props.onAction}
                onInspect={() => setSelectedId(item.printer.id)}
                selected={item.printer.id === selected.printer.id}
                portrait
              />
            ))}
          </div>
          <div className="self-start xl:sticky xl:top-20">
            <FocusDetail item={selected} onAction={props.onAction} onOpenControls={props.onOpenControls} compact />
          </div>
        </div>
      ) : <EmptyState isLoading={props.isLoading} />}
    </main>
  );
}

function FocusBannerVariant(props: PrintersPagePrototypeProps & { onAction: () => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(props.printers[0]?.printer.id ?? null);
  const selected = props.printers.find((item) => item.printer.id === selectedId) ?? props.printers[0];

  useEffect(() => {
    if (!props.printers.length) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!props.printers.some((item) => item.printer.id === selectedId)) setSelectedId(props.printers[0].printer.id);
  }, [props.printers, selectedId]);

  return (
    <main className="relative mx-auto max-w-[118rem] p-4 pb-28 md:p-8 md:pb-28">
      <div className="lc-ambient" aria-hidden="true" />
      <header className="relative mb-6 flex flex-col justify-between gap-5 lg:flex-row lg:items-end"><div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-bambu-green">Priority first</p><h1 className="text-3xl font-semibold tracking-[-0.035em] text-white md:text-[2.5rem] md:leading-none">Focus banner</h1><div className="mt-3"><Summary printers={props.printers} /></div></div><ReadOnlyAction onAction={props.onAddPrinter ?? props.onAction} primary disabled={!props.canAdd}><Plus className="h-4 w-4" />Add printer</ReadOnlyAction></header>
      <div className="lc-glass sticky top-3 z-20 mb-5 flex flex-col gap-3 rounded-2xl border border-white/10 p-3 shadow-[0_18px_50px_rgba(0,0,0,0.28)] xl:flex-row xl:items-center"><SearchField value={props.search} onChange={props.onSearchChange} className="min-w-0 flex-1 xl:max-w-xl" /><FilterCluster {...props} /></div>

      {props.printers.length && selected ? (
        <div className="space-y-5">
          <FocusDetail item={selected} onAction={props.onAction} />
          <section>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold tracking-[-0.02em] text-white">Fleet</h2><span className="text-xs text-bambu-gray">Select next focus</span></div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {props.printers.map((item) => <PrinterSnapshotCard key={item.printer.id} item={item} onAction={props.onAction} onInspect={() => setSelectedId(item.printer.id)} selected={item.printer.id === selected.printer.id} />)}
            </div>
          </section>
        </div>
      ) : <EmptyState isLoading={props.isLoading} />}
    </main>
  );
}

function PrototypeSwitcher({ current, onChange, stateLabel }: { current: PrototypeVariant; onChange: (variant: PrototypeVariant) => void; stateLabel: string }) {
  const index = variants.findIndex((variant) => variant.key === current);
  const cycle = (direction: -1 | 1) => onChange(variants[(index + direction + variants.length) % variants.length].key);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <div className="lc-switcher fixed bottom-5 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-2xl border border-white/15 bg-[#17151d]/90 p-1.5 text-white shadow-[0_22px_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl" role="group" aria-label="Prototype variants">
      <button type="button" onClick={() => cycle(-1)} className="lc-pressable flex h-9 w-9 items-center justify-center rounded-xl text-bambu-gray hover:bg-white/10 hover:text-white" aria-label="Previous variant"><ArrowLeft className="h-4 w-4" /></button>
      <div className="min-w-[13rem] px-2 text-center"><div className="text-xs font-semibold"><span className="text-bambu-green">{current.toUpperCase()}</span> · {variants[index].name}</div><div className="mt-0.5 text-[0.625rem] text-bambu-gray">{stateLabel}</div></div>
      <button type="button" onClick={() => cycle(1)} className="lc-pressable flex h-9 w-9 items-center justify-center rounded-xl text-bambu-gray hover:bg-white/10 hover:text-white" aria-label="Next variant"><ArrowRight className="h-4 w-4" /></button>
    </div>
  );
}

export function PrintersPagePrototype(props: PrintersPagePrototypeProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('variant');
  const variant: PrototypeVariant = props.production ? 'd' : requested === 'b' || requested === 'c' || requested === 'd' ? requested : 'a';
  const [notice, setNotice] = useState<string | null>(null);

  const changeVariant = (next: PrototypeVariant) => {
    const params = new URLSearchParams(searchParams);
    params.set('variant', next);
    setSearchParams(params, { replace: true });
  };

  const showReadOnlyNotice = () => {
    setNotice('Prototype is read-only. Pick a direction before wiring printer actions.');
    window.setTimeout(() => setNotice(null), 2600);
  };

  const variantProps = { ...props, onAction: props.production ? (() => undefined) : showReadOnlyNotice };

  return (
    <div className="lc-prototype min-h-full bg-bambu-dark text-white">
      <div key={variant} className="lc-variant-enter">
        {variant === 'a' && <CommandDrawerVariant {...variantProps} />}
        {variant === 'b' && <InlineDeckVariant {...variantProps} />}
        {variant === 'c' && <FocusBannerVariant {...variantProps} />}
        {variant === 'd' && <CommandDeckVariant {...variantProps} />}
      </div>
      {!props.production && notice && <div role="status" className="fixed bottom-24 left-1/2 z-[110] -translate-x-1/2 rounded-xl border border-white/10 bg-[#211e29]/95 px-4 py-2.5 text-sm text-white shadow-2xl backdrop-blur-xl">{notice}</div>}
      {!props.production && <PrototypeSwitcher current={variant} onChange={changeVariant} stateLabel={`${props.printers.length}/${props.totalPrinters} shown · read-only live data`} />}
    </div>
  );
}

const demoPrinters: PrototypePrinter[] = [
  {
    printer: { id: 1, name: "DOGGE'S PRINTER", model: 'P1S', location: 'Dogge Home', provider: 'bambu' } as Printer,
    status: {
      id: 1,
      name: "DOGGE'S PRINTER",
      connected: true,
      state: 'FINISH',
      progress: 100,
      remaining_time: 0,
      layer_num: 418,
      total_layers: 418,
      current_print: null,
      subtask_name: 'Voron cable clip set',
      current_plate_id: 1,
      gcode_file: null,
      stg_cur_name: 'Print finished',
      temperatures: { nozzle: 27, nozzle_target: 0, bed: 25, bed_target: 0, chamber: 29 },
      firmware_version: '01.10.00.00',
      wifi_signal: -49,
      wired_network: false,
      door_open: false,
      awaiting_plate_clear: true,
      hms_errors: [],
      ams: [{
        id: 0,
        humidity: 25,
        temp: 26.6,
        is_ams_ht: false,
        tray: [
          { id: 0, tray_color: 'E8E8E8FF', tray_type: 'PLA', tray_sub_brands: 'PLA Basic', remain: 25 },
          { id: 1, tray_color: '252525FF', tray_type: 'PLA', tray_sub_brands: 'PLA Matte', remain: 82 },
          { id: 2, tray_color: null, tray_type: null, tray_sub_brands: null, remain: 0 },
          { id: 3, tray_color: '7C3AEDFF', tray_type: 'PLA', tray_sub_brands: 'PLA Basic', remain: 64 },
        ],
      }],
      vt_tray: [],
    } as unknown as PrinterStatus,
  },
  {
    printer: { id: 2, name: 'Tim Voron', model: null, location: 'Timpa Home', provider: 'moonraker' } as Printer,
    status: {
      id: 2,
      name: 'Tim Voron',
      connected: true,
      state: 'IDLE',
      progress: 0,
      remaining_time: 0,
      layer_num: null,
      total_layers: null,
      current_print: null,
      subtask_name: null,
      current_plate_id: null,
      gcode_file: null,
      stg_cur_name: null,
      temperatures: { nozzle: 22, nozzle_target: 0, bed: 23, bed_target: 0 },
      firmware_version: 'Moonraker',
      wifi_signal: null,
      wired_network: true,
      door_open: false,
      awaiting_plate_clear: false,
      hms_errors: [],
      ams: [],
      vt_tray: [{ id: 254, tray_color: 'F59E0BFF', tray_type: 'PETG', tray_sub_brands: 'External spool', remain: 71 }],
    } as unknown as PrinterStatus,
  },
];

export function PrintersPrototypeDemo() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [locationFilter, setLocationFilter] = useState('all');
  const [hideOffline, setHideOffline] = useState(false);
  const [sortBy, setSortBy] = useState<SortOption>('name');

  const printers = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = demoPrinters.filter(({ printer, status }) => {
      const state = getState(status, printer.provider !== 'moonraker');
      const matchesSearch = !query || [printer.name, printer.model, printer.location].some((value) => value?.toLowerCase().includes(query));
      const matchesStatus = statusFilter === 'all' || state === statusFilter || (statusFilter === 'error' && state === 'problem');
      const matchesLocation = locationFilter === 'all' || printer.location === locationFilter;
      return matchesSearch && matchesStatus && matchesLocation && (!hideOffline || status?.connected);
    });
    return [...filtered].sort((left, right) => {
      if (sortBy === 'status') return getState(left.status, left.printer.provider !== 'moonraker').localeCompare(getState(right.status, right.printer.provider !== 'moonraker'));
      if (sortBy === 'model') return (left.printer.model || '').localeCompare(right.printer.model || '');
      if (sortBy === 'location') return (left.printer.location || '').localeCompare(right.printer.location || '');
      return left.printer.name.localeCompare(right.printer.name);
    });
  }, [hideOffline, locationFilter, search, sortBy, statusFilter]);

  return (
    <PrintersPagePrototype
      printers={printers}
      totalPrinters={demoPrinters.length}
      isLoading={false}
      search={search}
      statusFilter={statusFilter}
      locationFilter={locationFilter}
      availableLocations={['Dogge Home', 'Timpa Home']}
      hideOffline={hideOffline}
      sortBy={sortBy}
      canAdd
      onSearchChange={setSearch}
      onStatusFilterChange={setStatusFilter}
      onLocationFilterChange={setLocationFilter}
      onHideOfflineChange={() => setHideOffline((value) => !value)}
      onSortChange={setSortBy}
    />
  );
}
