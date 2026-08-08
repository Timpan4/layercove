import { Grid3X3, Maximize2, Move, RotateCcw, RotateCw, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';

export type SlicerTool = 'move' | 'rotate' | 'scale' | 'lay-flat' | 'arrange';
export type SlicerTransform = { x: number; y: number; z: number };
export type SlicerCanvasObject = { id: string; name: string; hidden: boolean; locked: boolean };
export type SlicerPlate = { index: number; name: string; objectCount: number };

export interface SlicerCanvasWorkspaceProps {
  mode: 'prepare' | 'preview';
  tool: SlicerTool;
  supportsObjectState?: boolean;
  onToolChange: (tool: SlicerTool) => void;
  selectedObject?: SlicerCanvasObject;
  transform: SlicerTransform;
  onTransformChange: (axis: keyof SlicerTransform, value: number) => void;
  onLayFlat: () => void;
  onArrange: () => void;
  plates: SlicerPlate[];
  selectedPlate: number;
  onPlateChange: (index: number) => void;
  modelViewer?: ReactNode;
  gcodeViewer?: ReactNode;
  children?: ReactNode;
}

const tools: Array<{ id: SlicerTool; label: string; icon: typeof Maximize2 }> = [
  { id: 'move', label: 'Move', icon: Move }, { id: 'rotate', label: 'Rotate', icon: RotateCw }, { id: 'scale', label: 'Scale', icon: Maximize2 },
];

export function SlicerCanvasWorkspace(props: SlicerCanvasWorkspaceProps) {
  const editable = Boolean(props.supportsObjectState !== false && props.selectedObject && !props.selectedObject.locked);
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-white/10 bg-[#515258]">
    <div className="flex h-14 shrink-0 items-center gap-2 overflow-x-auto border-b border-white/10 bg-[#35363a] p-2">{props.supportsObjectState !== false && <div className="flex items-center rounded-md border border-white/10 bg-black/15 p-0.5 shadow-sm">{tools.map(({ id, label, icon: Icon }) => <button key={id} type="button" aria-label={label} onClick={() => props.onToolChange(id)} disabled={!props.selectedObject} className={`lc-pressable flex min-h-10 min-w-10 items-center justify-center text-bambu-gray-light hover:bg-white/8 disabled:opacity-30 ${props.tool === id ? 'bg-bambu-green/20 text-bambu-green' : ''}`}><Icon className="h-5 w-5" /></button>)}<button type="button" aria-label="Lay on face" onClick={props.onLayFlat} disabled={!editable} className="lc-pressable flex min-h-10 min-w-10 items-center justify-center text-bambu-gray-light hover:bg-white/8 disabled:opacity-30"><RotateCcw className="h-5 w-5" /></button><button type="button" aria-label="Arrange objects" onClick={props.onArrange} disabled={!props.selectedObject} className="lc-pressable flex min-h-10 min-w-10 items-center justify-center text-bambu-gray-light hover:bg-white/8 disabled:opacity-30"><Grid3X3 className="h-5 w-5" /></button></div>}<div className="ml-auto"><Sparkles className="h-5 w-5 text-bambu-gray" aria-hidden="true" /></div></div>
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[#515258]">{props.mode === 'prepare' ? props.modelViewer : props.gcodeViewer}{props.mode === 'prepare' && editable && <section className="absolute left-3 top-3 z-20 w-64 rounded-md border border-white/15 bg-[#292a2e]/95 p-3 shadow-xl shadow-black/30"><h3 className="mb-3 text-xs font-semibold text-white">{props.tool === 'rotate' ? 'Rotate' : props.tool === 'scale' ? 'Scale' : 'Move'}</h3>{(['x', 'y', 'z'] as const).map((axis) => <label key={axis} className="mb-2 flex min-h-9 items-center gap-2 text-[11px] capitalize text-bambu-gray-light"><span className="w-5 font-semibold">{axis}</span><input type="number" value={props.transform[axis]} onChange={(event) => props.onTransformChange(axis, Number(event.target.value))} className="min-h-8 min-w-0 flex-1 rounded-sm border border-white/10 bg-[#35363b] px-2 text-right text-xs text-white outline-none focus:border-bambu-green" /></label>)}</section>}{props.children}</div>
    <div className="flex h-13 shrink-0 items-center gap-1 overflow-x-auto border-t border-white/10 bg-[#35363a] px-2">{props.plates.map((plate) => <button key={plate.index} type="button" onClick={() => props.onPlateChange(plate.index)} className={`lc-pressable flex min-h-9 shrink-0 items-center gap-2 rounded-sm border px-3 text-xs outline-none focus:ring-2 focus:ring-bambu-green ${props.selectedPlate === plate.index ? 'border-bambu-green bg-bambu-green/15 text-white' : 'border-white/10 bg-black/10 text-bambu-gray-light'}`}>{plate.name}<span className="text-bambu-gray">{plate.objectCount}</span></button>)}</div>
  </section>;
}
