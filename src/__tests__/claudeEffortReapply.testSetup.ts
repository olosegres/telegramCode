/**
 * Side-effect-only setup for `claudeEffortReapply.test.ts` (S7).
 *
 * `claudeCliAdapter.ts` resolves `effortPrefsFile` from `DATA_DIR` ONCE at
 * module load (top-level `const`). Importing this module BEFORE the adapter
 * import guarantees `process.env.DATA_DIR` points at a temp dir first, so the
 * seeded pref is read from there instead of polluting the real `DATA_DIR`
 * (mirrors `openCodeSetModelNoSession.testSetup.ts`).
 *
 * Matches neither the `*.test.ts` nor `*.e2e.ts` runner globs, so it is never
 * executed as a test itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-effort-reapply-'));
process.env.DATA_DIR = tempDataDir;

export const effortPrefsFile = path.join(tempDataDir, '.claude-effort-prefs.json');

/** Thread with a stored effort pref → a fresh spawn must re-type `/effort high`. */
export const seededThreadKeyString = '-100777111:5';
export const seededEffortLevel = 'high';

/** Thread with NO stored pref → a fresh spawn must type nothing. */
export const noPrefThreadKeyString = '-100777111:6';

fs.writeFileSync(effortPrefsFile, JSON.stringify({ [seededThreadKeyString]: seededEffortLevel }));
