import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  type Archive,
  type LibraryFile,
  type PresetRef,
  type SliceJobState,
  type SliceRequest,
  type SlicerModelObjectState,
  type SlicerModelTransform,
  type SlicerSchemaOption,
} from '../../api/client';
import { useSliceJobTracker } from '../../contexts/SliceJobTrackerContext';
import type { ArchivePlatesResponse, LibraryFilePlatesResponse } from '../../types/plates';
import {
  findPreset,
  findPresetByName,
  pickDefault,
  pickFilamentForSlot,
  pickProcessDefault,
} from '../../utils/slicePresetPicker';
import {
  buildCompatibilityIndex,
  presetCompatibility,
  type PrinterCompatibilityIndex,
} from '../../utils/slicerPrinterMatch';

export type WorkbenchSource = { kind: 'libraryFile' | 'archive'; id: number };
export type WorkbenchMode = 'simple' | 'advanced' | 'expert';
export type SettingValue = string | number | boolean | null | Array<string | number | boolean>;

export interface WorkbenchObject {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  transform: SlicerModelTransform;
  overrides: Record<string, SettingValue>;
}

const identityTransform = (): SlicerModelTransform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

function normalizeRequest(request: SliceRequest, supportsModelState = true): Record<string, unknown> {
  const normalized: Record<string, unknown> = Object.fromEntries(
    Object.entries(request).filter(([, value]) => value !== null && value !== undefined),
  );
  if (request.export_3mf === false) delete normalized.export_3mf;
  if (request.destination_artifact_kind === 'bambu_3mf') delete normalized.destination_artifact_kind;
  if (request.filament_presets?.length === 0) delete normalized.filament_presets;
  if (request.process_overrides && Object.keys(request.process_overrides).length === 0) {
    delete normalized.process_overrides;
  }
  if (request.model_state) {
    const modelState: Record<string, unknown> = {};
    if (request.model_state.objects.length > 0) {
      modelState.objects = request.model_state.objects.map((object) => ({
        id: object.id,
        ...(object.transform ? { transform: object.transform } : {}),
        ...(object.overrides && Object.keys(object.overrides).length > 0 ? { overrides: object.overrides } : {}),
      }));
    }
    if (request.model_state.hidden_object_ids.length > 0) {
      modelState.hidden_object_ids = request.model_state.hidden_object_ids;
    }
    if (request.model_state.lay_flat_object_ids.length > 0) {
      modelState.lay_flat_object_ids = request.model_state.lay_flat_object_ids;
    }
    if (request.model_state.arrange) modelState.arrange = true;
    if (Object.keys(modelState).length > 0) normalized.model_state = modelState;
    else delete normalized.model_state;
  }
  if (!supportsModelState) delete normalized.model_state;
  return normalized;
}

export function normalizeWorkbenchRequest(request: SliceRequest, supportsModelState: boolean): Record<string, unknown> {
  return normalizeRequest(request, supportsModelState);
}

export function canonicalRequest(request: SliceRequest): string {
  return JSON.stringify(sortValue(normalizeRequest(request)));
}

