import { useTranslation } from 'react-i18next';
import type { SlicerBedIssue } from '../../utils/slicerBed';

interface Props {
  profileName: string | undefined;
  revisionId: number | undefined;
  loading: boolean;
  failed: boolean;
  issue: SlicerBedIssue | null;
  onRetry: () => void;
}

/** Distinguish selection, loading, request failures and unusable profile data. */
export function SlicerBedStatus({ profileName, revisionId, loading, failed, issue, onRetry }: Props) {
  const { t } = useTranslation();
  if (!profileName) return <p role="status" className="p-5 text-sm text-bambu-gray-light">{t('slicerBed.selectPrinter')}</p>;
  if (loading) return <p role="status" className="p-5 text-sm text-bambu-gray-light">{t('slicerBed.loading')}</p>;
  return <div role="alert" className="space-y-2 p-5 text-sm text-bambu-gray-light">
    <p>{t(failed ? 'slicerBed.loadFailed' : 'slicerBed.unavailable', { profile: profileName })}</p>
    {revisionId === undefined ? <p>{t('slicerBed.missingRevision')}</p> : !failed && issue && <p>{t(`slicerBed.${issue}`)}</p>}
    {revisionId !== undefined && <p className="text-xs">{t('slicerBed.revision', { revision: revisionId })}</p>}
    {revisionId !== undefined && <button type="button" onClick={onRetry} className="rounded border border-white/20 px-3 py-2 text-white hover:bg-white/10">
      {t('slicerBed.retry')}
    </button>}
  </div>;
}
