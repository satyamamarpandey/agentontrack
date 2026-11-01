import { defineConfig, devices } from '@playwright/test';

const live = !!process.env.SITE_URL;
export default defineConfig({
  testDir: 'tests',
  timeout: 90_000,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  ...(live ? {} : { webServer: { command: 'node tests/serve.mjs', port: 4173, reuseExistingServer: false } }),
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
    { name: 'firefox', use: devices['Desktop Firefox'] },
    { name: 'webkit', use: devices['Desktop Safari'] },
    { name: 'mobile', use: devices['Pixel 7'] },
  ],
});