export function shouldRefreshSlicerSchema(
  jobState: Pick<SliceJobState, 'status' | 'error_code'> | undefined,
): boolean {
  return jobState?.status === 'failed' && jobState.error_code === 'slicer_schema_mismatch';
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function presetOptions(data: Awaited<ReturnType<typeof api.getSlicerPresets>> | undefined, slot: 'printer' | 'process' | 'filament') {
  if (!data) return [];
  return [data.local, data.orca_cloud, data.cloud, data.standard].flatMap((tier) => tier[slot]);
}

export function useSlicerWorkbench(source: WorkbenchSource, initialJobId: number | null) {
  const [, setSearchParams] = useSearchParams();
  const { trackJob, jobStates } = useSliceJobTracker();
  const [mode, setMode] = useState<WorkbenchMode>('simple');
  const [settingsView, setSettingsView] = useState<'global' | 'objects'>('global');
  const [selectedPlate, setSelectedPlate] = useState<number | null>(null);
  const [printerPreset, setPrinterPreset] = useState<PresetRef | null>(null);
  const [processPreset, setProcessPreset] = useState<PresetRef | null>(null);
  const [filamentPresets, setFilamentPresets] = useState<PresetRef[]>([]);
  const [bedType, setBedType] = useState<string | null>(null);
  const [processOverrides, setProcessOverrides] = useState<Record<string, SettingValue>>({});
  const [objects, setObjects] = useState<WorkbenchObject[]>([]);
  const [arrange, setArrange] = useState(false);
  const [layFlatObjectIds, setLayFlatObjectIds] = useState<string[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(initialJobId);
  const [requestFingerprint, setRequestFingerprint] = useState<string | null>(null);
  const refreshedSchemaJobs = useRef(new Set<number>());

  const capabilitiesQuery = useQuery({
    queryKey: ['slicer-capabilities'],
    queryFn: api.getSlicerCapabilities,
    retry: false,
  });
  const schemaQuery = useQuery({
    queryKey: ['slicer-process-schema', capabilitiesQuery.data?.schema_hash],
    queryFn: () => api.getSlicerProcessSchema(),
    enabled: capabilitiesQuery.data?.capabilities.process_schema === true,
    retry: false,
  });
  const sourceQuery = useQuery<Archive | LibraryFile>({
    queryKey: ['slicer-source', source.kind, source.id],
    queryFn: async () => source.kind === 'libraryFile' ? await api.getLibraryFile(source.id) : await api.getArchive(source.id),
    retry: false,
  });
  const platesQuery = useQuery<ArchivePlatesResponse | LibraryFilePlatesResponse>({
    queryKey: ['slicer-plates', source.kind, source.id],
    queryFn: async () => source.kind === 'libraryFile' ? await api.getLibraryFilePlates(source.id) : await api.getArchivePlates(source.id),
    retry: false,
  });
  const presetsQuery = useQuery({
    queryKey: ['slicer-presets', 'workbench'],
    queryFn: () => api.getSlicerPresets(),
    retry: false,
  });
  const printerModelsQuery = useQuery({
    queryKey: ['slicerPrinterModels'],
    queryFn: api.getSlicerPrinterModels,
    staleTime: Infinity,
    retry: false,
  });

  const printerOptions = useMemo(() => presetOptions(presetsQuery.data, 'printer'), [presetsQuery.data]);
  const processOptions = useMemo(() => presetOptions(presetsQuery.data, 'process'), [presetsQuery.data]);
  const filamentOptions = useMemo(() => presetOptions(presetsQuery.data, 'filament'), [presetsQuery.data]);

  const selectedPlateMetadata = useMemo(
    () => platesQuery.data?.plates.find((plate) => plate.index === selectedPlate) ?? platesQuery.data?.plates[0] ?? null,
    [platesQuery.data, selectedPlate],
  );
  const embeddedPrinter = platesQuery.data?.embedded_printer ?? null;
  const embeddedProcess = platesQuery.data?.embedded_process ?? null;
  const compatIndex = useMemo<PrinterCompatibilityIndex>(
    () => buildCompatibilityIndex(printerModelsQuery.data ?? {}),
    [printerModelsQuery.data],
  );
  const selectedPrinterName = useMemo(() => {
    if (!presetsQuery.data) return null;
    return findPreset(presetsQuery.data, printerPreset, 'printer')?.name ?? null;
  }, [presetsQuery.data, printerPreset]);
  const filamentSlots = useMemo(() => {
    const slots = selectedPlateMetadata?.filaments ?? [];
    return slots.length > 0 ? slots : [{ type: '', color: '' }];
  }, [selectedPlateMetadata]);

  useEffect(() => {
    const data = presetsQuery.data;
    if (!data || platesQuery.isPending) return;
    setPrinterPreset((current) => (
      current ?? findPresetByName(data, 'printer', embeddedPrinter) ?? pickDefault(data, 'printer')
    ));
  }, [presetsQuery.data, embeddedPrinter, platesQuery.isPending]);

  useEffect(() => {
    const data = presetsQuery.data;
    if (!data || platesQuery.isPending) return;
    setProcessPreset((current) => {
      if (current) {
        const preset = findPreset(data, current, 'process');
        if (preset && presetCompatibility(preset, 'process', selectedPrinterName, compatIndex) !== 'mismatch') {
          return current;
        }
      }
      return pickProcessDefault(data, selectedPrinterName, compatIndex, embeddedProcess);
    });
  }, [presetsQuery.data, selectedPrinterName, compatIndex, embeddedProcess, platesQuery.isPending]);

  useEffect(() => {
    if (selectedPlate === null && platesQuery.data?.plates[0]) {
      setSelectedPlate(platesQuery.data.plates[0].index);
    }
  }, [platesQuery.data, selectedPlate]);

  useEffect(() => {
    const data = presetsQuery.data;
    if (!data || platesQuery.isPending) return;
    setFilamentPresets((current) => filamentSlots.flatMap((slot, index) => {
      const selected = current[index] ?? null;
      if (selected) {
        const preset = findPreset(data, selected, 'filament');
        if (preset && presetCompatibility(preset, 'filament', selectedPrinterName, compatIndex) !== 'mismatch') {
          return [selected];
        }
      }
      const picked = pickFilamentForSlot(
        data,
        { type: slot.type, color: slot.color },
        selectedPrinterName,
        compatIndex,
      );
      return picked ? [picked] : [];
    }));
  }, [presetsQuery.data, filamentSlots, selectedPrinterName, compatIndex, platesQuery.isPending]);

  useEffect(() => {
    const ids = selectedPlateMetadata?.object_ids ?? [];
    setObjects(ids.map((id, index) => ({
      id,
      name: selectedPlateMetadata?.objects[index] ?? `Object ${id}`,
      visible: true,
      locked: false,
      transform: identityTransform(),
      overrides: {},
    })));
    setSelectedObjectId(ids[0] ?? null);
    setLayFlatObjectIds([]);
    setArrange(false);
  }, [selectedPlateMetadata]);

  const processProfileQuery = useQuery({
    queryKey: ['slicer-resolved-process', processPreset?.source, processPreset?.id],
    queryFn: () => api.getResolvedSlicerProfile('process', processPreset!),
    enabled: processPreset !== null,
    retry: false,
  });

  const sourceName = sourceQuery.data
    ? source.kind === 'archive'
      ? sourceQuery.data.print_name || sourceQuery.data.filename
      : sourceQuery.data.print_name || sourceQuery.data.filename
    : '';

  useEffect(() => {
    if (jobId !== null && sourceName) trackJob(jobId, source.kind, sourceName);
  }, [jobId, source.kind, sourceName, trackJob]);

  const supportsModelState = capabilitiesQuery.data?.capabilities.model_state === true;
  const request = useMemo<SliceRequest | null>(() => {
    const schemaHash = schemaQuery.data?.schema_hash;
    if (!schemaHash || !printerPreset || !processPreset || filamentPresets.length === 0) return null;
    const modelObjects: SlicerModelObjectState[] = objects.map((object) => ({
      id: object.id,
      ...(JSON.stringify(object.transform) === JSON.stringify(identityTransform()) ? {} : { transform: object.transform }),
      ...(Object.keys(object.overrides).length > 0 ? { overrides: object.overrides } : {}),
    }));
    return {
      printer_preset: printerPreset,
      process_preset: processPreset,
      filament_preset: filamentPresets[0],
      filament_presets: filamentPresets,
      ...(selectedPlate !== null ? { plate: selectedPlate } : {}),
      ...(bedType ? { bed_type: bedType } : {}),
      schema_hash: schemaHash,
      ...(Object.keys(processOverrides).length > 0 ? { process_overrides: processOverrides } : {}),
      ...(supportsModelState && (modelObjects.length > 0 || arrange || layFlatObjectIds.length > 0)
        ? {
            model_state: {
              objects: modelObjects,
              hidden_object_ids: objects.filter((object) => !object.visible).map((object) => object.id),
              lay_flat_object_ids: layFlatObjectIds,
              arrange,
            },
          }
        : {}),
    };
  }, [arrange, bedType, filamentPresets, layFlatObjectIds, objects, printerPreset, processOverrides, processPreset, schemaQuery.data?.schema_hash, selectedPlate, supportsModelState]);

  useEffect(() => {
    let cancelled = false;
    if (!request) {
      setRequestFingerprint(null);
      return;
    }
    void sha256(canonicalRequest(request)).then((fingerprint) => {
      if (!cancelled) setRequestFingerprint(fingerprint);
    });
    return () => { cancelled = true; };
  }, [request]);

  const updateProcessOverride = useCallback((key: string, value: SettingValue) => {
    const baseValue = processProfileQuery.data?.values[key] ?? schemaQuery.data?.samples[key];
    setProcessOverrides((current) => {
      if (JSON.stringify(value) === JSON.stringify(baseValue)) {
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: value };
    });
  }, [processProfileQuery.data?.values, schemaQuery.data?.samples]);

  const updateObject = useCallback((id: string, update: Partial<WorkbenchObject>) => {
    setObjects((current) => current.map((object) => object.id === id ? { ...object, ...update } : object));
  }, []);

  const slice = useCallback(async () => {
    if (!request || !sourceName) return;
    const response = source.kind === 'libraryFile'
      ? await api.sliceLibraryFile(source.id, request)
      : await api.sliceArchive(source.id, request);
    setJobId(response.job_id);
    trackJob(response.job_id, source.kind, sourceName);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('job', String(response.job_id));
      return next;
    }, { replace: true });
  }, [request, setSearchParams, source, sourceName, trackJob]);

  const jobState = jobId === null ? undefined : jobStates[jobId];
  useEffect(() => {
    if (jobId === null || !shouldRefreshSlicerSchema(jobState) || refreshedSchemaJobs.current.has(jobId)) return;
    refreshedSchemaJobs.current.add(jobId);
    void api.getSlicerProcessSchema(true)
      .then(() => Promise.all([capabilitiesQuery.refetch(), schemaQuery.refetch()]))
      .catch(() => undefined);
  }, [capabilitiesQuery, jobId, jobState, schemaQuery]);

  const previewStale = jobState?.status === 'completed'
    ? !requestFingerprint || jobState.request_fingerprint !== requestFingerprint
    : false;
  const result = jobState?.status === 'completed' ? jobState.result : undefined;
  const previewUrl = result && 'library_file_id' in result
    ? api.getLibraryFileGcodeUrl(result.library_file_id)
    : result && 'archive_id' in result
      ? api.getArchiveGcode(result.archive_id)
      : null;

  const schemaOptions = useMemo(
    () => new Map<string, SlicerSchemaOption>((schemaQuery.data?.options ?? []).map((option) => [option.key, option])),
    [schemaQuery.data?.options],
  );

  return {
    capabilitiesQuery,
    schemaQuery,
    sourceQuery,
    platesQuery,
    presetsQuery,
    processProfileQuery,
    sourceName,
    printerOptions,
    processOptions,
    filamentOptions,
    printerPreset,
    setPrinterPreset,
    processPreset,
    setProcessPreset,
    filamentPresets,
    setFilamentPresets,
    bedType,
    setBedType,
    selectedPlate,
    setSelectedPlate,
    selectedPlateMetadata,
    mode,
    setMode,
    settingsView,
    setSettingsView,
    processOverrides,
    updateProcessOverride,
    objects,
    updateObject,
    selectedObjectId,
    setSelectedObjectId,
    arrange,
    setArrange,
    layFlatObjectIds,
    setLayFlatObjectIds,
    schemaOptions,
    request,
    requestFingerprint,
    slice,
    jobId,
    jobState,
    result,
    previewUrl,
    previewStale,
    canPrint: jobState?.status === 'completed' && !previewStale,
    modelUrl: source.kind === 'libraryFile' ? api.getLibraryFileDownloadUrl(source.id) : api.getArchiveDownload(source.id),
  };
}
