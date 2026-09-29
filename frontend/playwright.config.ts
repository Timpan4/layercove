import { defineConfig, devices } from '@playwright/test';

// Runs against an already-running LayerCove server (CI: the production image
// from docker-compose.test.yml on port 8001). Each run leaves an HTML report
// and, on failure, a trace in playwright-report/ for replay.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.LAYERCOVE_URL || 'http://localhost:8001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
