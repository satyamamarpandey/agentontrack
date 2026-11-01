import { defineConfig, devices } from '@playwright/test';

// Browsers install to .pw-browsers so nothing lands in the user profile: PLAYWRIGHT_BROWSERS_PATH=.pw-browsers
const edgeAvailable = process.platform === 'win32';
// Run `pnpm build:pages` first. The site is static, so the tests serve exactly what would be published, under the same base path.
export const SITE_PORT = 4199;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.AGENTONTRACK_LIVE ? [] : [
    { command: 'node e2e/serve.mjs', port: SITE_PORT, reuseExistingServer: false, timeout: 30_000, env: { SITE_ROOT: 'dist-pages', SITE_PORT: String(SITE_PORT) } },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /live/ },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /live/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /live/ },
    ...(edgeAvailable ? [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' as const }, testIgnore: /live/ }] : []),
    // Pairing is about the browser's network rules, which the desktop Chromium project covers. The mobile project checks layout.
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testIgnore: /live|public-pairing/ },
    { name: 'live', testMatch: /live/, use: { ...devices['Desktop Chrome'] }, timeout: 420_000 },
  ],
});
