import { chromium, test as base } from '@playwright/test';

export { expect } from '@playwright/test';

// E2E_CDP_URL points the suite at an external CDP browser such as Obscura
// (`obscura serve --port 9222 --allow-private-network`). Unset: bundled Chromium.
export const test = base.extend<object, { browser: import('@playwright/test').Browser }>({
  browser: [
    async ({ launchOptions }, use) => {
      const endpoint = process.env.E2E_CDP_URL;
      const browser = endpoint ? await chromium.connectOverCDP(endpoint) : await chromium.launch(launchOptions);
      await use(browser);
      await browser.close();
    },
    { scope: 'worker' },
  ],
});
