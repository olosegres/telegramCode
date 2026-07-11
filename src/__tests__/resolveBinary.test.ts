/**
 * @description Coverage for `src/utils/resolveBinary.ts`.
 *
 * `resolveClaudeBinary()` — always returns a string (preserves the
 * pre-extraction behaviour relied on by `claudeCliAdapter.ts`'s
 * module-load-time const).
 *
 * Tests manipulate `CLAUDE_BIN`, `HOME`, and `PATH` so the discovery walks
 * deterministically against tmpdir fixtures rather than the developer's
 * real environment.
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveClaudeBinary } from '../utils/resolveBinary';

let tmpRoot: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-resolve-'));
  saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    HOME: process.env.HOME,
    PATH: process.env.PATH,
  };
  // Wipe so each test starts from a known baseline.
  delete process.env.CLAUDE_BIN;
  // Empty PATH so `which claude` definitely fails — we then opt-in per test.
  process.env.PATH = '';
  process.env.HOME = tmpRoot;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Write an executable shim at `dir/claude` that prints args and exits 0.
 * The file content doesn't matter for path-resolution tests, but giving it
 * exec bits makes future spawn-based assertions possible.
 */
function plantClaudeIn(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'claude');
  fs.writeFileSync(p, '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
  return p;
}

test('resolveClaudeBinary returns CLAUDE_BIN as-is even if file missing', () => {
  process.env.CLAUDE_BIN = '/nonexistent/path/to/claude';
  assert.equal(resolveClaudeBinary(), '/nonexistent/path/to/claude');
});

test('resolveClaudeBinary falls back to $HOME/.npm-global/bin/claude when nothing else found', () => {
  // PATH is empty (beforeEach), CLAUDE_BIN unset.
  const got = resolveClaudeBinary();
  assert.equal(got, path.join(tmpRoot, '.npm-global', 'bin', 'claude'));
});

test('resolveClaudeBinary uses PATH via which when available', () => {
  const binDir = path.join(tmpRoot, 'bin');
  const plantedPath = plantClaudeIn(binDir);
  // Keep /usr/bin so `which` itself is reachable.
  process.env.PATH = `${binDir}:/usr/bin:/bin`;

  const got = resolveClaudeBinary();
  // `which` resolves the first claude on PATH; on systems where /usr/bin
  // also has a real claude we'd get that instead, so be lenient: any
  // existing executable named `claude` is acceptable, but our planted one
  // is preferred because it's earlier on PATH.
  assert.equal(got, plantedPath);
});
