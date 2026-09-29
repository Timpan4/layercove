import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Globe2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, type NetworkSite, type NetworkSiteInput } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { copyTextToClipboard } from '../utils/clipboard';
import { networkSiteHostname } from '../utils/networkSites';
import { Button } from './Button';
import { Card, CardContent, CardHeader } from './Card';

const emptySite: NetworkSiteInput = { name: '', site_number: 1, ipv4_cidr: '' };

function CopyCommand({ label, command }: { label: string; command: string }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const copy = async () => {
    const copied = await copyTextToClipboard(command);
    showToast(copied ? t('common.copied') : t('networkSites.copyFailed'), copied ? 'success' : 'error');
  };
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-bambu-gray">{label}</p>
      <div className="flex items-start gap-2 rounded-lg bg-bambu-dark p-2">
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-all text-xs text-white">{command}</code>
        <button type="button" onClick={copy} className="shrink-0 rounded p-1 text-bambu-gray hover:text-white" aria-label={t('common.copy')}>
          <Copy className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function SiteGuide({ site }: { site: NetworkSite }) {
  const { t } = useTranslation();
  const [printerIp, setPrinterIp] = useState('');
  const hostname = networkSiteHostname(site, printerIp);
  const forwarding = "printf 'net.ipv4.ip_forward = 1\\nnet.ipv6.conf.all.forwarding = 1\\n' | sudo tee /etc/sysctl.d/99-layercove-tailscale.conf >/dev/null\nsudo sysctl -p /etc/sysctl.d/99-layercove-tailscale.conf";

  return (
    <details className="rounded-lg border border-bambu-dark-tertiary p-3">
      <summary className="cursor-pointer text-sm font-medium text-white">{t('networkSites.setupGuide')}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-amber-400">{t('networkSites.printWarning')}</p>
        <p className="text-sm text-bambu-gray">{t('networkSites.prerequisites')}</p>
        <CopyCommand label={t('networkSites.install')} command="curl -fsSL https://tailscale.com/install.sh | sh" />
        <CopyCommand label={t('networkSites.join')} command="sudo tailscale up" />
        <CopyCommand label={t('networkSites.forwarding')} command={forwarding} />
        <CopyCommand
          label={t('networkSites.advertise')}
          command={`sudo tailscale set --advertise-routes=${site.four_via_six_cidr}`}
        />
        <p className="text-sm text-bambu-gray">
          {t('networkSites.approve')}{' '}
          <a className="text-bambu-green hover:underline" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noreferrer">
            {t('networkSites.openAdmin')}
          </a>
        </p>
        <div>
          <label htmlFor={`network-site-printer-ip-${site.id}`} className="mb-1 block text-sm text-bambu-gray">{t('networkSites.printerIp')}</label>
          <input
            id={`network-site-printer-ip-${site.id}`}
            type="text"
            value={printerIp}
            onChange={(event) => setPrinterIp(event.target.value)}
            placeholder={site.ipv4_cidr.replace('.0/24', '.87')}
            className="w-full rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-white"
          />
          {printerIp && !hostname && <p className="mt-1 text-xs text-red-400">{t('networkSites.invalidPrinterIp')}</p>}
        </div>
        {hostname && <CopyCommand label={t('networkSites.magicDns')} command={hostname} />}
        <p className="text-xs text-bambu-gray">{t('networkSites.discoveryNote')}</p>
      </div>
    </details>
  );
}

export function NetworkSitesPanel() {
  const { t } = useTranslation();
  const { authEnabled, hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<NetworkSiteInput>(emptySite);
  const canCreate = !authEnabled || hasPermission('printers:create');
  const canUpdate = !authEnabled || hasPermission('printers:update');
  const canDelete = !authEnabled || hasPermission('printers:delete');
  const visible = canCreate || canUpdate || canDelete;
  const { data: sites = [], isLoading } = useQuery({
    queryKey: ['networkSites'],
    queryFn: api.getNetworkSites,
    enabled: visible,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['networkSites'] });
    queryClient.invalidateQueries({ queryKey: ['printers'] });
  };
  const createSite = useMutation({
    mutationFn: api.createNetworkSite,
    onSuccess: () => {
      setForm(emptySite);
      refresh();
      showToast(t('networkSites.created'), 'success');
    },
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const updateSite = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<NetworkSiteInput> }) => api.updateNetworkSite(id, data),
    onSuccess: () => refresh(),
    onError: (error: Error) => showToast(error.message, 'error'),
  });
  const deleteSite = useMutation({
    mutationFn: api.deleteNetworkSite,
    onSuccess: () => refresh(),
    onError: (error: Error) => showToast(error.message, 'error'),
  });

  if (!visible) return null;

  return (
    <Card id="card-network-sites">
      <CardHeader>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          <Globe2 className="h-5 w-5 text-bambu-green" />
          {t('networkSites.title')}
        </h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-bambu-gray">{t('networkSites.description')}</p>
        {canCreate && (
          <form
            className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_7rem_1fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              createSite.mutate({ ...form, name: form.name.trim(), ipv4_cidr: form.ipv4_cidr.trim() });
            }}
          >
            <input aria-label={t('networkSites.name')} required maxLength={100} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t('networkSites.namePlaceholder')} className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-white" />
            <input aria-label={t('networkSites.siteNumber')} required type="number" min={1} max={65535} value={form.site_number} onChange={(event) => setForm({ ...form, site_number: Number(event.target.value) })} className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-white" />
            <input aria-label={t('networkSites.subnet')} required value={form.ipv4_cidr} onChange={(event) => setForm({ ...form, ipv4_cidr: event.target.value })} placeholder="192.168.1.0/24" className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark px-3 py-2 text-white" />
            <Button type="submit" disabled={createSite.isPending}><Plus className="h-4 w-4" />{t('common.add')}</Button>
          </form>
        )}
        {isLoading ? <p className="text-sm text-bambu-gray">{t('common.loading')}</p> : sites.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('networkSites.empty')}</p>
        ) : (
          <div className="space-y-3">
            {sites.map((site) => (
              <div key={site.id} className="space-y-3 rounded-lg border border-bambu-dark-tertiary p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-white">{site.name}</p>
                    <p className="text-xs text-bambu-gray">{t('networkSites.siteSummary', { number: site.site_number, subnet: site.ipv4_cidr, count: site.printer_count })}</p>
                  </div>
                  <div className="flex gap-1">
                    {canUpdate && <button type="button" className="rounded p-2 text-bambu-gray hover:text-white" aria-label={site.printer_count ? t('networkSites.rename') : t('common.edit')} onClick={() => {
                      const name = window.prompt(t('networkSites.renamePrompt'), site.name)?.trim();
                      if (!name) return;
                      const data: Partial<NetworkSiteInput> = { name };
                      if (site.printer_count === 0) {
                        const siteNumber = window.prompt(t('networkSites.siteNumber'), String(site.site_number));
                        if (siteNumber === null) return;
                        const subnet = window.prompt(t('networkSites.subnet'), site.ipv4_cidr)?.trim();
                        if (!subnet) return;
                        data.site_number = Number(siteNumber);
                        data.ipv4_cidr = subnet;
                      }
                      updateSite.mutate({ id: site.id, data });
                    }}><Pencil className="h-4 w-4" /></button>}
                    {canDelete && <button type="button" disabled={site.printer_count > 0} className="rounded p-2 text-bambu-gray hover:text-red-400 disabled:opacity-40" aria-label={t('common.delete')} onClick={() => { if (window.confirm(t('networkSites.deleteConfirm', { name: site.name }))) deleteSite.mutate(site.id); }}><Trash2 className="h-4 w-4" /></button>}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <CopyCommand label={t('networkSites.subnet')} command={site.ipv4_cidr} />
                  <CopyCommand label="4via6" command={site.four_via_six_cidr} />
                </div>
                <SiteGuide site={site} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
