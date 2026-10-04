import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Download } from 'lucide-react';
import { Button } from './Button';
import { api } from '../api/client';

interface QRCodeModalProps {
  archiveId: number;
  archiveName: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}

export function QRCodeModal({ archiveId, archiveName, onClose, returnFocusTo }: QRCodeModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [returnFocusTo]);

  const qrCodeUrl = api.getArchiveQRCodeUrl(archiveId, 300);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = qrCodeUrl;
    link.download = `${archiveName}_qrcode.png`;
    link.click();
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-bambu-dark-secondary rounded-xl border border-bambu-dark-tertiary w-full max-w-sm"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          const panel = e.currentTarget;
          const controls = Array.from(panel.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
          )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (!first) {
            e.preventDefault();
            panel.focus();
          } else if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel)) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-bambu-dark-tertiary">
          <h2 id={titleId} className="text-lg font-semibold text-white">QR Code</h2>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="text-bambu-gray hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 flex flex-col items-center">
          <p className="text-sm text-bambu-gray mb-4 text-center truncate max-w-full">
            {archiveName}
          </p>
          <div className="bg-white p-4 rounded-lg mb-4">
            <img
              src={qrCodeUrl}
              alt="QR Code"
              className="w-64 h-64"
            />
          </div>
          <p className="text-xs text-bambu-gray mb-4 text-center">
            Scan to open this archive
          </p>
          <Button onClick={handleDownload} className="w-full">
            <Download className="w-4 h-4" />
            Download QR Code
          </Button>
        </div>
      </div>
    </div>
  );
}
