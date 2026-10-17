import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Test helpers (not used by the app). Each test gets its own temp data dir.

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sfcc-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

/** A fixed instant: Tuesday 13 Oct 2026, 12:00 UTC. */
export const FIXED_NOW = new Date('2026-10-13T12:00:00Z');
