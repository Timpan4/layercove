import { useTranslation } from 'react-i18next';

export interface SlicerFooterProps {
  status?: string;
  plateName: string;
  objectCount: number | null;
  engine?: { label: string; hash: string };
  shortcutHint?: string;
}

export function SlicerFooter({ status, plateName, objectCount, engine, shortcutHint }: SlicerFooterProps) {
  const { t } = useTranslation();
  return <footer className="flex h-8 shrink-0 items-center gap-4 rounded-md border border-white/10 bg-[#292a2e] px-3 text-[10px] text-bambu-gray-light">
    {status && <span className="text-bambu-green">{status}</span>}
    <span>{plateName}</span>
    {objectCount !== null && <span>{t('slicerFooter.objectCount', { count: objectCount })}</span>}
    {engine && <span title={engine.hash}>{engine.label}</span>}
    {shortcutHint && <span className="ml-auto">{shortcutHint}</span>}
  </footer>;
}
