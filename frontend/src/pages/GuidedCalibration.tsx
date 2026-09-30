import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ArrowRight, Camera, Check, Layers, Minus, Play, Plus, Save, SlidersHorizontal, Upload } from 'lucide-react';
import { api, type CalibrationSession, type CalibrationStep, type Printer } from '../api/client';
import { TestIllustration } from './CalibrationIllustration';
import { calibrationTests } from './calibrationTests';
import { getAmsLabel, getGlobalTrayId } from '../utils/amsHelpers';
import './calibration-prototype.css';

const ids: CalibrationStep[] = ['temperature', 'flow_rate', 'pressure_advance', 'retraction', 'volumetric_flow'];
const fields = [
  { key: 'lowest', label: 'Lowest test value' }, { key: 'highest', label: 'Highest test value' },
  { key: 'increment', label: 'Step size' }, { key: 'baseline', label: 'Baseline value' },
] as const;
type Values = Record<(typeof fields)[number]['key'], string>;
const empty: Values = { lowest: '', highest: '', increment: '', baseline: '' };

export function GuidedCalibration({ printers }: { printers: Printer[] }) {
  const client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const sessionId = Number(search.get('calibrationSession')) || null;
  const catalog = useQuery({ queryKey: ['slicerCatalogProfiles'], queryFn: () => api.listSlicerCatalogProfiles() });
  const sessions = useQuery({ queryKey: ['calibrationSessions'], queryFn: api.listCalibrationSessions });
  const current = useQuery({ queryKey: ['calibrationSession', sessionId], queryFn: () => api.getCalibrationSession(sessionId!), enabled: sessionId !== null });
  const session = current.data;
  const printerStatus = useQuery({ queryKey: ['calibrationPrinterStatus', session?.printer_id],
    queryFn: () => api.getPrinterStatus(session!.printer_id), enabled: !!session });
  const amsTrays = printerStatus.data?.ams.flatMap(unit => unit.tray.filter(item => item.state !== 9 && !!item.tray_type).map(item => ({
    value: getGlobalTrayId(unit.id, item.id, false), label: `${getAmsLabel(unit.id, unit.tray.length)} · Slot ${item.id + 1} · ${item.tray_sub_brands || item.tray_type}`,
  }))) ?? [];
  const filaments = catalog.data?.filter(profile => profile.profile_type === 'filament' && !profile.tombstoned) ?? [];
  const [printerId, setPrinterId] = useState('');
  const [filamentId, setFilamentId] = useState('');
  const [nozzle, setNozzle] = useState('');
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Values>(empty);
  const [result, setResult] = useState('');
  const [name, setName] = useState('');
  const [shareCopy, setShareCopy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [bindingId, setBindingId] = useState('');
  const [processId, setProcessId] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [plateClear, setPlateClear] = useState(false);
  const [tray, setTray] = useState('');
  const [useAms, setUseAms] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const openedSession = useRef<number | null>(null);
  const step = calibrationTests[index];
  const id = ids[index];
  const bindings = useQuery({ queryKey: ['calibrationBindings', session?.printer_id],
    queryFn: () => api.listSlicerCatalogBindings(session!.printer_id), enabled: !!session });
  const availableBindings = bindings.data?.filter(binding => binding.is_active && binding.tool_index === session?.tool_index
    && binding.expected_nozzle_diameter === session?.nozzle_diameter) ?? [];
  const selectedBinding = availableBindings.find(binding => binding.id === Number(bindingId));
  const classification = useQuery({ queryKey: ['calibrationCompatibility', session?.printer_id, selectedBinding?.id],
    queryFn: () => api.getSlicerCatalogGroups(session!.printer_id, selectedBinding!.id), enabled: !!session && !!selectedBinding });
  const selectedProfiles = Object.values(classification.data ?? {}).flat().filter(profile =>
    profile.profile_id === Number(processId) || profile.profile_id === session?.filament_profile_id);
  const warnings = [...(selectedBinding?.readiness.reason_codes ?? []).map(reason => reason.replaceAll('_', ' ')),
    ...selectedProfiles.flatMap(profile => profile.classification.reason_details)];
  const compatibilityBlocked = selectedBinding?.readiness.state === 'blocked'
    || selectedProfiles.some(profile => !profile.classification.selectable);
  const needsAcknowledgement = selectedBinding?.readiness.state === 'acknowledgement_required'
    || selectedProfiles.some(profile => profile.classification.acknowledgement_required);
  const processes = catalog.data?.filter(profile => profile.profile_type === 'process' && !profile.tombstoned) ?? [];
  const runId = session?.runs[id];
  const job = useQuery({ queryKey: ['calibrationJob', runId], queryFn: () => api.getSliceJob(runId!), enabled: !!runId,
    refetchInterval: query => query.state.data && ['completed', 'failed', 'cancelled'].includes(query.state.data.status) ? false : 1000 });
  const printIds = Object.values(session?.prints ?? {});
  const prints = useQuery({ queryKey: ['calibrationPrints', sessionId, session?.prints],
    queryFn: () => Promise.all(printIds.map(printId => api.getQueueItem(printId))), enabled: printIds.length > 0,
    refetchInterval: query => query.state.data?.some(print => ['pending', 'printing'].includes(print.status)) ? 1000 : false });
  const activePrint = prints.data?.find(print => ['pending', 'printing'].includes(print.status));
  const currentPrint = prints.data?.find(print => print.id === session?.prints[id]);
  const evidence = useQuery({ queryKey: ['calibrationEvidence', sessionId], queryFn: () => api.listCalibrationEvidence(sessionId!), enabled: !!sessionId });
  const photos = evidence.data?.filter(photo => photo.step === id) ?? [];
  const photo = useQuery({ queryKey: ['calibrationPhoto', sessionId, photos[0]?.id],
    queryFn: () => api.getCalibrationPhoto(sessionId!, photos[0].id), enabled: !!photos[0] });
  const upload = useMutation({ mutationFn: async ({ file, source }: { file?: Blob; source: 'camera' | 'upload' }) => {
    if (!session) throw new Error('Start a calibration session first');
    const image = file ?? await api.captureCalibrationPhoto(session.printer_id);
    return api.uploadCalibrationEvidence(session.id, id, image, source);
  }, onSuccess: () => { void client.invalidateQueries({ queryKey: ['calibrationEvidence', sessionId] }); } });
  const filament = filaments.find(profile => profile.profile_id === Number(filamentId));
  const revision = useQuery({ queryKey: ['slicerCatalogRevision', session?.filament_revision_id],
    queryFn: () => api.getSlicerCatalogRevision(session!.filament_revision_id), enabled: !!session });
  const selectSession = (value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set('calibrationSession', value); else next.delete('calibrationSession');
    setSearch(next);
  };
  const mutate = useMutation({ mutationFn: (action: () => Promise<CalibrationSession>) => action(), onSuccess: saved => {
    client.setQueryData(['calibrationSession', saved.id], saved);
    void client.invalidateQueries({ queryKey: ['calibrationSessions'] });
    selectSession(String(saved.id));
  } });
  const completed = ids.filter(key => session?.results[key] !== undefined).length;
  const firstIncomplete = ids.findIndex(key => session?.results[key] === undefined);
  const locked = !session || !!session.saved_profile_id || mutate.isPending || !!activePrint || prints.isFetching && !prints.data && printIds.length > 0;
  const limit = session?.setting_limits[id];
  const withinLimits = (value: number) => Number.isFinite(value) && value >= Math.max(0, limit?.min ?? 0)
    && (limit?.max == null || value <= limit.max) && (limit?.item_type !== 'int' || Number.isInteger(value))
    && (['pressure_advance', 'retraction'].includes(id) || value > 0);
  const validResult = result.trim() !== '' && withinLimits(Number(result));
  const intervals = (Number(values.highest) - Number(values.lowest)) / Number(values.increment);
  const lastValue = Number(values.lowest) + Math.round(intervals) * Number(values.increment);
  const reachesHighest = Number.isFinite(intervals) && Math.abs(lastValue - Number(values.highest))
    <= Math.abs(Number(values.highest)) * Number.EPSILON;
  const validRange = Object.values(values).every(value => value.trim() !== '' && Number.isFinite(Number(value)))
    && ['lowest', 'highest', 'baseline'].every(key => withinLimits(Number(values[key as keyof typeof values])))
    && Number(values.highest) > Number(values.lowest) && Number(values.increment) > 0
    && Number(values.increment) <= Number(values.highest) - Number(values.lowest)
    && reachesHighest && (id !== 'temperature' || Number.isInteger(Number(values.increment)));
  const valuesChanged = !session?.parameters[id] || fields.some(field => values[field.key].trim() === ''
    || Number(values[field.key]) !== session.parameters[id]![field.key]);
  const savedResult = session?.results[id];

  useEffect(() => {
    if (session && openedSession.current !== session.id) {
      openedSession.current = session.id;
      const next = ids.findIndex(key => session.results[key] === undefined);
      setIndex(next < 0 ? ids.length - 1 : next);
      setConfirmed(false);
    } else if (!sessionId) { openedSession.current = null; setIndex(0); setConfirmed(false); }
  }, [sessionId, session]);
  useEffect(() => {
    const saved = session?.parameters[id];
    const setting = revision.data?.content[step.field];
    const baseline = Array.isArray(setting) ? setting[0] : setting;
    setValues(saved ? { lowest: String(saved.lowest), highest: String(saved.highest), increment: String(saved.increment), baseline: String(saved.baseline) }
      : { ...empty, baseline: typeof baseline === 'string' || typeof baseline === 'number' ? String(baseline) : '' });
  }, [sessionId, index, revision.data, session?.parameters, step.field, id]);
  useEffect(() => { setResult(savedResult === undefined ? '' : String(savedResult)); }, [sessionId, id, savedResult]);
  useEffect(() => {
    if (!photo.data) { setPhotoUrl(null); return; }
    const url = URL.createObjectURL(photo.data);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo.data]);
  useEffect(() => { setPlateClear(false); }, [sessionId, index, runId, currentPrint?.status]);
  const goTo = (next: number) => { setIndex(next); setConfirmed(false); mutate.reset(); };
  const record = () => {
    if (session && validResult) mutate.mutate(() => api.recordCalibrationResult(session.id, id, { version: session.version, value: Number(result) }), { onSuccess: () => setConfirmed(true) });
  };
  const control = (field: (typeof fields)[number]) => {
    const amount = Number(values.increment);
    const canStep = !locked && values[field.key] !== '' && Number.isFinite(Number(values[field.key])) && amount > 0;
    return <div className="cal-stepper-field" key={field.key}>
      <label><span>{field.label}</span><span className="cal-input-value"><input type="number" step={canStep ? amount : 'any'} disabled={locked}
        aria-label={field.label + ' (' + step.unit + ')'} value={values[field.key]} onChange={event => setValues(previous => ({ ...previous, [field.key]: event.target.value }))} /><span>{step.unit}</span></span></label>
      <div className="cal-stepper-buttons">{[-1, 1].map(direction => <button key={direction} className="cal-stepper-button" disabled={!canStep}
        aria-label={(direction < 0 ? 'Decrease' : 'Increase') + ' ' + field.label.toLowerCase()} onClick={event => {
          const input = event.currentTarget.closest('.cal-stepper-field')?.querySelector('input');
          if (input) { if (direction < 0) input.stepDown(); else input.stepUp(); setValues(previous => ({ ...previous, [field.key]: input.value })); }
        }}>{direction < 0 ? <Minus size={17} /> : <Plus size={17} />}</button>)}</div>
    </div>;
  };
  const error = mutate.error ?? upload.error ?? current.error ?? sessions.error ?? catalog.error ?? revision.error
    ?? bindings.error ?? job.error ?? prints.error ?? evidence.error ?? photo.error ?? printerStatus.error ?? classification.error;
  return <div className="cal-prototype cal-variant-b cal-live">
    <div className="cal-heading"><h1>Filament calibration</h1></div>
    {error && <p className="cal-error" role="alert">{error.message}</p>}
    <div className="cal-companion"><div className="cal-companion-main">
      <nav className="cal-steps" aria-label="Calibration steps">{calibrationTests.map((item, position) => <button key={item.field}
        disabled={!session || mutate.isPending || (firstIncomplete >= 0 && position > firstIncomplete)} onClick={() => goTo(position)}
        className={'cal-step ' + (position === index ? 'is-active' : '')} aria-current={position === index ? 'step' : undefined}>
        <span className="cal-step-number">{session?.results[ids[position]] !== undefined ? <Check size={14} /> : position + 1}</span>
        <span className="cal-step-text"><strong>{item.name}</strong><small>{session?.results[ids[position]] !== undefined ? session.results[ids[position]] + ' ' + item.unit : 'Not calibrated'}</small></span>
      </button>)}</nav>
      <section className="cal-work cal-card-b" aria-label={step.name + ' calibration'}>
        <header className="cal-work-heading"><div className="cal-work-title"><h2>{step.name}</h2><span className="cal-step-count">Step {index + 1} of {ids.length}</span></div><p>{step.purpose}</p></header>
        {confirmed ? <div className="cal-confirmed"><span className="cal-result-status">Result recorded</span><h3>{session?.results[id]} <span>{step.unit}</span></h3>
          {index < ids.length - 1 && <button className="cal-button cal-primary" onClick={() => goTo(index + 1)}>Next: {calibrationTests[index + 1].name}<ArrowRight size={16} /></button>}
          <button className="cal-text-button" onClick={() => setConfirmed(false)}>Edit result</button></div>
          : <div className="cal-inspector-layout"><div className="cal-model"><div className="cal-art">{photoUrl ? <img src={photoUrl} alt={'Your ' + step.name.toLowerCase() + ' test'} className="cal-review-photo" /> : <TestIllustration step={index} />}<span className="cal-art-caption">{photoUrl ? 'Your test photo' : 'Reference illustration'}</span></div><p>{step.look}</p>
            {session?.parameters[id] && job.data?.status === 'completed' && <p className="cal-caption">{id === 'temperature' ? `Hottest section at the bottom: ${session.parameters[id].lowest + Math.floor((session.parameters[id].highest - session.parameters[id].lowest) / session.parameters[id].increment) * session.parameters[id].increment} °C. Each section is ${25 * session.nozzle_diameter} mm tall. Count sections upward, subtracting the step size each time.`
              : id === 'flow_rate' ? 'Tiles are numbered from 1. Tile value = lowest value + (tile number − 1) × step size.'
              : id === 'pressure_advance' ? 'Measure height from the base in mm. PA = lowest value + whole mm × step size.'
              : id === 'retraction' ? 'Measure height from the base in mm. Retraction = lowest value + whole mm above 0.4 mm × step size.'
              : 'Measure height from the base in mm. Flow = lowest value + whole mm × step size.'}</p>}
            <div className="cal-evidence-actions"><button className="cal-button cal-secondary" disabled={!session || !!session.saved_profile_id || upload.isPending}
              onClick={() => upload.mutate({ source: 'camera' })}><Camera size={15} />Capture photo</button>
              <label className="cal-button cal-secondary cal-upload"><Upload size={15} />Upload photo<input type="file" accept="image/jpeg,image/png,image/webp"
                disabled={!session || !!session.saved_profile_id || upload.isPending} onChange={event => { const file = event.target.files?.[0]; if (file) upload.mutate({ file, source: 'upload' }); event.target.value = ''; }} /></label></div>
            <p className="cal-caption">{upload.isPending ? 'Saving photo…' : photos.length ? 'Photo saved with this step. Choose the result yourself.' : 'Capture the printer camera or upload a close-up for review.'}</p>
            {job.data && <p className="cal-caption" role="status">{job.data.status === 'completed' ? 'Test generated. Ready to print.' : job.data.status === 'failed' ? job.data.error_detail : 'Generating test: ' + (job.data.progress?.total_percent ?? 0) + '%'}</p>}
            {currentPrint && <p className="cal-caption" role="status">{currentPrint.status === 'completed' ? 'Print completed. Review the test and record your result.' : 'Test print: ' + currentPrint.status}{currentPrint.error_message ? '. ' + currentPrint.error_message : ''}</p>}
            {activePrint && <a className="cal-text-button" href="/queue">View print queue</a>}
          </div>
            <div className="cal-inspector-controls"><section className="cal-advanced" aria-label="Advanced calibration settings">
              <div className="cal-advanced-heading"><SlidersHorizontal size={15} /><h3>Advanced</h3></div>
              <div className="cal-advanced-body"><fieldset className="cal-range-editor"><legend>Test range</legend><div className="cal-range-pair">{fields.slice(0, 2).map(control)}</div></fieldset>
                <div className="cal-range-adjustments">{fields.slice(2).map(control)}</div>
                <button className="cal-button cal-secondary" disabled={locked || !validRange} onClick={() => {
                  if (session) mutate.mutate(() => api.updateCalibrationParameters(session.id, id, {
                    version: session.version, lowest: Number(values.lowest), highest: Number(values.highest), increment: Number(values.increment), baseline: Number(values.baseline),
                  }));
                }}>Save test values</button>
                {valuesChanged && <p className="cal-caption">Save these test values before generating or printing.</p>}
                {values.highest && values.lowest && values.increment && !reachesHighest && <p className="cal-caption">Step size must reach the highest test value.</p>}
                {limit && <p className="cal-caption">{limit.item_type === 'int' ? 'Whole numbers' : 'Numeric values'}{limit.max == null ? '' : `, up to ${limit.max} ${step.unit}`}.</p>}
                <button className="cal-button cal-secondary" disabled={locked || valuesChanged || !selectedBinding || !processId || !classification.data || compatibilityBlocked || needsAcknowledgement && !acknowledged || job.data?.status === 'pending' || job.data?.status === 'running'}
                  onClick={() => { if (session && selectedBinding) mutate.mutate(() => api.generateCalibrationTest(session.id, id, { version: session.version,
                    binding_id: selectedBinding.id, process_profile_id: Number(processId), acknowledge_compatibility: acknowledged })); }}><Layers size={15} />Generate test</button>
                <div className="cal-result-editor"><label><span>Custom result</span><span className="cal-input-value"><input type="number" step="any" value={result} disabled={locked}
                  aria-label={'Custom result (' + step.unit + ')'} placeholder="Your value" onChange={event => setResult(event.target.value)} /><span>{step.unit}</span></span></label>
                  <button className="cal-button cal-secondary" disabled={locked || !validResult} onClick={record}><Check size={15} />Use value</button>
                  <p className="cal-caption">{activePrint ? 'Wait for this print to finish before recording a result.' : 'Record a result with or without printing a test.'}</p>
                  {completed > index + 1 && <p className="cal-caption">Changing this result clears the later results.</p>}
                </div></div></section>
                <div className="cal-print-actions"><label className="cal-check"><input type="checkbox" checked={plateClear} disabled={locked || valuesChanged || job.data?.status !== 'completed'} onChange={event => setPlateClear(event.target.checked)} /><span>Plate clear. Correct filament loaded.</span></label>
                  <button className="cal-button cal-primary" disabled={locked || valuesChanged || !plateClear || job.data?.status !== 'completed' || useAms && !amsTrays.some(item => item.value === Number(tray))}
                    onClick={() => { if (session) mutate.mutate(() => api.printCalibrationTest(session.id, id, { version: session.version, plate_clear: true, use_ams: useAms, ams_mapping: useAms ? [Number(tray)] : null })); }}><Play size={15} />Print test</button>
                </div></div></div>}
      </section></div>
      <aside className="cal-companion-sidebar"><div className="cal-context-heading"><h3>Calibrating for</h3></div>
        <section className="cal-context" aria-label="Calibration context">
          <label>Resume session<select value={sessionId ?? ''} disabled={mutate.isPending} onChange={event => selectSession(event.target.value)}><option value="">New calibration</option>{sessions.data?.map(item => <option key={item.id} value={item.id}>#{item.id} · {printers.find(printer => printer.id === item.printer_id)?.name ?? 'Printer'} · {item.saved_profile_id ? 'Saved' : 'In progress'}</option>)}</select></label>
          <label>Printer<select aria-label="Printer" disabled={!!session || mutate.isPending} value={session?.printer_id ?? printerId} onChange={event => setPrinterId(event.target.value)}><option value="">Choose printer</option>{printers.map(printer => <option key={printer.id} value={printer.id}>{printer.name}</option>)}</select></label>
          <label>Filament<select aria-label="Filament" disabled={!!session || mutate.isPending} value={session?.filament_profile_id ?? filamentId} onChange={event => { setFilamentId(event.target.value); setName((filaments.find(profile => profile.profile_id === Number(event.target.value))?.display_name ?? 'Filament') + ' calibrated'); }}><option value="">Choose filament</option>{filaments.map(profile => <option key={profile.profile_id} value={profile.profile_id}>{profile.display_name}</option>)}</select></label>
          <label>Nozzle (mm)<input type="number" step="0.01" disabled={!!session || mutate.isPending} value={session?.nozzle_diameter ?? nozzle} onChange={event => setNozzle(event.target.value)} aria-label="Nozzle diameter (mm)" /></label>
          {session && <><label>Printer profile<select value={bindingId} disabled={locked} onChange={event => {
            setBindingId(event.target.value); setProcessId(String(availableBindings.find(binding => binding.id === Number(event.target.value))?.default_process_profile_id ?? '')); setAcknowledged(false);
          }}><option value="">Choose installed binding</option>{availableBindings.map(binding => <option key={binding.id} value={binding.id}>{binding.profile_name}</option>)}</select></label>
          <label>Process<select value={processId} disabled={locked} onChange={event => { setProcessId(event.target.value); setAcknowledged(false); }}><option value="">Choose process</option>{processes.map(profile => <option key={profile.profile_id} value={profile.profile_id}>{profile.display_name}</option>)}</select></label>
          {warnings.length > 0 && <p className="cal-caption" role="status">{[...new Set(warnings)].join('. ')}.</p>}
          {needsAcknowledgement && !compatibilityBlocked && <label className="cal-check"><input type="checkbox" checked={acknowledged} disabled={locked} onChange={event => setAcknowledged(event.target.checked)} /><span>I checked these warnings and confirm the selected profiles.</span></label>}
          {printers.find(printer => printer.id === session.printer_id)?.provider === 'bambu' && <><label className="cal-check"><input type="checkbox" checked={useAms} disabled={locked} onChange={event => setUseAms(event.target.checked)} /><span>Use AMS</span></label>
            {useAms && <label>Filament slot<select value={tray} disabled={locked} onChange={event => setTray(event.target.value)}><option value="">Choose loaded filament</option>{amsTrays.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>}
            {!useAms && <p className="cal-caption">Load this filament on the external spool holder.</p>}</>}
          {!availableBindings.length && <p className="cal-caption">Set up this printer's slicer binding in Profiles to generate tests.</p>}</>}
          {!session && <button className="cal-button cal-primary" disabled={!printerId || !filament || !nozzle || Number(nozzle) <= 0 || mutate.isPending} onClick={() => {
            if (filament) mutate.mutate(() => api.createCalibrationSession({ printer_id: Number(printerId), filament_profile_id: filament.profile_id, filament_revision_id: filament.revision_id, nozzle_diameter: Number(nozzle) }));
          }}>Start calibration</button>}
        </section>
        <section className="cal-summary" aria-label="Profile preview"><div className="cal-between"><h3>Your profile</h3><span>{completed} of {ids.length}</span></div>
          <dl>{calibrationTests.map((item, position) => <div key={item.field}><dt>{item.name}</dt><dd>{session?.results[ids[position]] !== undefined ? session.results[ids[position]] + ' ' + item.unit : '—'}</dd></div>)}</dl>
          <label className="cal-profile-name">Profile name<input type="text" value={name} disabled={locked} onChange={event => setName(event.target.value)} /></label>
          <label className="cal-check"><input type="checkbox" checked={shareCopy} disabled={locked} onChange={event => setShareCopy(event.target.checked)} /><span>Share this copy on this installation</span></label>
          <button className="cal-button cal-secondary" disabled={locked || completed !== ids.length || !name.trim() || !shareCopy} onClick={() => {
            if (session) mutate.mutate(() => api.saveCalibrationProfile(session.id, { version: session.version, name, share_local_copy: shareCopy }), { onSuccess: () => { void client.invalidateQueries({ queryKey: ['slicerCatalogProfiles'] }); } });
          }}><Save size={15} />{session?.saved_profile_id ? 'Profile saved' : 'Save profile copy'}</button>
          <p className="cal-caption">{session?.saved_profile_id ? 'Saved profile #' + session.saved_profile_id + '. Your original remains intact.' : 'A calibrated copy keeps your original preset intact.'}</p>
        </section></aside></div>
  </div>;
}
