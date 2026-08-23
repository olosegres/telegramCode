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
import {
  validateSubdir,
  resolveBoundWorkDir,
  BindError,
  findAutobindSubdir,
  normaliseTopicName,
  paginateBindList,
} from '../validation';

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

test('resolveBoundWorkDir refuses a missing binding', () => {
  assert.deepEqual(resolveBoundWorkDir(workRoot, null), { kind: 'refuse' });
});

test('resolveBoundWorkDir validates a persisted binding before returning workDir', () => {
  assert.deepEqual(resolveBoundWorkDir(workRoot, { subdir: 'alpha' }), {
    kind: 'proceed',
    subdir: 'alpha',
    workDir: fs.realpathSync(path.join(workRoot, 'alpha')),
  });
});

test('resolveBoundWorkDir returns an absolute canonical path for a relative root', () => {
  const relativeWorkRoot = path.relative(process.cwd(), workRoot);
  const decision = resolveBoundWorkDir(relativeWorkRoot, { subdir: 'alpha' });

  assert.deepEqual(decision, {
    kind: 'proceed',
    subdir: 'alpha',
    workDir: fs.realpathSync(path.join(workRoot, 'alpha')),
  });
});

test('resolveBoundWorkDir resolves a symlinked root to its physical directory', (t) => {
  const symlinkedWorkRoot = `${workRoot}-link`;
  try {
    fs.symlinkSync(workRoot, symlinkedWorkRoot);
  } catch {
    return t.skip('host fs refused symlink creation');
  }
  try {
    const decision = resolveBoundWorkDir(symlinkedWorkRoot, { subdir: 'alpha' });
    assert.deepEqual(decision, {
      kind: 'proceed',
      subdir: 'alpha',
      workDir: fs.realpathSync(path.join(workRoot, 'alpha')),
    });
  } finally {
    fs.unlinkSync(symlinkedWorkRoot);
  }
});

