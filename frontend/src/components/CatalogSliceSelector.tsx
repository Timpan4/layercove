import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FilamentProfileEditor } from './FilamentProfileEditor';
import type { SlicerCatalogClassification, SlicerCatalogGroups } from '../api/client';
import type { CatalogSliceSelectionState } from '../hooks/useCatalogSliceSelection';
import { catalogFilamentMaterial } from '../utils/catalogSliceSelection';
import { canonicalFilamentType } from '../utils/amsHelpers';

const fieldClass = 'min-h-9 w-full rounded border border-bambu-dark-tertiary bg-bambu-dark px-2 text-sm text-white';
const groupOrder: Array<keyof SlicerCatalogGroups> = [
  'selected_printer',
  'other_installed_printers',
  'unclassified',
  'incompatible',
];
const groupLabels: Record<keyof SlicerCatalogGroups, string> = {
  selected_printer: 'Selected printer',
  other_installed_printers: 'Other installed printers',
  unclassified: 'Unclassified',
  incompatible: 'Incompatible',
};

export function CatalogSliceSelector({
  selection,
  filamentSlots,
  disabled = false,
}: {
  selection: CatalogSliceSelectionState;
  filamentSlots: Array<{ slot_id?: number; type: string; color: string; used_in_plate?: boolean }>;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const selectedProcessId = selection.processChoice?.id ?? null;
  const selectedPrinter = selection.activePrinters.find((printer) => printer.id === selection.printerId);
  const otherAcknowledgementReasons = selection.acknowledgementReasons.filter(
    (reason) => reason !== 'material_mismatch' && reason !== 'material_unverified',
  );

  return <div className="space-y-3" aria-label="Installed printer slicer selection">
    <label className="block text-xs text-bambu-gray">
      Physical printer
      <select
        aria-label="Physical printer"
        className={`${fieldClass} mt-1`}
        value={selection.printerId ?? ''}
        disabled={disabled}
        onChange={(event) => selection.setPrinterId(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">Choose physical printer</option>
        {selection.activePrinters.map((printer) => {
          const bindings = selection.printerBindings.filter((binding) => binding.is_active && binding.printer_id === printer.id);
          const detail = bindings.length === 1
            ? `${bindings[0].profile_name} · ${bindings[0].expected_nozzle_diameter} mm · tool ${bindings[0].tool_index}`
            : bindings.length > 1 ? `${bindings.length} presets` : null;
          return <option key={printer.id} value={printer.id}>
            {printer.name}{printer.model && printer.model !== printer.name ? ` · ${printer.model}` : ''}
            {detail && ` · ${detail}`}
          </option>;
        })}
      </select>
    </label>
    {selection.printerId !== null && !(selection.activeBindings.length === 1 && selection.activeBindings[0].confirmed_at) && <label className="block text-xs text-bambu-gray">
      Exact printer profile, nozzle, and tool
      <select
        aria-label="Exact slicer binding"
        className={`${fieldClass} mt-1`}
        value={selection.bindingId ?? ''}
        disabled={disabled || selection.loading}
        onChange={(event) => selection.setBindingId(event.target.value ? Number(event.target.value) : null)}
      >
        <option value="">Choose exact binding</option>
        {selection.activeBindings.map((binding) => (
          <option key={binding.id} value={binding.id}>
            {binding.profile_name} · {binding.expected_nozzle_diameter} mm · tool {binding.tool_index}
          </option>
        ))}
      </select>
    </label>}

    {selectedPrinter && !selection.loading && !selection.error && selection.activeBindings.length === 0 && (
      <p role="status" className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
        {selectedPrinter.name} has no active slicer binding. Add one before slicing.{' '}
        <Link className="rounded-sm font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-bambu-green" to={`/#slicer-binding-${selectedPrinter.id}`}>
          Set up {selectedPrinter.name} binding
        </Link>
      </p>
    )}

    {selection.selectedBinding && <div className={`rounded border px-2 py-1.5 text-xs ${selection.selectionReadiness.state === 'blocked' ? 'border-red-500/40 text-red-300' : selection.selectionReadiness.state === 'acknowledgement_required' ? 'border-amber-400/40 text-amber-300' : 'border-green-500/30 text-green-300'}`}>
      Readiness: {selection.selectionReadiness.state}
      {selection.selectionReadiness.reason_codes.length > 0 && ` · ${selection.selectionReadiness.reason_codes.join(', ')}`}
      {' · '}Nozzle {selection.selectedBinding.nozzle.status}
      {selection.selectedBinding.nozzle.diameter != null && ` ${selection.selectedBinding.nozzle.diameter} mm`}
    </div>}

    {selection.bindingId !== null && <>
      <label className="block text-xs text-bambu-gray">
        Search profiles
        <input
          aria-label="Search catalog profiles"
          className={`${fieldClass} mt-1`}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <ProfileGroups
        legend="Process profile"
        profileType="process"
        groups={selection.groups}
        selectedId={selectedProcessId}
        search={search}
        disabled={disabled}
        onChoose={selection.chooseProcess}
      />
      {filamentSlots.map((slot, index) => (
        <div key={`${slot.slot_id ?? index}-${index}`}>
        <ProfileGroups
          legend={filamentSlots.length === 1 ? 'Filament profile' : `Filament ${index + 1} · ${slot.type || 'unknown material'}`}
          profileType="filament"
          groups={selection.groups}
          profiles={selection.catalogProfiles}
          material={slot.type}
          selectedId={selection.filamentChoices[index]?.id ?? null}
          search={search}
          disabled={disabled || slot.used_in_plate === false}
          onChoose={(profile) => selection.chooseFilament(index, profile)}
        />
        {selection.equivalentFilamentSlotCounts[index] > 0 && selection.selectedFilamentProfiles[index] && <button
          type="button" disabled={disabled} className="mt-1 text-xs text-bambu-green underline disabled:opacity-40"
          onClick={() => selection.applyFilamentToEquivalentSlots(index)}>
          Apply {selection.selectedFilamentProfiles[index]!.display_name} to {selection.equivalentFilamentSlotCounts[index]} other {slot.type} slots
        </button>}
        {selection.selectedFilamentProfiles?.[index] && <button type="button" disabled={disabled || slot.used_in_plate === false}
          className="mt-1 text-xs text-bambu-green underline disabled:opacity-40" onClick={() => setEditingSlot(index)}>
          Edit filament {index + 1} settings
        </button>}
        </div>
      ))}
    </>}

    {editingSlot !== null && selection.selectedFilamentProfiles?.[editingSlot] && <FilamentProfileEditor
      key={`${selection.bindingId}-${editingSlot}-${selection.selectedFilamentProfiles[editingSlot]!.revision_id}`}
      profile={selection.selectedFilamentProfiles[editingSlot]!}
      onSaved={(profileId) => selection.selectSavedFilament(editingSlot, profileId)}
      onClose={() => setEditingSlot(null)} />}

    {selection.needsAcknowledgement && <label className="flex items-start gap-2 rounded border border-amber-400/40 bg-amber-400/5 p-2 text-xs text-amber-900 dark:text-amber-200">
      <input
        type="checkbox"
        checked={selection.acknowledged}
        disabled={disabled}
        onChange={(event) => selection.setAcknowledged(event.target.checked)}
      />
      <span>
        {selection.materialWarnings.length > 0
          ? `Confirm filament materials${otherAcknowledgementReasons.length > 0 ? ' and current target/nozzle' : ''} before slicing.`
          : 'Confirm current target and nozzle before slicing.'}
        {selection.materialWarnings.map((warning) => <span key={warning.message} className="block">{warning.message}</span>)}
        {otherAcknowledgementReasons.length > 0 && <span className="block">{otherAcknowledgementReasons.join(', ')}</span>}
      </span>
    </label>}
    {selection.error && <p role="alert" className="text-xs text-red-400">
      {selection.error instanceof Error ? selection.error.message : 'Catalog selection could not load.'}
    </p>}
  </div>;
}

function ProfileGroups({
  legend,
  profileType,
  groups,
  profiles,
  material,
  selectedId,
  search,
  disabled,
  onChoose,
}: {
  legend: string;
  profileType: 'process' | 'filament';
  groups: SlicerCatalogGroups | undefined;
  profiles?: CatalogSliceSelectionState['catalogProfiles'];
  material?: string;
  selectedId: number | null;
  search: string;
  disabled: boolean;
  onChoose: (profile: SlicerCatalogClassification) => void;
}) {
  const term = search.trim().toLocaleLowerCase();
  const matches = (profile: SlicerCatalogClassification) =>
    profile.profile_type === profileType
    && (!term || profile.display_name.toLocaleLowerCase().includes(term));
  const selected = Object.values(groups ?? {}).flat().find((profile) => profile.profile_id === selectedId && profile.profile_type === profileType);
  const materialKey = canonicalFilamentType(material);
  const materialMatches = materialKey && profiles
    ? [groups?.selected_printer ?? [], groups?.unclassified ?? []].flat().filter((profile) =>
      profile.profile_type === 'filament' && profile.classification.selectable
      && catalogFilamentMaterial(profiles.find((item) => item.profile_id === profile.profile_id
        && item.revision_id === profile.revision_id)) === materialKey)
    : [];
  const visibleMaterialMatches = materialMatches.filter(matches);
  const matchedIds = new Set(materialMatches.map((profile) => profile.profile_id));

  return <fieldset className="rounded border border-bambu-dark-tertiary p-2">
    <legend className="px-1 text-xs font-medium text-white">{legend}</legend>
    <p className="mb-1 break-words text-xs text-white" aria-live="polite">Selected: {selected?.display_name ?? 'None'}</p>
    <div className="space-y-2">
      {visibleMaterialMatches.length > 0 && <ProfileList
        label={`${material} matches (${visibleMaterialMatches.length})`}
        group={null}
        profiles={visibleMaterialMatches}
        selectedId={selectedId}
        disabled={disabled}
        onChoose={onChoose}
      />}
      {groupOrder.map((group) => {
        const profiles = (groups?.[group] ?? []).filter((profile) => matches(profile) && !matchedIds.has(profile.profile_id));
        if (group === 'selected_printer') {
          return <ProfileList
            key={group}
            label={`${groupLabels[group]} (${profiles.length})`}
            group={group}
            profiles={profiles}
            selectedId={selectedId}
            disabled={disabled}
            onChoose={onChoose}
          />;
        }
        return <details key={group} className="rounded border border-white/10 px-2 py-1">
          <summary className="cursor-pointer text-xs text-bambu-gray-light">
            {groupLabels[group]} ({profiles.length})
          </summary>
          <ProfileList
            group={group}
            profiles={profiles}
            selectedId={selectedId}
            disabled={disabled}
            onChoose={onChoose}
          />
        </details>;
      })}
    </div>
  </fieldset>;
}

function ProfileList({
  label,
  group,
  profiles,
  selectedId,
  disabled,
  onChoose,
}: {
  label?: string;
  group: keyof SlicerCatalogGroups | null;
  profiles: SlicerCatalogClassification[];
  selectedId: number | null;
  disabled: boolean;
  onChoose: (profile: SlicerCatalogClassification) => void;
}) {
  return <div className="space-y-1 py-1">
    {label && <p className="text-xs font-medium text-bambu-gray-light">{label}</p>}
    {profiles.length === 0 && <p className="text-xs text-bambu-gray">No profiles</p>}
    {profiles.map((profile) => {
      const profileGroup = group ?? profile.classification.group;
      const profileDisabled = disabled || profileGroup === 'other_installed_printers' || profileGroup === 'incompatible' || !profile.classification.selectable;
      return <label key={profile.profile_id} className={`flex items-start gap-2 rounded px-1 py-1 text-xs ${profileDisabled ? 'text-bambu-gray/60' : 'text-white'}`}>
        <input
          type="radio"
          checked={selectedId === profile.profile_id}
          disabled={profileDisabled}
          onChange={() => onChoose(profile)}
        />
        <span className="min-w-0">
          <span className="block truncate">{profile.display_name} · {profile.source}</span>
          {profile.classification.reason_details.length > 0 && (
            <span className={profileGroup === 'unclassified' ? 'text-amber-300' : 'text-bambu-gray'}>
              {profileGroup === 'unclassified' ? 'Manual confirmation required · ' : ''}
              {profile.classification.reason_details.join(', ')}
            </span>
          )}
        </span>
      </label>;
    })}
  </div>;
}
