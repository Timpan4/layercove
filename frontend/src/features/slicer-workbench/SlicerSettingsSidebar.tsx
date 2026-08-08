import { Layers3, Printer } from 'lucide-react';
import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

export type SettingsMode = 'simple' | 'advanced' | 'expert';
export type SettingsScope = 'global' | 'object';
export type SlicerSetting = { key: string; label: string; description?: string; mode: SettingsMode; scope: SettingsScope; kind: 'number' | 'select' | 'boolean' | 'string'; value: string; unit?: string; min?: number; max?: number; choices?: Array<{ value: string; label: string }> };
export type SlicerSettingsPage = { id: string; label: string; groups: Array<{ id: string; label: string; options: string[] }> };
export type SlicerObject = { id: string; name: string; hidden: boolean; locked: boolean };

export interface SlicerSettingsSidebarProps {
  printerName: string;
  printerOptions: string[];
  onPrinterChange: (value: string) => void;
  filamentName: string;
  filamentOptions: string[];
  onFilamentChange: (value: string) => void;
  processName: string;
  processOptions: string[];
  onProcessChange: (value: string) => void;
  pages: SlicerSettingsPage[];
  settings: SlicerSetting[];
  mode: SettingsMode;
  onModeChange: (mode: SettingsMode) => void;
  pageId: string;
  onPageChange: (id: string) => void;
  scope: SettingsScope;
  onScopeChange: (scope: SettingsScope) => void;
  onSettingChange: (key: string, value: string) => void;
  objects?: SlicerObject[];
  selectedObjectId?: string;
  onObjectSelect?: (id: string) => void;
  onObjectVisibilityChange?: (id: string, hidden: boolean) => void;
  onObjectLockChange?: (id: string, locked: boolean) => void;
  children?: ReactNode;
}

export function SlicerResizeHandle({ width, onChange, inverse = false }: { width: number; onChange: (width: number) => void; inverse?: boolean }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) => Math.max(320, Math.min(560, value));
  const move = (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current) onChange(clamp(drag.current.width + (inverse ? drag.current.x - event.clientX : event.clientX - drag.current.x))); };
  return <div role="separator" tabIndex={0} aria-label="Resize settings sidebar" aria-orientation="vertical" onPointerDown={(event) => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={move} onPointerUp={(event) => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { const delta = event.key === 'ArrowRight' ? 16 : -16; onChange(clamp(width + (inverse ? -delta : delta))); } }} className="group relative z-20 w-1 shrink-0 cursor-col-resize bg-white/10 outline-none focus:bg-bambu-green"><span className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-bambu-green/30" /></div>;
}

const modes: SettingsMode[] = ['simple', 'advanced', 'expert'];

