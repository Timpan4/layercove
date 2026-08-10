import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GcodeViewer } from '../components/GcodeViewer';
import { ModelViewer } from '../components/ModelViewer';
import { PrintModal } from '../components/PrintModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { Button } from '../components/Button';
import { Card, CardContent } from '../components/Card';
import {
  ApiError,
  api,
  type ResliceRequestResponse,
  type SliceJobState,
  type SliceRequest,
  type SlicerSchemaOption,
} from '../api/client';
import { CatalogSliceSelector } from '../components/CatalogSliceSelector';
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

interface HistoricalResliceModel {
  jobId: number | null;
  jobState: SliceJobState | undefined;
  enqueue: (request: SliceRequest, sourceOverride?: WorkbenchSource) => Promise<void>;
}

export function HistoricalReslice({ model }: { model: HistoricalResliceModel }) {
  const [prepared, setPrepared] = useState<ResliceRequestResponse | null>(null);
  const [mode, setMode] = useState<'exact' | 'upgrade' | null>(null);
  const [tombstone, setTombstone] = useState(false);
  const [tombstoneAcknowledged, setTombstoneAcknowledged] = useState(false);
  const [safetyWarning, setSafetyWarning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provenance = model.jobState?.provenance;
  const terminal = ['completed', 'failed', 'cancelled'].includes(model.jobState?.status ?? '');
  if (model.jobId === null || !terminal || !provenance) return null;

  if (
    provenance.state !== 'resolved'
    || provenance.printer_revision_id === null
    || provenance.process_revision_id === null
    || provenance.filament_revision_ids === null
  ) {
    return <Card className="mx-3 mb-2 border-amber-400/30 bg-bambu-dark">
      <CardContent className="p-3 text-sm text-white">
        <p className="font-semibold">Historical slicer provenance unknown</p>
        <p className="mt-1 text-bambu-gray-light">This legacy job has no exact retained revisions. Exact re-slicing is unavailable.</p>
      </CardContent>
    </Card>;
  }

  const prepare = async (
    nextMode: 'exact' | 'upgrade',
    acknowledgements: {
      safety?: Record<string, unknown>;
      tombstone?: Record<string, unknown>;
    } = {},
  ) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.prepareResliceRequest(model.jobId!, {
        mode: nextMode,
        ...(acknowledgements.safety ? { catalog_acknowledgement: acknowledgements.safety } : {}),
        ...(acknowledgements.tombstone
          ? { catalog_tombstone_acknowledgement: acknowledgements.tombstone }
          : {}),
      });
      setMode(nextMode);
      if (response.tombstoned && !acknowledgements.tombstone) {
        setTombstone(true);
        setPrepared(null);
      } else {
        setPrepared(response);
        setTombstone(false);
        setSafetyWarning(false);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Historical re-slice could not be prepared.');
    } finally {
      setLoading(false);
    }
  };

  const enqueue = async () => {
    if (!prepared || !mode) return;
    setLoading(true);
    setError(null);
    try {
      await model.enqueue(prepared.request, {
        kind: prepared.source_kind === 'library_file' ? 'libraryFile' : 'archive',
        id: prepared.source_id,
      });
      setPrepared(null);
      setMode(null);
      setTombstoneAcknowledged(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'slicer_acknowledgement_required') {
        setPrepared(null);
        setSafetyWarning(true);
      } else {
        setError(caught instanceof Error ? caught.message : 'Historical re-slice could not be enqueued.');
      }
    } finally {
      setLoading(false);
    }
  };

  return <>
    <Card className="mx-3 mb-2 border-bambu-green/30 bg-bambu-dark">
      <CardContent className="p-3 text-sm text-white">
        <p className="font-semibold">Pinned catalog revisions</p>
        <p className="mt-1 text-bambu-gray-light">Printer {provenance.printer_revision_id} · Process {provenance.process_revision_id} · Filament {provenance.filament_revision_ids.join(', ') || 'none'}</p>
        {error && <p role="alert" className="mt-2 text-red-300">{error}</p>}
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={() => void prepare('exact')} disabled={loading}>Exact historical</Button>
          <Button variant="secondary" onClick={() => void prepare('upgrade')} disabled={loading}>Upgrade catalog</Button>
        </div>
      </CardContent>
    </Card>
    {tombstone && mode && <ConfirmModal
      title="Tombstoned historical revisions"
      message="Some pinned catalog revisions are tombstoned. Continue only if you explicitly accept those retained revisions; this will not silently upgrade the slice."
      confirmText="Acknowledge and preview"
      variant="warning"
      isLoading={loading}
      onCancel={() => { setTombstone(false); setTombstoneAcknowledged(false); setMode(null); }}
      onConfirm={() => {
        setTombstoneAcknowledged(true);
        void prepare(mode, { tombstone: { confirmed: true } });
      }}
    />}
    {safetyWarning && mode && <ConfirmModal
      title="Confirm current target and nozzle"
      message="Current target or nozzle telemetry requires acknowledgement. Safety will still be rechecked when the new job is enqueued; a confirmed mismatch cannot be overridden."
      confirmText="Acknowledge and preview"
      variant="warning"
      isLoading={loading}
      onCancel={() => { setSafetyWarning(false); setMode(null); }}
      onConfirm={() => void prepare(mode, {
        safety: { confirmed: true },
        ...(tombstoneAcknowledged ? { tombstone: { confirmed: true } } : {}),
      })}
    />}
    {prepared && mode && <ConfirmModal
      title={mode === 'exact' ? 'Confirm exact historical re-slice' : 'Confirm catalog upgrade'}
      message={`This is a preview. Printer revision ${prepared.revision_ids.printer}, process revision ${prepared.revision_ids.process}, filament revisions ${prepared.revision_ids.filaments.join(', ') || 'none'} will be enqueued.`}
      confirmText="Confirm re-slice"
      isLoading={loading}
      onCancel={() => {
        setPrepared(null);
        setMode(null);
        setTombstoneAcknowledged(false);
      }}
      onConfirm={() => void enqueue()}
    />}
  </>;
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

  const loading = model.capabilitiesQuery.isLoading || model.schemaQuery.isLoading || model.sourceQuery.isLoading || model.platesQuery.isLoading || model.catalogSelection.loading;
  if (loading) return <div className="flex min-h-[60vh] items-center justify-center text-bambu-gray-light"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading slicer workbench…</div>;

  const failedQuery = [model.capabilitiesQuery, model.schemaQuery, model.sourceQuery, model.platesQuery].find((query) => query.isError);
  if (failedQuery) return <ErrorState message={failedQuery.error instanceof Error ? failedQuery.error.message : 'Required slicer data could not be loaded.'} onBack={onBack} />;
  if (model.catalogSelection.error) return <ErrorState message={model.catalogSelection.error instanceof Error ? model.catalogSelection.error.message : 'Catalog selection could not be loaded.'} onBack={onBack} />;
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
          selectionPanel={<CatalogSliceSelector selection={model.catalogSelection} filamentSlots={model.filamentSlots} />}
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
    <HistoricalReslice model={model} />
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
