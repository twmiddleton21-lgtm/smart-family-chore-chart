import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Browser tests for the shared-backend DEVELOPMENT build. Playwright starts
// its own throwaway server (dev mode, temporary data dir) and its own Vite in
// "api" mode, on ports that don't clash with normal development. It uses the
// locally installed Google Chrome (no browser download).
const API_PORT = 3199;
const WEB_PORT = 4176;
export const LOCAL_WEB_PORT = 4177;
// Normal mode (sign-in on): its own server, data dir and api-mode Vite.
const AUTH_API_PORT = 3198;
export const AUTH_WEB_PORT = 4178;
/** Fixed first-run setup code for the throwaway normal-mode server (test only). */
export const E2E_SETUP_CODE = 'E2ETESTSETUP2026';
const dataDir = path.join(os.tmpdir(), `sfcc-e2e-${process.pid}-${Date.now()}`);
const authDataDir = `${dataDir}-auth`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: 'chrome',
    headless: true,
    acceptDownloads: true,
  },
  webServer: [
    {
      command: 'npx tsx server/main.ts --dev-unauthenticated-api',
      url: `http://127.0.0.1:${API_PORT}/readyz`,
      env: { SFCC_DATA_DIR: dataDir, SFCC_PORT: String(API_PORT), SFCC_TIMEZONE: 'Europe/London' },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
    },
    {
      // Default (browser-local) build, to check the released behaviour still works.
      command: `npx vite --port ${LOCAL_WEB_PORT} --strictPort`,
      url: `http://localhost:${LOCAL_WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
    },
    {
      // Normal mode: authentication on, first parent created by the test.
      command: 'npx tsx server/main.ts',
      url: `http://127.0.0.1:${AUTH_API_PORT}/readyz`,
      env: { SFCC_DATA_DIR: authDataDir, SFCC_PORT: String(AUTH_API_PORT), SFCC_TIMEZONE: 'Europe/London', SFCC_SETUP_CODE: E2E_SETUP_CODE },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
    },
    {
      command: `npx vite --mode api --port ${AUTH_WEB_PORT} --strictPort`,
      url: `http://localhost:${AUTH_WEB_PORT}`,
      env: { SFCC_API_TARGET: `http://127.0.0.1:${AUTH_API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
    },
    {
      command: `npx vite --mode api --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { SFCC_API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
    },
  ],
});
