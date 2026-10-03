import { test, expect } from './test';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

type LocaleCopy = {
  language: string;
  fieldLabel: string;
  placeholder: string;
};

const blockedBackgroundWrite = 'POST /api/v1/printers/camera/stream-token';

const localeCopies: LocaleCopy[] = [
  { language: 'en', fieldLabel: 'Select Entity *', placeholder: 'Search entities...' },
  { language: 'de', fieldLabel: 'Entität auswählen *', placeholder: 'Entitäten suchen...' },
  { language: 'es', fieldLabel: 'Seleccionar entidad *', placeholder: 'Buscar entidades...' },
  { language: 'fr', fieldLabel: "Sélectionner l'entité *", placeholder: 'Chercher entités...' },
  { language: 'it', fieldLabel: 'Seleziona entità *', placeholder: 'Cerca entità...' },
  { language: 'ja', fieldLabel: 'エンティティを選択 *', placeholder: 'エンティティを検索...' },
  { language: 'ko', fieldLabel: '엔티티 선택 *', placeholder: '엔티티 검색...' },
  { language: 'pt-BR', fieldLabel: 'Selecionar entidade *', placeholder: 'Pesquisar entidades...' },
  { language: 'tr', fieldLabel: 'Varlık Seç *', placeholder: 'Varlıklarda ara...' },
  { language: 'zh-CN', fieldLabel: '选择实体 *', placeholder: '搜索实体...' },
  { language: 'zh-TW', fieldLabel: '選擇實體 *', placeholder: '搜尋實體...' },
];

async function openEntitySearch(page: Page, locale: LocaleCopy, width: number) {
  const writes: string[] = [];
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript((language) => {
    localStorage.setItem('bambutrack_language', language);
  }, locale.language);
  await page.routeWebSocket((url) => url.pathname.startsWith('/api/'), (socket) => socket.close());
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/\/$/, '');
    if (request.method() !== 'GET') {
      if (request.method() === 'POST' && path === '/api/v1/auth/ws-token') {
        return route.fulfill({ json: { token: 'fictional-token' } });
      }
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { detail: 'Read-only Home Assistant search fixture' } });
    }

    let body: unknown = [];
    if (path === '/api/v1/auth/status') body = { auth_enabled: false, requires_setup: false };
    if (path === '/api/v1/settings') {
      body = { check_updates: false, ha_enabled: true, ha_url: 'http://ha.fixture.invalid', ha_token: 'fictional-token' };
    }
    await route.fulfill({ json: body });
  });

  await page.goto('/settings?tab=plugs');
  await page.locator('#card-plugs').getByRole('button').first().click();
  await page.getByRole('button', { name: 'HA', exact: true }).click();

  const search = page.getByLabel(locale.fieldLabel, { exact: true });
  await expect(search).toBeVisible();
  return { search, writes: writes.filter((write) => write !== blockedBackgroundWrite) };
}

for (const width of [1440, 390]) {
  test(`Home Assistant entity search uses English copy at ${width}px`, async ({ page }) => {
    const { search, writes } = await openEntitySearch(page, localeCopies[0], width);
    await expect(search).toHaveAttribute('placeholder', localeCopies[0].placeholder);
    expect(writes).toEqual([]);
  });
}

for (const locale of localeCopies.slice(1)) {
  test(`Home Assistant entity search uses the ${locale.language} translation`, async ({ page }) => {
    const { search, writes } = await openEntitySearch(page, locale, 1440);
    await expect(search).toHaveAttribute('placeholder', locale.placeholder);
    expect(writes).toEqual([]);
  });
}

test('Home Assistant entity search falls back to English for an unsupported locale', async ({ page }) => {
  const { search, writes } = await openEntitySearch(page, {
    language: 'unsupported-locale',
    fieldLabel: localeCopies[0].fieldLabel,
    placeholder: localeCopies[0].placeholder,
  }, 1440);
  await expect(search).toHaveAttribute('placeholder', localeCopies[0].placeholder);
  expect(writes).toEqual([]);
});
