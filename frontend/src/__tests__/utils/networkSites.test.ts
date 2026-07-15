import { describe, expect, it } from 'vitest';

import { networkSiteHostname, networkSiteMoonrakerUrls } from '../../utils/networkSites';

const site = { site_number: 1, ipv4_cidr: '192.168.1.0/24' };

describe('networkSiteHostname', () => {
  it('generates a 4via6 MagicDNS hostname for a usable site address', () => {
    expect(networkSiteHostname(site, '192.168.1.87')).toBe('192-168-1-87-via-1');
  });

  it.each(['192.168.2.87', '192.168.1.0', '192.168.1.255', 'not-an-ip'])(
    'rejects invalid site address %s',
    (address) => {
      expect(networkSiteHostname(site, address)).toBeNull();
    },
  );
});

describe('networkSiteMoonrakerUrls', () => {
  it('preserves secure protocols and rewrites both hosts and ports', () => {
    expect(networkSiteMoonrakerUrls(
      'https://klipper.local:7443',
      'wss://klipper.local:7443/websocket',
      '192-168-1-87-via-1',
      7125,
    )).toEqual({
      baseUrl: 'https://192-168-1-87-via-1:7125',
      websocketUrl: 'wss://192-168-1-87-via-1:7125/websocket',
    });
  });

  it('uses HTTP when a new site has no prior base URL', () => {
    expect(networkSiteMoonrakerUrls('', '', '192-168-1-87-via-1', 7125)).toEqual({
      baseUrl: 'http://192-168-1-87-via-1:7125',
      websocketUrl: undefined,
    });
  });
});
