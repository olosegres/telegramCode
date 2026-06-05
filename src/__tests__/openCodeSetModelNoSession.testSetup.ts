/**
 * Side-effect-only setup for `openCodeSetModelNoSession.test.ts`.
 *
 * `openCodeAdapter.ts` resolves `modelStateFile` / `effortStateFile` from
 * `DATA_DIR` ONCE at module load (top-level `const`s). Importing this module
 * BEFORE the adapter import guarantees `process.env.DATA_DIR` points at a temp
 * dir first, so the no-session `setModel` path writes its prefs there instead
 * of polluting the real `DATA_DIR` (see `openCodeResumeModel.testSetup.ts`).
 *
 * Matches neither the `*.test.ts` nor `*.e2e.ts` runner globs, so it is never
 * executed as a test itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-setmodel-nosession-'));
process.env.DATA_DIR = tempDataDir;

export const modelPrefsFile = path.join(tempDataDir, '.opencode-model-prefs.json');
export const effortPrefsFile = path.join(tempDataDir, '.opencode-effort-prefs.json');

/**
 * Thread that already chose an effort (`high`) but has NO live session. Used
 * to prove `setModel` keeps / clears that effort based on the NEW model's
 * variants. Seeded on disk so `loadSavedEffort` reads it.
 */
export const effortThreadKeyString = '-100888777:42';
export const seededEffortLevel = 'high';

fs.writeFileSync(effortPrefsFile, JSON.stringify({ [effortThreadKeyString]: seededEffortLevel }));
