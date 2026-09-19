import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type SlicerCatalogProfile } from '../api/client';
import { useAuth } from '../contexts/AuthContext';

const readOnly = new Set(['name', 'type', 'from', 'inherits', 'setting_id', 'filament_id', 'filament_settings_id',
  'version', 'instantiation', 'is_custom_defined', 'nozzle_diameter']);
const fields = [
  ['nozzle_temperature', 'Nozzle temperature (°C)'],
  ['nozzle_temperature_initial_layer', 'First-layer nozzle temperature (°C)'],
  ['hot_plate_temp', 'Smooth PEI bed temperature (°C)'],
  ['textured_plate_temp', 'Textured PEI bed temperature (°C)'],
  ['filament_flow_ratio', 'Flow ratio'],
  ['filament_max_volumetric_speed', 'Max volumetric speed (mm³/s)'],
  ['pressure_advance', 'Pressure advance'],
] as const;
const inputClass = 'w-full rounded border border-white/20 bg-bambu-dark p-2 text-sm text-white';

function editableFilamentSettings(content: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(content).filter(([key]) =>
    /^[a-z][a-z0-9_]*$/.test(key) && !readOnly.has(key) && !key.startsWith('compatible_')));
}

export function FilamentProfileEditor({ profile, onSaved, onClose }: {
  profile: SlicerCatalogProfile;
  onSaved: (profileId: number) => Promise<void>;
  onClose: () => void;
}) {
  const { hasPermission } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(`${profile.display_name} - edited`);
  const [text, setText] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedId, setSavedId] = useState<number | null>(null);
  const revision = useQuery({
    queryKey: ['slicerCatalogRevision', profile.revision_id],
    queryFn: () => api.getSlicerCatalogRevision(profile.revision_id),
    retry: false,
  });
  useEffect(() => {
    const dialog = dialogRef.current;
    // Native modal dialog supplies focus trapping, Escape and top-layer rendering.
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const original = useMemo(() => revision.data ? editableFilamentSettings(revision.data.content) : {}, [revision.data]);
  const currentText = text ?? JSON.stringify(original, null, 2);
  const parsed = useMemo(() => {
    try {
      const result = JSON.parse(currentText);
      return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : null;
    } catch { return null; }
  }, [currentText]);
  const changeField = (key: string, value: string) => {
    if (!parsed) return;
    const prior = parsed[key];
    // A one-tool field may be an Orca array. Keep that shape and every other slot.
    const scalar = Array.isArray(prior) ? prior[0] : prior;
    const next = typeof scalar === 'number' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : value;
    setText(JSON.stringify({ ...parsed, [key]: Array.isArray(prior) ? [next, ...prior.slice(1)] : next }, null, 2));
  };
  const save = async () => {
    if (!parsed || !revision.data) return;
    setSaving(true); setError('');
    try {
      let profileId = savedId;
      if (profileId === null) {
        const overrides = Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(original[key])));
        // Removing a setting is ambiguous for inherited presets; require a value.
        if (Object.keys(original).some((key) => !(key in parsed))) throw new Error('Keep existing setting keys; change their values instead of deleting them.');
        const saved = await api.copySlicerFilament(profile.profile_id, {
          base_revision_id: revision.data.id, name, overrides, share_local_copy: share,
        });
        profileId = saved.profile_id;
        setSavedId(profileId);
      }
      await onSaved(profileId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the filament profile.');
    } finally { setSaving(false); }
  };
  const locked = saving || savedId !== null;
  return createPortal(<dialog ref={dialogRef} aria-labelledby="filament-editor-title"
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
    className="m-auto max-h-[90vh] w-[min(42rem,95vw)] overflow-y-auto rounded-lg border border-white/20 bg-bambu-dark-secondary p-5 text-white backdrop:bg-black/60">
    <div className="flex items-center justify-between gap-4"><h2 id="filament-editor-title" className="text-lg font-semibold">Edit filament profile</h2>
      <button type="button" onClick={onClose} disabled={saving} aria-label="Close filament editor">Close</button></div>
    <p className="my-3 text-sm text-bambu-gray-light">Save an active local copy shared on this installation. The original profile and existing jobs stay unchanged. Compatibility declarations are preserved.</p>
    {revision.isLoading && <p>Loading profile…</p>}
    {revision.error && <p role="alert">Could not load the selected profile revision. {revision.error.message}</p>}
    {revision.data && <div className="space-y-4">
      <label className="block text-sm">Copy name<input className={inputClass} value={name} maxLength={300} disabled={locked} onChange={(e) => setName(e.target.value)} /></label>
      {fields.map(([key, label]) => {
        const value = parsed?.[key];
        return <label key={key} className="block text-sm">{label}<input className={inputClass} inputMode="decimal"
          value={String((Array.isArray(value) ? value[0] : value) ?? '')} disabled={locked || !parsed}
          placeholder="Inherited / unset" onChange={(e) => changeField(key, e.target.value)} /></label>;
      })}
      <details><summary className="cursor-pointer text-sm">All filament settings (JSON)</summary>
        <textarea aria-label="Filament settings JSON" className={`${inputClass} mt-2 h-72 font-mono text-xs`} value={currentText}
          spellCheck={false} disabled={locked} onChange={(e) => setText(e.target.value)} />
        {!parsed && <p role="alert">Enter a JSON object with filament setting values.</p>}
      </details>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={share} disabled={locked} onChange={(e) => setShare(e.target.checked)} />
        I confirm this copy can be shared with users of this installation.</label>
      {!hasPermission('settings:update') && <p role="alert">Saving profiles requires settings:update permission.</p>}
      {error && <p role="alert" className="text-red-300">{savedId !== null ? 'The copy was saved. ' : ''}{error}</p>}
      <button type="button" onClick={() => void save()} disabled={saving || !parsed || !name.trim() || !share || !hasPermission('settings:update')}
        className="rounded bg-bambu-green px-4 py-2 text-sm text-black disabled:opacity-40">{saving ? 'Saving…' : savedId !== null ? 'Use saved copy' : 'Save and use local copy'}</button>
    </div>}
  </dialog>, document.body);
}
