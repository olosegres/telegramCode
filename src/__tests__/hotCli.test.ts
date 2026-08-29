/**
 * @description Subprocess integration coverage for the compiled hot supervisor.
 *
 * A temporary copy of dist uses deterministic fake tsc/nodemon children, so the
 * test exercises the real runHot wiring without touching Telegram, OpenCode, or
 * the running development service.
 *
 * Test case: N/A - TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const subprocessTimeoutMs = 10_000;

test('hot supervisor waits for a clean compile, starts nodemon once, and propagates WORK_ROOT', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcode-hot-e2e-'));
  const projectRoot = path.join(temporaryRoot, 'telegram-code');
  const launchRoot = path.join(temporaryRoot, 'projects');
  const homeDirectory = path.join(temporaryRoot, 'home');
  const emptyBinDirectory = path.join(temporaryRoot, 'empty-bin');
  const localBinDirectory = path.join(projectRoot, 'node_modules', '.bin');
  const sourceDist = path.resolve(__dirname, '..', '..', 'dist');
  const copiedDist = path.join(projectRoot, 'dist');
  const copiedBotEntry = path.join(copiedDist, 'cli', 'botEntry.js');
  const fakeTscPath = path.join(localBinDirectory, 'tsc');
  const fakeNodemonPath = path.join(localBinDirectory, 'nodemon');

  try {
    fs.mkdirSync(localBinDirectory, { recursive: true });
    fs.mkdirSync(launchRoot, { recursive: true });
    fs.mkdirSync(homeDirectory, { recursive: true });
    fs.mkdirSync(emptyBinDirectory, { recursive: true });
    fs.cpSync(sourceDist, copiedDist, { recursive: true });
    fs.rmSync(copiedBotEntry, { force: true });

    fs.writeFileSync(
      fakeTscPath,
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "process.stdout.write('Found 1 error. Watching for file cha');",
        "setTimeout(() => process.stdout.write('nges.\\n'), 20);",
        "setTimeout(() => process.stdout.write('Found 0 errors. Watching for file cha'), 60);",
        "setTimeout(() => process.stdout.write('nges.\\n'), 80);",
        'setTimeout(() => {',
        "  fs.writeFileSync(path.join(process.cwd(), 'dist', 'cli', 'botEntry.js'), '');",
        "  process.stdout.write('Found 0 errors. Watching for file cha');",
        '}, 120);',
        "setTimeout(() => process.stdout.write('nges.\\n'), 140);",
        'setInterval(() => {}, 1000);',
        "process.on('SIGTERM', () => process.exit(0));",
      ].join('\n'),
    );
    fs.writeFileSync(
      fakeNodemonPath,
      [
        "process.stdout.write('FAKE_NODEMON_STARTED WORK_ROOT=' + process.env.WORK_ROOT + '\\n');",
        'process.exit(0);',
      ].join('\n'),
    );

    const result = spawnSync(process.execPath, [path.join(copiedDist, 'cli.js'), 'hot'], {
      cwd: launchRoot,
      env: {
        DATA_DIR: path.join(temporaryRoot, 'data'),
        HOME: homeDirectory,
        NODE_PATH: path.resolve(__dirname, '..', '..', 'node_modules'),
        PATH: emptyBinDirectory,
      },
      encoding: 'utf8',
      timeout: subprocessTimeoutMs,
    });
    const output = result.stdout + result.stderr;
    const failedCompileIndex = output.indexOf('Found 1 error. Watching for file changes.');
    const cleanCompileIndex = output.indexOf('Found 0 errors. Watching for file changes.');
    const recoveredCompileIndex = output.indexOf(
      'Found 0 errors. Watching for file changes.',
      cleanCompileIndex + 1,
    );
    const nodemonStartIndex = output.indexOf('FAKE_NODEMON_STARTED');

    assert.equal(result.signal, null);
    assert.equal(result.status, 1, 'a clean unexpected nodemon exit must fail the wrapper');
    assert.ok(failedCompileIndex >= 0);
    assert.ok(cleanCompileIndex > failedCompileIndex);
    assert.ok(recoveredCompileIndex > cleanCompileIndex);
    assert.ok(nodemonStartIndex > recoveredCompileIndex);
    assert.match(output, /compile has TypeScript errors; nodemon is waiting for a clean build/);
    assert.match(output, /clean compile produced no dist worker entry/);
    assert.match(output, new RegExp(`FAKE_NODEMON_STARTED WORK_ROOT=${launchRoot}`));
    assert.equal(output.match(/FAKE_NODEMON_STARTED/g)?.length, 1);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('nodemon config launches the dedicated internal worker entry', () => {
  const nodemonConfigSource = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'nodemon.json'),
    'utf8',
  );
  assert.match(nodemonConfigSource, /"exec"\s*:\s*"node dist\/cli\/botEntry\.js"/);
  assert.doesNotMatch(nodemonConfigSource, /dist\/cli\.js bot/);
});
