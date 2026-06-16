/**
 * Side-effect-only setup for `startReadyMessage.test.ts`.
 *
 * `bot.ts` validates the boot environment at MODULE-IMPORT time (`parseEnv()`
 * runs as a top-level `const`, `process.exit(1)` on a missing `BOT_TOKEN`).
 * ESM import hoisting means a `process.env` assignment in the test body runs
 * AFTER `bot.ts` has already evaluated. Importing this module BEFORE the `bot`
 * import guarantees the env is set first (import order is preserved among
 * hoisted imports), so `parseEnv()` succeeds and the pure
 * `getStartReadyMessage` helper can be exercised in isolation.
 *
 * Matches neither the `*.test.ts` nor `*.e2e.ts` runner globs, so it is never
 * executed as a test itself.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tempWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ready-'));
process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
process.env.WORK_ROOT = tempWorkRoot;
