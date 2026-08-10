import { useState } from 'react';
import type { SlicerCatalogClassification, SlicerCatalogGroups } from '../api/client';
import type { CatalogSliceSelectionState } from '../hooks/useCatalogSliceSelection';

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
  const selectedProcessId = selection.processChoice?.id ?? null;

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
        {selection.activePrinters.map((printer) => <option key={printer.id} value={printer.id}>{printer.name}</option>)}
      </select>
    </label>
    {selection.printerId !== null && <label className="block text-xs text-bambu-gray">
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

    {selection.selectedBinding && <div className={`rounded border px-2 py-1.5 text-xs ${selection.selectedBinding.readiness.state === 'blocked' ? 'border-red-500/40 text-red-300' : selection.selectedBinding.readiness.state === 'acknowledgement_required' ? 'border-amber-400/40 text-amber-300' : 'border-green-500/30 text-green-300'}`}>
      Readiness: {selection.selectedBinding.readiness.state}
      {selection.selectedBinding.readiness.reason_codes.length > 0 && ` · ${selection.selectedBinding.readiness.reason_codes.join(', ')}`}
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
        <ProfileGroups
          key={`${slot.slot_id ?? index}-${index}`}
          legend={filamentSlots.length === 1 ? 'Filament profile' : `Filament ${index + 1} · ${slot.type || 'unknown material'}`}
          profileType="filament"
          groups={selection.groups}
          selectedId={selection.filamentChoices[index]?.id ?? null}
          search={search}
          disabled={disabled || slot.used_in_plate === false}
          onChoose={(profile) => selection.chooseFilament(index, profile)}
        />
      ))}
    </>}

    {selection.needsAcknowledgement && <label className="flex items-start gap-2 rounded border border-amber-400/40 bg-amber-400/5 p-2 text-xs text-amber-200">
      <input
        type="checkbox"
        checked={selection.acknowledged}
        disabled={disabled}
        onChange={(event) => selection.setAcknowledged(event.target.checked)}
      />
      <span>
        Confirm current target and nozzle before slicing. {selection.acknowledgementReasons.join(', ')}
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
  selectedId,
  search,
  disabled,
  onChoose,
}: {
  legend: string;
  profileType: 'process' | 'filament';
  groups: SlicerCatalogGroups | undefined;
  selectedId: number | null;
  search: string;
  disabled: boolean;
  onChoose: (profile: SlicerCatalogClassification) => void;
}) {
  const term = search.trim().toLocaleLowerCase();
  const matches = (profile: SlicerCatalogClassification) =>
    profile.profile_type === profileType
    && (!term || profile.display_name.toLocaleLowerCase().includes(term));

  return <fieldset className="rounded border border-bambu-dark-tertiary p-2">
    <legend className="px-1 text-xs font-medium text-white">{legend}</legend>
    <div className="space-y-2">
      {groupOrder.map((group) => {
        const profiles = (groups?.[group] ?? []).filter(matches);
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
  group: keyof SlicerCatalogGroups;
  profiles: SlicerCatalogClassification[];
  selectedId: number | null;
  disabled: boolean;
  onChoose: (profile: SlicerCatalogClassification) => void;
}) {
  const groupDisabled = group === 'other_installed_printers' || group === 'incompatible';
  return <div className="space-y-1 py-1">
    {label && <p className="text-xs font-medium text-bambu-gray-light">{label}</p>}
    {profiles.length === 0 && <p className="text-xs text-bambu-gray">No profiles</p>}
    {profiles.map((profile) => {
      const profileDisabled = disabled || groupDisabled || !profile.classification.selectable;
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
            <span className={group === 'unclassified' ? 'text-amber-300' : 'text-bambu-gray'}>
              {group === 'unclassified' ? 'Manual confirmation required · ' : ''}
              {profile.classification.reason_details.join(', ')}
            </span>
          )}
        </span>
      </label>;
    })}
  </div>;
}
