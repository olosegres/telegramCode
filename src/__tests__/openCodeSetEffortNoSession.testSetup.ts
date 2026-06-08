/**
 * Side-effect-only setup for `openCodeSetEffortNoSession.test.ts`.
 *
 * `openCodeAdapter.ts` resolves `modelStateFile` / `effortStateFile` from
 * `DATA_DIR` ONCE at module load (top-level `const`s). Importing this module
 * BEFORE the adapter import guarantees `process.env.DATA_DIR` points at a temp
 * dir first, so the no-session `setEffort` path writes its prefs there instead
 * of polluting the real `DATA_DIR` (mirrors
 * `openCodeSetModelNoSession.testSetup.ts`).
 *
 * Matches neither the `*.test.ts` nor `*.e2e.ts` runner globs, so it is never
 * executed as a test itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-seteffort-nosession-'));
process.env.DATA_DIR = tempDataDir;

export const modelPrefsFile = path.join(tempDataDir, '.opencode-model-prefs.json');
export const effortPrefsFile = path.join(tempDataDir, '.opencode-effort-prefs.json');

/**
 * Thread that already chose a `/model` (opus, which declares low..max) but has
 * NO live session. Used to prove `setEffort` / `getAvailableEffortLevels`
 * resolve the PROSPECTIVE model from this saved pref pre-session. Seeded on
 * disk so `loadSavedModel` reads it.
 */
export const savedModelThreadKeyString = '-100555444:11';
export const seededModelLabel = 'anthropic/claude-opus-4-8';

fs.writeFileSync(modelPrefsFile, JSON.stringify({ [savedModelThreadKeyString]: seededModelLabel }));