test('resolveBoundWorkDir rejects a deleted persisted binding target', () => {
  const gone = path.join(workRoot, 'gone');
  fs.mkdirSync(gone);
  fs.rmSync(gone, { recursive: true, force: true });

  const decision = resolveBoundWorkDir(workRoot, { subdir: 'gone' });
  assert.equal(decision.kind, 'invalid');
  if (decision.kind !== 'invalid') return;
  assert.equal(decision.error.code, 'BIND_NOT_FOUND');
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

// ─── normaliseTopicName + findAutobindSubdir (fuzzy auto-bind) ───────────────

test('normaliseTopicName: lowercases, trims, collapses separators', () => {
  assert.strictEqual(normaliseTopicName('Overview'), 'overview');
  assert.strictEqual(normaliseTopicName('  Overview  '), 'overview');
  assert.strictEqual(normaliseTopicName('my-api'), 'my-api');
  assert.strictEqual(normaliseTopicName('my_api'), 'my-api');
  assert.strictEqual(normaliseTopicName('my api'), 'my-api');
  assert.strictEqual(normaliseTopicName('my.api'), 'my-api');
  assert.strictEqual(normaliseTopicName('my  api'), 'my-api');
  assert.strictEqual(normaliseTopicName('my-_-api'), 'my-api');
});

test('normaliseTopicName: NFC normalisation folds NFD input', () => {
  // `café` with combining acute accent (NFD) → `café` with single composed
  // glyph (NFC). On disk the folder will almost always be NFC, but topic
  // names sometimes arrive NFD from older clients / iOS keyboard variants.
  const nfd = 'cafe\u0301';
  const nfc = 'café';
  assert.notStrictEqual(nfd, nfc); // sanity: they're distinct strings
  assert.strictEqual(normaliseTopicName(nfd), normaliseTopicName(nfc));
});

test('normaliseTopicName: empty / whitespace-only returns empty', () => {
  assert.strictEqual(normaliseTopicName(''), '');
  assert.strictEqual(normaliseTopicName('   '), '');
});

test('findAutobindSubdir: exact match', () => {
  assert.strictEqual(
    findAutobindSubdir('overview', ['overview', 'projectAlpha']),
    'overview',
  );
});

test('findAutobindSubdir: case-insensitive match', () => {
  assert.strictEqual(
    findAutobindSubdir('Overview', ['overview', 'projectAlpha']),
    'overview',
  );
});

test('findAutobindSubdir: separator drift (space → dash)', () => {
  assert.strictEqual(
    findAutobindSubdir('my api', ['my-api', 'overview']),
    'my-api',
  );
});

test('findAutobindSubdir: separator drift (underscore → dash)', () => {
  assert.strictEqual(
    findAutobindSubdir('My_API', ['my-api', 'overview']),
    'my-api',
  );
});

test('findAutobindSubdir: returns null on no match', () => {
  assert.strictEqual(findAutobindSubdir('unrelated', ['alpha', 'beta']), null);
});

test('findAutobindSubdir: returns null on empty topic name', () => {
  assert.strictEqual(findAutobindSubdir('', ['alpha', 'beta']), null);
  assert.strictEqual(findAutobindSubdir('   ', ['alpha', 'beta']), null);
});

test('findAutobindSubdir: first match wins on duplicates', () => {
  // Two folders normalise to the same form — auto-bind picks the first as
  // surfaced by `listAvailableSubdirs` (which sorts via localeCompare).
  // The behaviour is deterministic; documenting it in a test so a refactor
  // doesn't silently flip the precedence.
  assert.strictEqual(
    findAutobindSubdir('My API', ['my-api', 'my_api']),
    'my-api',
  );
});

// ─── paginateBindList ────────────────────────────────────────────────────────

test('paginateBindList: empty list still yields one page', () => {
  // The /bind picker must always render *something* (even if it's an empty
  // body) so the caller doesn't have to special-case an empty list. The
  // page count never drops below 1.
  const result = paginateBindList([], 0, 20);
  assert.deepStrictEqual(result, {
    slice: [],
    currentPage: 0,
    totalPages: 1,
  });
});

test('paginateBindList: single page when list fits', () => {
  const subdirs = ['a', 'b', 'c'];
  const result = paginateBindList(subdirs, 0, 20);
  assert.deepStrictEqual(result.slice, ['a', 'b', 'c']);
  assert.strictEqual(result.totalPages, 1);
  assert.strictEqual(result.currentPage, 0);
});

test('paginateBindList: slices into 3 pages of 2', () => {
  const subdirs = ['a', 'b', 'c', 'd', 'e'];
  const p0 = paginateBindList(subdirs, 0, 2);
  const p1 = paginateBindList(subdirs, 1, 2);
  const p2 = paginateBindList(subdirs, 2, 2);
  assert.deepStrictEqual(p0.slice, ['a', 'b']);
  assert.deepStrictEqual(p1.slice, ['c', 'd']);
  assert.deepStrictEqual(p2.slice, ['e']);
  assert.strictEqual(p0.totalPages, 3);
  assert.strictEqual(p1.totalPages, 3);
  assert.strictEqual(p2.totalPages, 3);
});

test('paginateBindList: clamps negative page to 0', () => {
  const subdirs = ['a', 'b', 'c'];
  const result = paginateBindList(subdirs, -3, 2);
  assert.strictEqual(result.currentPage, 0);
  assert.deepStrictEqual(result.slice, ['a', 'b']);
});

test('paginateBindList: clamps over-range page to last page', () => {
  // Stale callback after subdirs shrank — should land on the last available
  // page instead of returning an empty slice.
  const subdirs = ['a', 'b', 'c', 'd', 'e'];
  const result = paginateBindList(subdirs, 99, 2);
  assert.strictEqual(result.totalPages, 3);
  assert.strictEqual(result.currentPage, 2);
  assert.deepStrictEqual(result.slice, ['e']);
});

test('paginateBindList: rejects non-positive pageSize', () => {
  assert.throws(() => paginateBindList(['a'], 0, 0), /pageSize/);
  assert.throws(() => paginateBindList(['a'], 0, -1), /pageSize/);
  // 2.5 is non-integer → reject. The bot only ever passes 20.
  assert.throws(() => paginateBindList(['a'], 0, 2.5), /pageSize/);
});

test('paginateBindList: floors fractional page indexes', () => {
  // Should never happen in practice (callback data is always an integer
  // string), but parseInt() bugs upstream shouldn't crash the picker.
  const result = paginateBindList(['a', 'b', 'c', 'd'], 1.7, 2);
  assert.strictEqual(result.currentPage, 1);
  assert.deepStrictEqual(result.slice, ['c', 'd']);
});
