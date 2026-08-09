import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GcodeViewer } from '../components/GcodeViewer';
import { ModelViewer } from '../components/ModelViewer';
import { PrintModal } from '../components/PrintModal';
import type { PresetRef, SlicerSchemaOption, UnifiedPreset } from '../api/client';
import { SlicerCanvasWorkspace, type SlicerTool } from '../features/slicer-workbench/SlicerCanvasWorkspace';
import { SlicerFooter } from '../features/slicer-workbench/SlicerFooter';
import {
  SlicerResizeHandle,
  SlicerSettingsSidebar,
  type SettingsMode,
  type SettingsScope,
  type SlicerSetting,
} from '../features/slicer-workbench/SlicerSettingsSidebar';
import { SlicerTopBar } from '../features/slicer-workbench/SlicerTopBar';
import { parsePositiveInteger, resolveSettingsScope, resolveWorkbenchSource } from '../features/slicer-workbench/source';
import {
  type SettingValue,
  type WorkbenchSource,
  useSlicerWorkbench,
} from '../features/slicer-workbench/useSlicerWorkbench';

function displayPreset(preset: UnifiedPreset): string {
  return `${preset.name} · ${preset.source}`;
}

function selectedPresetName(ref: PresetRef | null, options: UnifiedPreset[]): string {
  const selected = ref && options.find((option) => option.source === ref.source && option.id === ref.id);
  return selected ? displayPreset(selected) : '';
}

function optionMode(option: SlicerSchemaOption): SettingsMode {
  if (typeof option.mode === 'string') {
    const mode = option.mode.toLowerCase();
    if (mode === 'simple' || mode === 'advanced' || mode === 'expert') return mode;
  }
  if (typeof option.mode === 'number') return option.mode <= 0 ? 'simple' : option.mode === 1 ? 'advanced' : 'expert';
  return 'simple';
}

function optionKind(option: SlicerSchemaOption): SlicerSetting['kind'] {
  if (option.choices?.length || option.type === 'enum') return 'select';
  if (option.type === 'bool' || option.type === 'boolean') return 'boolean';
  if (['int', 'integer', 'float', 'number', 'percent'].includes(option.type)) return 'number';
  return 'string';
}

function parseSettingValue(option: SlicerSchemaOption, value: string): SettingValue {
  const kind = optionKind(option);
  if (kind === 'boolean') return value === 'true';
  if (kind === 'number') return Number(value);
  return value;
}

function ErrorState({ message, onBack }: { message: string; onBack: () => void }) {
  return <div className="flex min-h-[50vh] items-center justify-center p-6"><div className="max-w-lg rounded-lg border border-red-500/30 bg-bambu-dark p-6 text-center text-white"><AlertTriangle className="mx-auto mb-3 h-8 w-8 text-red-400" /><h1 className="text-lg font-semibold">Slicer workbench unavailable</h1><p className="mt-2 text-sm text-bambu-gray-light">{message}</p><button type="button" onClick={onBack} className="mt-5 rounded-md bg-bambu-green px-4 py-2 text-sm font-semibold text-black">Return</button></div></div>;
}

export function SlicerWorkbenchPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const source = resolveWorkbenchSource(searchParams);
  const initialJobId = parsePositiveInteger(searchParams.get('job'));
  const backPath = source?.kind === 'archive' ? '/archives' : '/files';

  if (!source) {
    return <ErrorState message="Choose exactly one accessible archive or library model." onBack={() => navigate('/files')} />;
  }
  return <Workbench source={source} initialJobId={initialJobId} onBack={() => navigate(backPath)} />;
}

