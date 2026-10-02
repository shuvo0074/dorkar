import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against a running stack (identity + gateway + `pnpm dev`).
 *   E2E_BASE_URL=http://localhost:5173 E2E_SMS_LOG=services/identity-service/var/dev-sms.log pnpm e2e
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
});
