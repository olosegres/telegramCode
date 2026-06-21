/**
 * Side-effect-only setup for `openCodeEffortSeed.test.ts` (S7 OpenCode lock).
 *
 * `openCodeAdapter.ts` resolves `effortStateFile` from `DATA_DIR` ONCE at
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

export const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-effort-seed-'));
process.env.DATA_DIR = tempDataDir;

export const effortPrefsFile = path.join(tempDataDir, '.opencode-effort-prefs.json');

/** Thread with a stored effort pref → a NEW session must seed effortLevel from it. */
export const seededThreadKeyString = '-100666222:9';
export const seededEffortLevel = 'high';

/**
 * Thread with NO stored effort pref → a NEW session must seed effortLevel from
 * the bot's clamped default (`defaultEffortLevel` = 'xhigh', clamped to the
 * resolved model's variants). Deliberately absent from the prefs file below.
 */
export const noPrefThreadKeyString = '-100666222:11';

fs.writeFileSync(effortPrefsFile, JSON.stringify({ [seededThreadKeyString]: seededEffortLevel }));
