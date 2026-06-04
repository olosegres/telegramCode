/**
 * Side-effect-only setup for `openCodeResumeModel.test.ts`.
 *
 * `openCodeAdapter.ts` resolves `modelStateFile` from `DATA_DIR` ONCE at module
 * load (a top-level `const`). ESM import hoisting means a `process.env.DATA_DIR`
 * assignment written in the test body runs AFTER the adapter module has already
 * evaluated that constant — too late. Importing this module BEFORE the adapter
 * import guarantees the env is set first (import order is preserved among hoisted
 * imports), so the adapter reads the prefs file from our temp dir.
 *
 * Matches neither the `*.test.ts` nor `*.e2e.ts` runner globs, so it is never
 * executed as a test itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-resume-model-'));
process.env.DATA_DIR = tempDataDir;

/** Thread that picked a model via `/model` — its choice is persisted on disk. */
export const savedPrefLabel = 'anthropic/claude-sonnet-4-6';
export const savedPrefKeyString = '-100999444:111';

fs.writeFileSync(
  path.join(tempDataDir, '.opencode-model-prefs.json'),
  JSON.stringify({ [savedPrefKeyString]: savedPrefLabel }),
);
