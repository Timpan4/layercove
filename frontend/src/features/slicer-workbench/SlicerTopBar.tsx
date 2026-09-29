import { ArrowLeft, Box, Check, Layers3, Loader2, Printer, Redo2, Undo2 } from 'lucide-react';
import type { ReactNode } from 'react';

type PreviewMode = 'prepare' | 'preview';

export interface SlicerTopBarProps {
  backLabel: string;
  onBack: () => void;
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  title: string;
  subtitle?: string;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  sliceState: 'idle' | 'queued' | 'running' | 'complete' | 'failed';
  onSlice: () => void;
  canSlice: boolean;
  onPrint?: () => void;
  canPrint: boolean;
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick?: () => void; disabled?: boolean; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="lc-pressable flex min-h-10 min-w-10 items-center justify-center border border-transparent text-bambu-gray-light outline-none hover:bg-white/8 hover:text-white focus:ring-2 focus:ring-bambu-green disabled:cursor-not-allowed disabled:opacity-30">{children}</button>;
}

export function SlicerTopBar({ backLabel, onBack, mode, onModeChange, title, subtitle, canUndo = false, canRedo = false, onUndo, onRedo, sliceState, onSlice, canSlice, onPrint, canPrint }: SlicerTopBarProps) {
  const slicing = sliceState === 'queued' || sliceState === 'running';
  return <header className="flex h-auto shrink-0 flex-wrap items-center gap-1 rounded-md border border-white/10 bg-[#292a2e] p-1 text-white md:h-[4.5rem] md:flex-nowrap md:p-0">
    <button type="button" onClick={onBack} aria-label={backLabel} className="lc-pressable order-1 flex h-11 w-11 items-center justify-center rounded-md border border-white/10 bg-black/15 text-bambu-gray-light shadow-sm hover:bg-white/8 hover:text-white focus:ring-2 focus:ring-bambu-green md:order-none md:ml-2"><ArrowLeft className="h-5 w-5" /></button>
    <div className="order-3 flex h-12 w-full items-stretch overflow-hidden rounded-md border border-white/10 bg-black/15 shadow-sm md:order-none md:ml-2 md:w-auto">
      {(['prepare', 'preview'] as PreviewMode[]).map((item) => <button key={item} type="button" onClick={() => onModeChange(item)} className={`lc-pressable flex min-w-0 flex-1 items-center justify-center gap-2 border-r border-white/10 px-4 text-sm font-semibold capitalize outline-none last:border-r-0 focus:ring-2 focus:ring-inset focus:ring-bambu-green md:min-w-30 ${mode === item ? 'bg-bambu-green text-white' : 'text-bambu-gray-light hover:bg-white/5 hover:text-white'}`}>{item === 'prepare' ? <Box className="h-5 w-5" /> : <Layers3 className="h-5 w-5" />}{item}</button>)}
    </div>
    <div className="order-2 min-w-0 flex-1 px-3 text-center md:order-none"><p className="truncate text-xs font-semibold text-white">{title}</p>{subtitle && <p className="truncate text-[10px] text-bambu-gray">{subtitle}</p>}</div>
    <div className="order-4 flex w-full items-center justify-end gap-1 rounded-md border border-white/10 bg-black/15 p-1 shadow-lg shadow-black/20 md:order-none md:mr-2 md:w-auto">
      <IconButton label="Undo" onClick={onUndo} disabled={!canUndo}><Undo2 className="h-4 w-4" /></IconButton><IconButton label="Redo" onClick={onRedo} disabled={!canRedo}><Redo2 className="h-4 w-4" /></IconButton>
      <button type="button" onClick={onSlice} disabled={!canSlice || slicing} className="lc-pressable flex min-h-10 min-w-32 items-center justify-center gap-2 rounded-sm bg-bambu-green px-4 text-sm font-semibold text-black outline-none focus:ring-2 focus:ring-white disabled:cursor-not-allowed disabled:opacity-50">{slicing ? <Loader2 className="h-4 w-4 animate-spin" /> : sliceState === 'complete' ? <Check className="h-4 w-4" /> : null}{slicing ? 'Slicing…' : sliceState === 'complete' ? 'Slice again' : 'Slice plate'}</button>
      {onPrint && <button type="button" onClick={onPrint} disabled={!canPrint} className="lc-pressable flex min-h-10 min-w-28 items-center justify-center gap-2 rounded-sm border border-white/10 bg-white/8 px-4 text-sm font-semibold text-white outline-none hover:bg-white/15 focus:ring-2 focus:ring-bambu-green disabled:cursor-not-allowed disabled:opacity-30"><Printer className="h-4 w-4" />Print</button>}
    </div>
  </header>;
}
