/**
 * @description Plan §11 Этап 7 / R3 — path-traversal corpus for
 * `validateSubdir`. Builds a real `WORK_ROOT` in `os.tmpdir()` with the
 * shape:
 *
 *   <root>/                — the WORK_ROOT itself
 *   ├── alpha/             — legitimate project folder
 *   ├── alpha_evil/        — sibling whose name starts with "alpha"
 *   ├── nested/inner/      — nested directory for inside-checks
 *   ├── symlink_inside     — symlink → alpha
 *   ├── file.txt           — not a directory
 *   └── (sibling created OUTSIDE root and a symlink pointing at it)
 *   <outside>/             — sibling of root, target of escape symlink
 *
 * `realpathSync` is the heart of the function, so every test exercises
 * paths that would fool a naive `startsWith` check (plan §13.7, T1).
 */

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateSubdir, BindError } from '../validation';

let workRoot: string = '';
let outsideDir: string = '';
let symlinkInsideAvailable = false;
let symlinkOutsideAvailable = false;

before(() => {
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-validation-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-outside-'));

  fs.mkdirSync(path.join(workRoot, 'alpha'));
  fs.mkdirSync(path.join(workRoot, 'alpha_evil'));
  fs.mkdirSync(path.join(workRoot, 'nested', 'inner'), { recursive: true });
  fs.writeFileSync(path.join(workRoot, 'file.txt'), 'not a dir');

  // Symlink staying inside the root → must be accepted.
  try {
    fs.symlinkSync('alpha', path.join(workRoot, 'symlink_inside'));
    symlinkInsideAvailable = true;
  } catch { /* sandboxed CI may forbid symlinks; the dependent test self-skips */ }

  // Symlink escaping the root → must be rejected.
  try {
    fs.symlinkSync(outsideDir, path.join(workRoot, 'symlink_outside'));
    symlinkOutsideAvailable = true;
  } catch { /* same */ }
});

after(() => {
  // Order matters: remove root first (it contains a symlink pointing at
  // outsideDir), then the outside directory itself.
  fs.rmSync(workRoot, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

test('accepts a plain immediate subdirectory', () => {
  const rel = validateSubdir(workRoot, 'alpha');
  assert.equal(rel, 'alpha');
});

test('accepts a nested subdirectory', () => {
  // `path.join` so the test is portable to Windows-style separators if we
  // ever run there — the function itself uses `path.resolve` internally.
  const rel = validateSubdir(workRoot, path.join('nested', 'inner'));
  assert.equal(rel, path.join('nested', 'inner'));
});

test('normalises NFD input to NFC before lookup', () => {
  // Skip if the host filesystem is case-insensitive in a way that
  // breaks the test — but the NFD/NFC comparison is purely string-side.
  const nfcName = 'caf\u00e9';     // "café" precomposed
  const nfdName = 'cafe\u0301';    // "café" with combining acute
  const dirPath = path.join(workRoot, nfcName);
  fs.mkdirSync(dirPath);
  try {
    const rel = validateSubdir(workRoot, nfdName);
    assert.equal(rel.normalize('NFC'), nfcName);
  } finally {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
});

test('rejects ../ traversal', () => {
  // The path `../<basename(workRoot)>_evil` does not exist as a sibling,
  // so realpathSync throws ENOENT first. The point of the test is that
  // the function never returns a path outside the root, regardless of
  // whether the rejection is BIND_NOT_FOUND or BIND_OUTSIDE_ROOT.
  assert.throws(() => validateSubdir(workRoot, '../etc'), BindError);
});

test('rejects absolute paths pointing outside the root', () => {
  assert.throws(() => validateSubdir(workRoot, outsideDir), (e: unknown) => {
    return e instanceof BindError && e.code === 'BIND_OUTSIDE_ROOT';
  });
});

test('rejects URL-encoded traversal (no decoding implicit)', () => {
  // %2e%2e remains a literal four-character subdir name; if no such dir
  // exists, the result is BIND_NOT_FOUND — never accidental traversal.
  assert.throws(() => validateSubdir(workRoot, '%2e%2e/etc'), BindError);
});

test('rejects names containing NUL byte', () => {
  assert.throws(() => validateSubdir(workRoot, 'alpha\x00../etc'), (e: unknown) => {
    return e instanceof BindError && e.code === 'BIND_INVALID_CHARS';
  });
});

test('rejects names containing control characters', () => {
  assert.throws(() => validateSubdir(workRoot, 'alpha\x07'), (e: unknown) => {
    return e instanceof BindError && e.code === 'BIND_INVALID_CHARS';
  });
});

test('rejects empty / whitespace-only input', () => {
  assert.throws(() => validateSubdir(workRoot, ''), (e: unknown) => {
    return e instanceof BindError && e.code === 'BIND_INVALID_CHARS';
  });
  assert.throws(() => validateSubdir(workRoot, '   '), (e: unknown) => {
    return e instanceof BindError && e.code === 'BIND_INVALID_CHARS';
  });
});

test('rejects binding to WORK_ROOT itself', () => {
  // Plan §13.7 / D35: `/bind .` is the unbound state we just spent the
  // stage stopping users from sliding into.
  assert.throws(() => validateSubdir(workRoot, '.'), (e: unknown) => {
    return e instanceof BindError && e.code === 'BIND_OUTSIDE_ROOT';
  });
});

test('rejects a path that resolves to a file, not a directory', () => {
  assert.throws(() => validateSubdir(workRoot, 'file.txt'), (e: unknown) => {
    return e instanceof BindError && e.code === 'BIND_NOT_DIRECTORY';
  });
});

test('rejects symlink pointing outside the root', (t) => {
  if (!symlinkOutsideAvailable) return t.skip('host fs refused symlink creation');
  assert.throws(() => validateSubdir(workRoot, 'symlink_outside'), (e: unknown) => {
    return e instanceof BindError && e.code === 'BIND_OUTSIDE_ROOT';
  });
});

test('accepts symlink staying inside the root', (t) => {
  if (!symlinkInsideAvailable) return t.skip('host fs refused symlink creation');
  // Returns the *resolved* relative form ("alpha"), not the symlink name
  // — because `state.json` should record what we actually `cd` into.
  const rel = validateSubdir(workRoot, 'symlink_inside');
  assert.equal(rel, 'alpha');
});

test('rejects sibling whose name starts with the same prefix (no naive startsWith)', () => {
  // The classic traversal trap: realCandidate=/work_root_evil, realRoot=/work_root
  // — `startsWith(realRoot)` is true, but `startsWith(realRoot + sep)` is not.
  // Here both `alpha` and `alpha_evil` are inside the root, so this is
  // actually accepted. Add an external _evil sibling to exercise the trap:
  const tmpEvilRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-prefix-'));
  const trapRoot = path.join(tmpEvilRoot, 'work_root');
  const trapEvil = path.join(tmpEvilRoot, 'work_root_evil');
  fs.mkdirSync(trapRoot);
  fs.mkdirSync(trapEvil);
  try {
    assert.throws(() => validateSubdir(trapRoot, '../work_root_evil'), (e: unknown) => {
      return e instanceof BindError && e.code === 'BIND_OUTSIDE_ROOT';
    });
  } finally {
    fs.rmSync(tmpEvilRoot, { recursive: true, force: true });
  }
});