function Workbench({ source, initialJobId, onBack }: { source: WorkbenchSource; initialJobId: number | null; onBack: () => void }) {
  const model = useSlicerWorkbench(source, initialJobId);
  const [previewMode, setPreviewMode] = useState<'prepare' | 'preview'>('prepare');
  const [sidebarWidth, setSidebarWidth] = useState(400);
  const [pageId, setPageId] = useState('');
  const [tool, setTool] = useState<SlicerTool>('move');
  const [showPrint, setShowPrint] = useState(false);

  useEffect(() => {
    if (!pageId && model.schemaQuery.data?.pages[0]) setPageId(model.schemaQuery.data.pages[0].name);
  }, [model.schemaQuery.data?.pages, pageId]);

  const loading = model.capabilitiesQuery.isLoading || model.schemaQuery.isLoading || model.sourceQuery.isLoading || model.platesQuery.isLoading || model.presetsQuery.isLoading || model.printerModelsQuery.isLoading;
  if (loading) return <div className="flex min-h-[60vh] items-center justify-center text-bambu-gray-light"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading slicer workbench…</div>;

  const failedQuery = [model.capabilitiesQuery, model.schemaQuery, model.sourceQuery, model.platesQuery, model.presetsQuery, model.printerModelsQuery].find((query) => query.isError);
  if (failedQuery) return <ErrorState message={failedQuery.error instanceof Error ? failedQuery.error.message : 'Required slicer data could not be loaded.'} onBack={onBack} />;
  if (!model.capabilitiesQuery.data?.capabilities.process_schema) {
    return <ErrorState message="Pinned sidecar does not advertise required schema capability." onBack={onBack} />;
  }
  const supportsModelState = model.capabilitiesQuery.data.capabilities.model_state === true;
  const settingsScope: SettingsScope = resolveSettingsScope(supportsModelState, model.settingsView);

  const filename = model.sourceQuery.data?.filename ?? '';
  if (!/\.(stl|3mf|step|stp)$/i.test(filename)) {
    return <ErrorState message="This source is not an STL, 3MF, or STEP model." onBack={onBack} />;
  }

  const schema = model.schemaQuery.data!;
  const selectedObject = model.objects.find((object) => object.id === model.selectedObjectId);
  const settingRows: SlicerSetting[] = schema.options.flatMap((option) => {
    const configuredScopes = schema.scopes[option.key];
    const scopes = (Array.isArray(configuredScopes) ? configuredScopes : [configuredScopes]).filter(Boolean) as SettingsScope[];
    return scopes.filter((scope) => supportsModelState || scope === 'global').map((scope) => {
      const rawValue = scope === 'global'
        ? model.processOverrides[option.key] ?? model.processProfileQuery.data?.values[option.key] ?? schema.samples[option.key] ?? option.default ?? ''
        : selectedObject?.overrides[option.key] ?? model.processProfileQuery.data?.values[option.key] ?? schema.samples[option.key] ?? option.default ?? '';
      return {
        key: option.key,
        label: option.label || option.key,
        description: option.tooltip,
        mode: optionMode(option),
        scope,
        kind: optionKind(option),
        value: typeof rawValue === 'boolean' ? String(rawValue) : Array.isArray(rawValue) ? JSON.stringify(rawValue) : String(rawValue ?? ''),
        unit: option.units ?? undefined,
        min: option.min ?? undefined,
        max: option.max ?? undefined,
        choices: option.choices?.map((choice) => ({ value: String(choice), label: String(choice) })),
      };
    });
  });
  const pages = schema.pages.map((page) => ({
    id: page.name,
    label: page.name,
    groups: page.groups.map((group) => ({ id: `${page.name}:${group.name}`, label: group.name, options: group.options })),
  }));

  const choosePreset = (value: string, options: UnifiedPreset[], setter: (ref: PresetRef) => void) => {
    const selected = options.find((option) => displayPreset(option) === value);
    if (selected) setter({ source: selected.source, id: selected.id });
  };
  const selectedTransform = selectedObject?.transform ?? { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  const transformVector = tool === 'rotate' ? selectedTransform.rotation : tool === 'scale' ? selectedTransform.scale : selectedTransform.position;
  const transform = { x: transformVector[0], y: transformVector[1], z: transformVector[2] };
  const sliceStatus = model.jobState?.status;
  const sliceState = sliceStatus === 'pending' ? 'queued' : sliceStatus === 'running' ? 'running' : sliceStatus === 'completed' ? 'complete' : sliceStatus === 'failed' || sliceStatus === 'cancelled' ? 'failed' : 'idle';
  const result = model.result;

  return <div className="flex h-[calc(100vh-5rem)] min-h-[42rem] flex-col gap-1 overflow-hidden bg-[#202125] p-1">
    <SlicerTopBar
      backLabel="Return to source"
      onBack={onBack}
      mode={previewMode}
      onModeChange={setPreviewMode}
      title={model.sourceName}
      subtitle={`${schema.engine.name} ${schema.engine.version} · ${schema.schema_hash.slice(0, 10)}`}
      sliceState={sliceState}
      onSlice={() => void model.slice()}
      canSlice={model.request !== null}
      onPrint={() => setShowPrint(true)}
      canPrint={model.canPrint}
    />
    <div className="flex min-h-0 flex-1">
      <div style={{ width: sidebarWidth }} className="min-w-0 shrink-0">
        <SlicerSettingsSidebar
          printerName={selectedPresetName(model.printerPreset, model.printerOptions)}
          printerOptions={model.printerOptions.map(displayPreset)}
          onPrinterChange={(value) => choosePreset(value, model.printerOptions, model.setPrinterPreset)}
          filamentName={selectedPresetName(model.filamentPresets[0] ?? null, model.filamentOptions)}
          filamentOptions={model.filamentOptions.map(displayPreset)}
          onFilamentChange={(value) => choosePreset(value, model.filamentOptions, (ref) => model.setFilamentPresets(model.filamentPresets.map(() => ref)))}
          processName={selectedPresetName(model.processPreset, model.processOptions)}
          processOptions={model.processOptions.map(displayPreset)}
          onProcessChange={(value) => choosePreset(value, model.processOptions, model.setProcessPreset)}
          pages={pages}
          settings={settingRows}
          mode={model.mode}
          onModeChange={model.setMode}
          pageId={pageId}
          onPageChange={setPageId}
          scope={settingsScope}
          supportsObjectState={supportsModelState}
          onScopeChange={(scope) => model.setSettingsView(scope === 'object' ? 'objects' : 'global')}
          onSettingChange={(key, value) => {
            const option = model.schemaOptions.get(key);
            if (!option) return;
            const parsed = parseSettingValue(option, value);
            if (settingsScope === 'global') model.updateProcessOverride(key, parsed);
            else if (selectedObject && !selectedObject.locked) model.updateObject(selectedObject.id, { overrides: { ...selectedObject.overrides, [key]: parsed } });
          }}
          objects={model.objects.map((object) => ({ id: object.id, name: object.name, hidden: !object.visible, locked: object.locked }))}
          selectedObjectId={model.selectedObjectId ?? undefined}
          onObjectSelect={model.setSelectedObjectId}
          onObjectVisibilityChange={(id, hidden) => model.updateObject(id, { visible: !hidden })}
          onObjectLockChange={(id, locked) => model.updateObject(id, { locked })}
        />
      </div>
      <SlicerResizeHandle width={sidebarWidth} onChange={setSidebarWidth} />
      <SlicerCanvasWorkspace
        mode={previewMode}
        tool={tool}
        supportsObjectState={supportsModelState}
        onToolChange={setTool}
        selectedObject={selectedObject ? { id: selectedObject.id, name: selectedObject.name, hidden: !selectedObject.visible, locked: selectedObject.locked } : undefined}
        transform={transform}
        onTransformChange={(axis, value) => {
          if (!selectedObject || selectedObject.locked || !Number.isFinite(value) || (tool === 'scale' && value <= 0)) return;
          const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
          const next = [...transformVector] as [number, number, number];
          next[index] = value;
          model.updateObject(selectedObject.id, { transform: { ...selectedTransform, [tool === 'rotate' ? 'rotation' : tool === 'scale' ? 'scale' : 'position']: next } });
        }}
        onLayFlat={() => selectedObject && !selectedObject.locked && model.setLayFlatObjectIds(Array.from(new Set([...model.layFlatObjectIds, selectedObject.id])))}
        onArrange={() => model.setArrange(true)}
        plates={(model.platesQuery.data?.plates ?? []).map((plate) => ({ index: plate.index, name: plate.name || `Plate ${plate.index}`, objectCount: plate.object_count ?? plate.objects.length }))}
        selectedPlate={model.selectedPlate ?? 0}
        onPlateChange={model.setSelectedPlate}
        modelViewer={<ModelViewer url={model.modelUrl} fileType={filename.split('.').pop()} selectedPlateId={model.selectedPlate} filamentColors={model.selectedPlateMetadata?.filaments.map((filament) => filament.color)} className="h-full w-full" />}
        gcodeViewer={model.previewUrl ? <div className="relative h-full"><GcodeViewer gcodeUrl={model.previewUrl} filamentColors={model.selectedPlateMetadata?.filaments.map((filament) => filament.color)} className="h-full w-full" />{model.previewStale && <div className="absolute left-3 top-3 rounded-md border border-amber-400/40 bg-black/80 px-3 py-2 text-xs text-amber-300">Preview is stale. Slice again before printing.</div>}</div> : <div className="flex h-full items-center justify-center text-sm text-bambu-gray-light">Slice plate to generate preview.</div>}
      />
    </div>
    <SlicerFooter status={sliceStatus ?? 'Ready'} plateName={model.selectedPlateMetadata?.name || `Plate ${model.selectedPlate ?? 1}`} objectCount={model.objects.length} engine={`${schema.engine.version} · ${schema.schema_hash.slice(0, 8)}`} />
    {showPrint && result && <PrintModal
      mode="create"
      archiveId={'archive_id' in result ? result.archive_id : undefined}
      libraryFileId={'library_file_id' in result ? result.library_file_id : undefined}
      archiveName={result.name}
      onClose={() => setShowPrint(false)}
      onSuccess={() => setShowPrint(false)}
    />}
  </div>;
}