function Preset({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return <label className="block text-[10px] uppercase tracking-wide text-bambu-gray">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 min-h-9 w-full rounded-sm border border-white/10 bg-[#303136] px-2 text-xs normal-case tracking-normal text-white outline-none focus:border-bambu-green">{[value, ...options].filter((item, index, all) => item && all.indexOf(item) === index).map((item) => <option key={item}>{item}</option>)}</select></label>;
}

export function SlicerSettingsSidebar(props: SlicerSettingsSidebarProps) {
  const page = props.pages.find((item) => item.id === props.pageId) ?? props.pages[0];
  const allowed = new Set(page?.groups.flatMap((group) => group.options) ?? []);
  const visible = props.settings.filter((setting) => allowed.has(setting.key) && setting.scope === props.scope && modes.indexOf(setting.mode) <= modes.indexOf(props.mode));
  return <aside className="flex h-full min-h-0 flex-col gap-2 overflow-hidden bg-transparent p-2 text-white">
    <section className="rounded-md border border-white/10 bg-[#292a2e] p-3 shadow-md shadow-black/15"><div className="mb-2 flex items-center gap-2 text-base font-semibold"><Printer className="h-4 w-4 text-bambu-green" />Printer</div><Preset label="Machine preset" value={props.printerName} options={props.printerOptions} onChange={props.onPrinterChange} /></section>
    <section className="rounded-md border border-white/10 bg-[#292a2e] p-3 shadow-md shadow-black/15"><div className="mb-2 flex items-center gap-2 text-base font-semibold"><span className="h-4 w-1.5 rounded-sm bg-bambu-green" />Filament</div><Preset label="Filament preset" value={props.filamentName} options={props.filamentOptions} onChange={props.onFilamentChange} /></section>
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-white/10 bg-[#292a2e] shadow-md shadow-black/15">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2"><div className="flex items-center gap-2 text-base font-semibold"><Layers3 className="h-4 w-4 text-bambu-green" />Process</div><div className="flex rounded-md border border-white/10 bg-black/20 p-0.5">{modes.map((item) => <button key={item} type="button" onClick={() => props.onModeChange(item)} className={`min-h-7 rounded-sm px-2 text-[10px] capitalize ${props.mode === item ? 'bg-white/10 text-white' : 'text-bambu-gray'}`}>{item}</button>)}</div></div>
      <div className="border-b border-white/10 p-3"><Preset label="Process preset" value={props.processName} options={props.processOptions} onChange={props.onProcessChange} /></div>
      <div className="flex border-b border-white/10 px-2">{(['global', 'object'] as SettingsScope[]).map((item) => <button key={item} type="button" onClick={() => props.onScopeChange(item)} className={`min-h-10 flex-1 text-xs capitalize ${props.scope === item ? 'border-b-2 border-bambu-green text-white' : 'text-bambu-gray'}`}>{item}</button>)}</div>
      {props.scope === 'object' && props.objects ? <div className="min-h-0 flex-1 overflow-auto p-2">{props.objects.map((object) => <div key={object.id} className={`mb-1 flex min-h-11 items-center gap-2 rounded-sm px-2 ${props.selectedObjectId === object.id ? 'bg-bambu-green/15' : ''}`}><button type="button" onClick={() => props.onObjectSelect?.(object.id)} className="min-w-0 flex-1 truncate text-left text-xs text-bambu-gray-light">{object.name}</button><button type="button" aria-label={`${object.hidden ? 'Show' : 'Hide'} ${object.name}`} onClick={() => props.onObjectVisibilityChange?.(object.id, !object.hidden)} className="text-xs text-bambu-gray">{object.hidden ? 'Show' : 'Hide'}</button><button type="button" aria-label={`${object.locked ? 'Unlock' : 'Lock'} ${object.name}`} onClick={() => props.onObjectLockChange?.(object.id, !object.locked)} className="text-xs text-bambu-gray">{object.locked ? 'Unlock' : 'Lock'}</button></div>)}{visible.map((field) => <label key={field.key} title={field.description} className="flex min-h-12 items-center justify-between gap-3 border-t border-white/8 py-2 text-xs text-bambu-gray-light"><span className="min-w-0 flex-1 truncate">{field.label}</span>{field.kind === 'boolean' ? <input type="checkbox" checked={field.value === 'true'} onChange={(event) => props.onSettingChange(field.key, String(event.target.checked))} className="h-5 w-5 accent-bambu-green" /> : <input type={field.kind === 'number' ? 'number' : 'text'} value={field.value} min={field.min} max={field.max} onChange={(event) => props.onSettingChange(field.key, event.target.value)} className="min-h-9 w-24 rounded-sm border border-white/10 bg-[#35363b] px-2 text-right text-xs text-white outline-none focus:border-bambu-green" />}</label>)}</div> : <><div className="flex shrink-0 overflow-x-auto border-b border-white/10 px-2">{props.pages.map((item) => <button key={item.id} type="button" onClick={() => props.onPageChange(item.id)} className={`min-h-11 shrink-0 border-b-2 px-3 text-xs ${page?.id === item.id ? 'border-bambu-green text-white' : 'border-transparent text-bambu-gray'}`}>{item.label}</button>)}</div><div className="min-h-0 flex-1 overflow-auto px-3 pb-8">{page?.groups.map((group) => { const fields = visible.filter((setting) => group.options.includes(setting.key)); return fields.length ? <section key={group.id} className="pt-3"><h3 className="border-b border-white/10 pb-1.5 text-[11px] font-semibold text-white">{group.label}</h3>{fields.map((field) => <label key={field.key} title={field.description} className="flex min-h-12 items-center justify-between gap-3 border-b border-white/8 py-2 text-xs text-bambu-gray-light"><span className="min-w-0 flex-1 truncate">{field.label}</span>{field.kind === 'boolean' ? <input type="checkbox" checked={field.value === 'true'} onChange={(event) => props.onSettingChange(field.key, String(event.target.checked))} className="h-5 w-5 accent-bambu-green" /> : field.kind === 'select' ? <select value={field.value} onChange={(event) => props.onSettingChange(field.key, event.target.value)} className="min-h-9 max-w-40 rounded-sm border border-white/10 bg-[#35363b] px-2 text-xs text-white outline-none focus:border-bambu-green">{field.choices?.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : <input type={field.kind === 'number' ? 'number' : 'text'} value={field.value} min={field.min} max={field.max} onChange={(event) => props.onSettingChange(field.key, event.target.value)} className="min-h-9 w-24 rounded-sm border border-white/10 bg-[#35363b] px-2 text-right text-xs text-white outline-none focus:border-bambu-green" />}</label>)}</section> : null; })}</div></>}
      {props.children}
    </section>
  </aside>;
}
