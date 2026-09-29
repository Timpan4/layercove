import type { NetworkSite } from '../api/client';

export function networkSiteHostname(
  site: Pick<NetworkSite, 'site_number' | 'ipv4_cidr'>,
  lanIp: string,
): string | null {
  const octets = lanIp.trim().split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  const siteOctets = site.ipv4_cidr.replace('/24', '').split('.').map(Number);
  if (siteOctets.length !== 4 || octets.slice(0, 3).some((part, index) => part !== siteOctets[index])) {
    return null;
  }
  if (octets[3] === 0 || octets[3] === 255) return null;
  return `${octets.join('-')}-via-${site.site_number}`;
}

export function networkSiteMoonrakerUrls(
  baseUrl: string,
  websocketUrl: string,
  hostname: string,
  port: number,
): { baseUrl: string; websocketUrl?: string } {
  let baseProtocol = 'http:';
  try {
    baseProtocol = new URL(baseUrl).protocol;
  } catch {
    // A new site connection defaults to plain HTTP on Moonraker's normal port.
  }

  let normalizedWebsocket: string | undefined;
  if (websocketUrl.trim()) {
    let websocketProtocol = baseProtocol === 'https:' ? 'wss:' : 'ws:';
    let websocketPath = '';
    try {
      const parsed = new URL(websocketUrl);
      websocketProtocol = parsed.protocol;
      websocketPath = parsed.pathname === '/' ? '' : parsed.pathname;
    } catch {
      // Let backend URL validation reject malformed custom values.
    }
    normalizedWebsocket = `${websocketProtocol}//${hostname}:${port}${websocketPath}`;
  }

  return {
    baseUrl: `${baseProtocol}//${hostname}:${port}`,
    websocketUrl: normalizedWebsocket,
  };
}
