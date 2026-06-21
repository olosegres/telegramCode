/**
 * Side-effect-only setup for `claudeSetModel.test.ts`.
 *
 * `claudeCliAdapter.ts` resolves `effortPrefsFile` from `DATA_DIR` ONCE at
 * module load (top-level `const`). Importing this module BEFORE the adapter
 * import guarantees `process.env.DATA_DIR` points at a temp dir first, so
 * `getEffort` reads the seeded pref from there instead of the real `DATA_DIR`
 * (mirrors `claudeEffortReapply.testSetup.ts`).
 *
 * Matches neither the `*.test.ts` nor `*.e2e.ts` runner globs, so it is never
 * executed as a test itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-setmodel-'));
process.env.DATA_DIR = tempDataDir;

export const effortPrefsFile = path.join(tempDataDir, '.claude-effort-prefs.json');

/** Thread with an explicit /effort pref → a model switch must NOT re-apply the default. */
export const seededThreadKeyString = '-100555:3';
export const seededEffortLevel = 'high';

fs.writeFileSync(effortPrefsFile, JSON.stringify({ [seededThreadKeyString]: seededEffortLevel }));
