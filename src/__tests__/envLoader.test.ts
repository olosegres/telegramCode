/**
 * @description Coverage for `src/cli/envLoader.ts`.
 *
 * Each test runs in an isolated tmpdir to avoid leaking env into other
 * tests, and overrides `HOME` so the "global" config path the loader looks
 * at is also under the tmp dir (not the developer's real `~`).
 *
 * Key invariants under test:
 *   - $PWD/.env overrides ~/.config/telegram-code/.env on a per-key basis
 *   - Pre-existing process.env values win against the global config (because
 *     globals are loaded with `override: false`) but lose to a local .env
 *   - Neither file present → no throw, `loaded: []`
 *   - The `loaded` array reflects actual load order (global first, local last)
 */

import { test, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadEnvFiles } from '../cli/envLoader';

let tmpRoot: string;
let projectDir: string;
let globalEnvDir: string;
let originalHome: string | undefined;
let originalCwd: string;
// Keys we'll mutate — captured once so afterEach can restore them precisely
// instead of nuking unrelated environment.
const TOUCHED = [
  'ENV_LOADER_TEST_GLOBAL_ONLY',
  'ENV_LOADER_TEST_LOCAL_ONLY',
  'ENV_LOADER_TEST_OVERRIDE',
  'ENV_LOADER_TEST_PREEXISTING',
];
let savedEnv: Record<string, string | undefined>;

function getExpectedLocalEnvPath(): string {
  // macOS may canonicalize /var to /private/var after chdir; match runtime cwd.
  return path.join(process.cwd(), '.env');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-env-'));
  projectDir = path.join(tmpRoot, 'project');
  globalEnvDir = path.join(tmpRoot, '.config', 'telegram-code');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(globalEnvDir, { recursive: true });

  originalHome = process.env.HOME;
  process.env.HOME = tmpRoot;
  originalCwd = process.cwd();
  process.chdir(projectDir);

  savedEnv = {};
  for (const k of TOUCHED) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const k of TOUCHED) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('loads nothing when neither file exists', () => {
  const { loaded } = loadEnvFiles();
  assert.deepEqual(loaded, []);
  assert.equal(process.env.ENV_LOADER_TEST_GLOBAL_ONLY, undefined);
});

test('loads global config when only global exists', () => {
  fs.writeFileSync(
    path.join(globalEnvDir, '.env'),
    'ENV_LOADER_TEST_GLOBAL_ONLY=from-global\n',
  );

  const { loaded } = loadEnvFiles();

  assert.equal(loaded.length, 1);
  assert.match(loaded[0], /\.config\/telegram-code\/\.env$/);
  assert.equal(process.env.ENV_LOADER_TEST_GLOBAL_ONLY, 'from-global');
});

test('loads local .env when only local exists', () => {
  fs.writeFileSync(
    path.join(projectDir, '.env'),
    'ENV_LOADER_TEST_LOCAL_ONLY=from-local\n',
  );

  const { loaded } = loadEnvFiles();

  assert.equal(loaded.length, 1);
  assert.equal(loaded[0], getExpectedLocalEnvPath());
  assert.equal(process.env.ENV_LOADER_TEST_LOCAL_ONLY, 'from-local');
});

test('local .env overrides global on per-key basis, leaves global-only keys intact', () => {
  fs.writeFileSync(
    path.join(globalEnvDir, '.env'),
    'ENV_LOADER_TEST_GLOBAL_ONLY=g-only\n' +
      'ENV_LOADER_TEST_OVERRIDE=from-global\n',
  );
  fs.writeFileSync(
    path.join(projectDir, '.env'),
    'ENV_LOADER_TEST_OVERRIDE=from-local\n' +
      'ENV_LOADER_TEST_LOCAL_ONLY=l-only\n',
  );

  const { loaded } = loadEnvFiles();

  assert.equal(loaded.length, 2);
  // Order matters for documentation / banner output: global first, local last.
  assert.match(loaded[0], /\.config\/telegram-code\/\.env$/);
  assert.equal(loaded[1], getExpectedLocalEnvPath());

  assert.equal(process.env.ENV_LOADER_TEST_GLOBAL_ONLY, 'g-only');
  assert.equal(process.env.ENV_LOADER_TEST_OVERRIDE, 'from-local');
  assert.equal(process.env.ENV_LOADER_TEST_LOCAL_ONLY, 'l-only');
});

test('shell-set env wins against global (override:false), local .env still wins against shell', () => {
  process.env.ENV_LOADER_TEST_PREEXISTING = 'from-shell';
  process.env.ENV_LOADER_TEST_OVERRIDE = 'from-shell';
  fs.writeFileSync(
    path.join(globalEnvDir, '.env'),
    'ENV_LOADER_TEST_PREEXISTING=from-global\n' +
      'ENV_LOADER_TEST_OVERRIDE=from-global\n',
  );
  fs.writeFileSync(
    path.join(projectDir, '.env'),
    'ENV_LOADER_TEST_OVERRIDE=from-local\n',
  );

  loadEnvFiles();

  // Shell-set value is preserved against the global file (override:false).
  assert.equal(process.env.ENV_LOADER_TEST_PREEXISTING, 'from-shell');
  // But the local file is loaded with override:true and stomps the shell.
  // This is intentional: the per-project .env is the most specific source,
  // so the user editing it should see their changes take effect immediately
  // without needing to `unset` their shell first.
  assert.equal(process.env.ENV_LOADER_TEST_OVERRIDE, 'from-local');
});
