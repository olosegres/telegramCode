/**
 * @description Process-level coverage for the OpenCode host used by hot-mode
 * workers. The one-shot host must exit before startup returns, leaving the
 * server alive but no longer parented by the replaceable worker process.
 *
 * Test case: N/A - TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createServer } from 'net';
import { execFileSync, spawn } from 'child_process';
import {
  checkIsProcessIdentityCurrent,
  ensureOpenCodeServer,
  onOpenCodeServerExit,
  openCodeExternalHostEnvName,
  openCodeExternalHostEnvValue,
  openCodeOwnershipFileEnvName,
  restartOpenCodeServer,
  signalExternallyHostedProcess,
  startExternallyParentedProcess,
  stopOpenCodeServer,
} from '../installManager';

const persistentChildScript = 'setInterval(() => {}, 1000)';
const processExitPollMs = 25;
const processExitTimeoutMs = 2_000;
const testExternalHostTimeoutMs = 2_000;
const stallingExternalHostScript = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const command = process.argv[1];
const args = JSON.parse(process.argv[2]);
const child = spawn(command, args, {
  env: process.env,
  detached: true,
  stdio: 'ignore',
});
child.once('spawn', () => {
  fs.writeFileSync(process.env.FAKE_HOSTED_PID_FILE, child.pid.toString());
  process.send?.({ pid: child.pid });
  child.unref();
  setInterval(() => {}, 1000);
});
process.on('message', (message) => {
  if (message?.action !== 'abort') return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {}
  process.disconnect?.();
  process.exit(1);
});
`;
const delayedChildExternalHostScript = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const command = process.argv[1];
const args = JSON.parse(process.argv[2]);
let shouldAbort = false;
process.on('message', (message) => {
  if (message?.action === 'abort') shouldAbort = true;
});
setTimeout(() => {
  const child = spawn(command, args, {
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.once('spawn', () => {
    fs.writeFileSync(process.env.FAKE_HOSTED_PID_FILE, child.pid.toString());
    process.send?.({ pid: child.pid });
    if (shouldAbort) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      process.disconnect?.();
      process.exit(1);
    }
  });
}, 200);
`;
const fakeServerScript = `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const { spawn: spawnChild } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version')) {
  if (process.env.FAKE_OPENCODE_ENV_FILE) {
    fs.appendFileSync(process.env.FAKE_OPENCODE_ENV_FILE, 'version:' + [
      process.env.TELEGRAMCODE_HOT_RELOAD || '',
      process.env.TELEGRAMCODE_OPENCODE_PROCESS_FILE || '',
    ].join('|') + '\\n');
  }
  process.stdout.write('1.0.0\\n');
  process.exit(0);
}
const portIndex = args.indexOf('--port');
const port = Number.parseInt(args[portIndex + 1], 10);
const hostnameIndex = args.indexOf('--hostname');
const hostname = hostnameIndex >= 0 ? args[hostnameIndex + 1] : '127.0.0.1';
const checkIsTerminationTarget = () => {
  const targetFile = process.env.FAKE_OPENCODE_TERMINATION_TARGET_FILE;
  if (!targetFile || !fs.existsSync(targetFile)) return false;
  return fs.readFileSync(targetFile, 'utf8').trim() === process.pid.toString();
};
const checkIsNeverReady = () => process.env.FAKE_OPENCODE_NEVER_READY === '1';
const checkShouldExitBeforeReady = () => process.env.FAKE_OPENCODE_EXIT_BEFORE_READY === '1';
const checkShouldExitAfterHealth = () => process.env.FAKE_OPENCODE_EXIT_AFTER_HEALTH === '1';
fs.appendFileSync(process.env.FAKE_OPENCODE_SPAWN_LOG, process.pid + '\\n');
fs.writeFileSync(process.env.FAKE_OPENCODE_PID_FILE, process.pid.toString());
if (process.env.FAKE_OPENCODE_DESCENDANT_LOG) {
  const descendant = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  fs.appendFileSync(process.env.FAKE_OPENCODE_DESCENDANT_LOG, descendant.pid + '\\n');
}
if (process.env.FAKE_OPENCODE_ENV_FILE) {
  fs.appendFileSync(process.env.FAKE_OPENCODE_ENV_FILE, 'serve:' + [
    process.env.TELEGRAMCODE_HOT_RELOAD || '',
    process.env.TELEGRAMCODE_OPENCODE_PROCESS_FILE || '',
  ].join('|') + '\\n');
}
const server = http.createServer((request, response) => {
  if (request.url === '/global/health') {
    if (checkIsTerminationTarget() || checkIsNeverReady()) {
      response.writeHead(503);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ healthy: true, version: '1.0.0' }), () => {
      if (checkShouldExitAfterHealth()) process.exit(0);
    });
    return;
  }
  response.writeHead(404);
  response.end();
});
if (checkShouldExitBeforeReady()) setTimeout(() => process.exit(1), 25);
else if (checkIsNeverReady()) setInterval(() => {}, 1000);
else server.listen(port, hostname);
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', () => {
  if (checkIsTerminationTarget() || checkIsNeverReady()) {
    if (process.env.FAKE_OPENCODE_SIGTERM_FILE) {
      fs.writeFileSync(process.env.FAKE_OPENCODE_SIGTERM_FILE, Date.now().toString());
    }
    return;
  }
  stop();
});
process.on('SIGINT', stop);
process.on('SIGUSR1', () => {
  server.close(() => {
    if (process.env.FAKE_OPENCODE_RELINQUISHED_FILE) {
      fs.writeFileSync(process.env.FAKE_OPENCODE_RELINQUISHED_FILE, process.pid.toString());
    }
    setInterval(() => {}, 1000);
  });
});
`;

async function getUnusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Expected a TCP address for the test server');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

function getSpawnedPids(spawnLogPath: string): number[] {
  if (!fs.existsSync(spawnLogPath)) return [];
  return fs.readFileSync(spawnLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
}

function stopTestProcess(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The test process already exited.
    }
  }
}

function checkIsTestProcessAlive(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', pid.toString()], {
      encoding: 'utf8',
    }).trim();
    return Boolean(state) && !state.startsWith('Z');
  } catch {
    return false;
  }
}

async function waitForTestProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + processExitTimeoutMs;
  while (Date.now() < deadline && checkIsTestProcessAlive(pid)) {
    await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
  }
}

async function waitForTestServerHealth(url: string): Promise<void> {
  const deadline = Date.now() + processExitTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/global/health`);
      if (response.ok) return;
    } catch {
      // The test server has not started listening yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
  }
  throw new Error(`Test server did not become healthy at ${url}`);
}

async function waitForTestFile(filePath: string): Promise<void> {
  const deadline = Date.now() + processExitTimeoutMs;
  while (Date.now() < deadline && !fs.existsSync(filePath)) {
    await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
  }
  assert.equal(fs.existsSync(filePath), true, `Expected test file ${filePath}`);
}

async function runEnsureInFreshWorker(env: NodeJS.ProcessEnv): Promise<void> {
  const workerScript = `
import('./src/installManager.ts')
  .then((installManager) => {
    const ensure = installManager.ensureOpenCodeServer || installManager.default.ensureOpenCodeServer;
    return ensure();
  })
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write((error?.stack || error?.message || error?.toString() || 'unknown error') + '\\n');
    process.exit(1);
  });
`;
  const worker = spawn(
    process.execPath,
    ['--import', 'tsx', '--eval', workerScript],
    { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  worker.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  assert.equal(exitCode, 0, stderr);
}

function restoreTestEnvironment(savedEnv: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function getProcessAncestorPids(pid: number): number[] {
  const ancestorPids: number[] = [];
  const seenPids = new Set([pid]);
  let currentPid = pid;

  while (currentPid > 1) {
    const output = execFileSync('ps', ['-o', 'ppid=', '-p', currentPid.toString()], {
      encoding: 'utf8',
    }).trim();
    const parentPid = Number.parseInt(output, 10);
    if (!Number.isInteger(parentPid) || parentPid <= 0 || seenPids.has(parentPid)) break;
    ancestorPids.push(parentPid);
    seenPids.add(parentPid);
    currentPid = parentPid;
  }

  return ancestorPids;
}

test(
  'external process host returns only after the child leaves the worker process tree',
  { skip: process.platform === 'win32' },
  async () => {
    const hostedProcess = await startExternallyParentedProcess(
      process.execPath,
      ['-e', persistentChildScript],
      process.env,
    );

    try {
      process.kill(hostedProcess.pid, 0);
      const ancestorPids = getProcessAncestorPids(hostedProcess.pid);
      assert.equal(
        ancestorPids.includes(process.pid),
        false,
        'hosted process must leave the replaceable worker process tree before startup returns',
      );
    } finally {
      signalExternallyHostedProcess(hostedProcess, 'SIGTERM');
    }
  },
);

test(
  'external process signals require the original PID identity',
  { skip: process.platform === 'win32' },
  async () => {
    const hostedProcess = await startExternallyParentedProcess(
      process.execPath,
      ['-e', persistentChildScript],
      process.env,
    );
    const reusedPidIdentity = {
      ...hostedProcess,
      startToken: `${hostedProcess.startToken}-reused`,
    };

    try {
      assert.equal(checkIsProcessIdentityCurrent(hostedProcess), true);
      assert.equal(checkIsProcessIdentityCurrent(reusedPidIdentity), false);
      assert.equal(signalExternallyHostedProcess(reusedPidIdentity, 'SIGTERM'), false);
      process.kill(hostedProcess.pid, 0);
    } finally {
      signalExternallyHostedProcess(hostedProcess, 'SIGTERM');
    }
  },
);

test(
  'external process host timeout removes a child that was already started',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-host-timeout-'));
    const pidFilePath = path.join(testDirectory, 'hosted.pid');

    try {
      await assert.rejects(
        startExternallyParentedProcess(
          process.execPath,
          ['-e', persistentChildScript],
          { ...process.env, FAKE_HOSTED_PID_FILE: pidFilePath },
          { hostScript: stallingExternalHostScript, timeoutMs: testExternalHostTimeoutMs },
        ),
        /did not exit after starting its child/,
      );

      const hostedPid = Number.parseInt(fs.readFileSync(pidFilePath, 'utf8'), 10);
      await waitForTestProcessExit(hostedPid);
      assert.equal(checkIsTestProcessAlive(hostedPid), false);
    } finally {
      if (fs.existsSync(pidFilePath)) {
        stopTestProcess(Number.parseInt(fs.readFileSync(pidFilePath, 'utf8'), 10));
      }
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'external process host aborts its child when identity capture fails',
  { skip: process.platform === 'win32' },
  async () => {
    const reportedPids: number[] = [];

    await assert.rejects(
      startExternallyParentedProcess(
        process.execPath,
        ['-e', persistentChildScript],
        process.env,
        {
          resolveProcessIdentity: (pid) => {
            reportedPids.push(pid);
            return null;
          },
        },
      ),
      /could not identify child process/,
    );

    assert.equal(reportedPids.length, 1);
    await waitForTestProcessExit(reportedPids[0]);
    assert.equal(checkIsTestProcessAlive(reportedPids[0]), false);
  },
);

test(
  'external process host aborts before release when ownership preparation fails',
  { skip: process.platform === 'win32' },
  async () => {
    const preparedPids: number[] = [];

    await assert.rejects(
      startExternallyParentedProcess(
        process.execPath,
        ['-e', persistentChildScript],
        process.env,
        {
          prepareProcessIdentity: (processIdentity) => {
            preparedPids.push(processIdentity.pid);
            throw new Error('ownership write failed');
          },
        },
      ),
      /ownership write failed/,
    );

    assert.equal(preparedPids.length, 1);
    await waitForTestProcessExit(preparedPids[0]);
    assert.equal(checkIsTestProcessAlive(preparedPids[0]), false);
  },
);

test(
  'external process host abort request covers a child whose PID arrives after timeout',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-host-delayed-'));
    const pidFilePath = path.join(testDirectory, 'hosted.pid');

    try {
      await assert.rejects(
        startExternallyParentedProcess(
          process.execPath,
          ['-e', persistentChildScript],
          { ...process.env, FAKE_HOSTED_PID_FILE: pidFilePath },
          { hostScript: delayedChildExternalHostScript, timeoutMs: 50 },
        ),
        /did not exit after starting its child/,
      );

      const hostedPid = Number.parseInt(fs.readFileSync(pidFilePath, 'utf8'), 10);
      await waitForTestProcessExit(hostedPid);
      assert.equal(checkIsTestProcessAlive(hostedPid), false);
    } finally {
      if (fs.existsSync(pidFilePath)) {
        stopTestProcess(Number.parseInt(fs.readFileSync(pidFilePath, 'utf8'), 10));
      }
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a fresh worker recovers a persisted bot-started generation before it binds its socket',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-opencode-prebind-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const startingServerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FAKE_OPENCODE_NEVER_READY: '1',
      FAKE_OPENCODE_SPAWN_LOG: spawnLogPath,
      FAKE_OPENCODE_PID_FILE: pidFilePath,
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    const startingProcess = await startExternallyParentedProcess(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
      startingServerEnv,
      {
        prepareProcessIdentity: (processIdentity) => {
          fs.writeFileSync(
            ownershipFilePath,
            `${processIdentity.pid}\n${processIdentity.startToken}\n${serverUrl}\ngroup\nstarting\n`,
          );
        },
      },
    );
    const freshWorkerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCODE_BIN: fakeBinaryPath,
      OPENCODE_URL: serverUrl,
      FAKE_OPENCODE_SPAWN_LOG: spawnLogPath,
      FAKE_OPENCODE_PID_FILE: pidFilePath,
      [openCodeExternalHostEnvName]: openCodeExternalHostEnvValue,
      [openCodeOwnershipFileEnvName]: ownershipFilePath,
    };
    delete freshWorkerEnv.FAKE_OPENCODE_NEVER_READY;

    try {
      await runEnsureInFreshWorker(freshWorkerEnv);

      await waitForTestProcessExit(startingProcess.pid);
      assert.equal(checkIsTestProcessAlive(startingProcess.pid), false);
      const spawnedPids = getSpawnedPids(spawnLogPath);
      assert.equal(spawnedPids.length, 2);
      assert.notEqual(spawnedPids[1], startingProcess.pid);
      assert.equal(checkIsTestProcessAlive(spawnedPids[1]), true);
      assert.match(fs.readFileSync(ownershipFilePath, 'utf8'), /\nready\n$/);
    } finally {
      signalExternallyHostedProcess(startingProcess, 'SIGKILL');
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'hot ensure serializes concurrent callers and externally hosts every replacement generation',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-opencode-host-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const serverEnvFilePath = path.join(testDirectory, 'server-env');
    const descendantLogPath = path.join(testDirectory, 'descendants.log');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      FAKE_OPENCODE_ENV_FILE: process.env.FAKE_OPENCODE_ENV_FILE,
      FAKE_OPENCODE_DESCENDANT_LOG: process.env.FAKE_OPENCODE_DESCENDANT_LOG,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    process.env.FAKE_OPENCODE_ENV_FILE = serverEnvFilePath;
    process.env.FAKE_OPENCODE_DESCENDANT_LOG = descendantLogPath;
    process.env[openCodeExternalHostEnvName] = openCodeExternalHostEnvValue;
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    try {
      await Promise.all([
        ensureOpenCodeServer(),
        ensureOpenCodeServer(),
        ensureOpenCodeServer(),
      ]);

      const initialPids = getSpawnedPids(spawnLogPath);
      const initialDescendantPids = getSpawnedPids(descendantLogPath);
      assert.equal(initialPids.length, 1, 'concurrent ensure calls must start one server generation');
      assert.equal(initialDescendantPids.length, 1);
      assert.equal(
        getProcessAncestorPids(initialPids[0]).includes(process.pid),
        false,
        'the initial hot-worker generation must leave the worker tree',
      );

      await Promise.all([
        ensureOpenCodeServer(),
        restartOpenCodeServer(),
        ensureOpenCodeServer(),
      ]);

      const allPids = getSpawnedPids(spawnLogPath);
      assert.equal(allPids.length, 2, 'forced restart must create exactly one replacement generation');
      assert.notEqual(allPids[1], allPids[0]);
      const allDescendantPids = getSpawnedPids(descendantLogPath);
      assert.equal(allDescendantPids.length, 2);
      await waitForTestProcessExit(initialDescendantPids[0]);
      assert.equal(
        checkIsTestProcessAlive(initialDescendantPids[0]),
        false,
        'bot-created generations must signal their whole process group',
      );
      assert.equal(checkIsTestProcessAlive(allDescendantPids[1]), true);
      assert.deepEqual(
        fs.readFileSync(serverEnvFilePath, 'utf8').trim().split('\n').sort(),
        ['serve:|', 'serve:|', 'version:|'],
        'process-host controls must not leak into OpenCode probes, servers, or descendants',
      );
      assert.equal(
        getProcessAncestorPids(allPids[1]).includes(process.pid),
        false,
        'the replacement generation must also leave the worker tree',
      );
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      for (const pid of getSpawnedPids(descendantLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a fresh hot worker replaces a persisted unresponsive server before starting its generation',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-opencode-adopted-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const terminationTargetPath = path.join(testDirectory, 'termination-target.pid');
    const sigtermFilePath = path.join(testDirectory, 'sigterm-at');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      FAKE_OPENCODE_TERMINATION_TARGET_FILE: process.env.FAKE_OPENCODE_TERMINATION_TARGET_FILE,
      FAKE_OPENCODE_SIGTERM_FILE: process.env.FAKE_OPENCODE_SIGTERM_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = serverUrl;
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    process.env.FAKE_OPENCODE_TERMINATION_TARGET_FILE = terminationTargetPath;
    process.env.FAKE_OPENCODE_SIGTERM_FILE = sigtermFilePath;
    process.env[openCodeExternalHostEnvName] = openCodeExternalHostEnvValue;
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    const initialProcess = await startExternallyParentedProcess(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
      process.env,
    );
    try {
      await waitForTestServerHealth(serverUrl);
      await ensureOpenCodeServer();
      assert.equal(getSpawnedPids(spawnLogPath).length, 1);
      fs.writeFileSync(terminationTargetPath, initialProcess.pid.toString());

      const recovery = ensureOpenCodeServer();
      await waitForTestFile(sigtermFilePath);
      const sigtermAt = Number.parseInt(fs.readFileSync(sigtermFilePath, 'utf8'), 10);
      process.kill(initialProcess.pid, 0);
      await recovery;
      assert.ok(
        Date.now() - sigtermAt >= 3_000,
        'SIGKILL escalation must remain delayed after SIGTERM',
      );

      const spawnedPids = getSpawnedPids(spawnLogPath);
      assert.equal(spawnedPids.length, 2);
      assert.equal(spawnedPids[0], initialProcess.pid);
      assert.notEqual(spawnedPids[1], initialProcess.pid);
      await waitForTestProcessExit(initialProcess.pid);
      assert.equal(checkIsTestProcessAlive(initialProcess.pid), false);
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'ownership follows the configured endpoint and signals an adopted non-group listener by PID',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-opencode-endpoint-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const oldPort = await getUnusedPort();
    let newPort = await getUnusedPort();
    while (newPort === oldPort) newPort = await getUnusedPort();
    const oldServerUrl = `http://127.0.0.1:${oldPort}`;
    const newServerUrl = `http://127.0.0.1:${newPort}`;
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    process.env[openCodeExternalHostEnvName] = openCodeExternalHostEnvValue;
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    const oldServer = await startExternallyParentedProcess(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', oldPort.toString()],
      process.env,
    );
    const newServerChild = spawn(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', newPort.toString()],
      { env: process.env, stdio: 'ignore' },
    );

    try {
      await Promise.all([
        waitForTestServerHealth(oldServerUrl),
        waitForTestServerHealth(newServerUrl),
      ]);
      process.env.OPENCODE_URL = oldServerUrl;
      await ensureOpenCodeServer();
      process.env.OPENCODE_URL = newServerUrl;
      await ensureOpenCodeServer();

      await restartOpenCodeServer();

      process.kill(oldServer.pid, 0);
      assert.ok(newServerChild.pid);
      await waitForTestProcessExit(newServerChild.pid);
      assert.equal(checkIsTestProcessAlive(newServerChild.pid), false);
      assert.equal(getSpawnedPids(spawnLogPath).length, 3);
    } finally {
      stopOpenCodeServer();
      signalExternallyHostedProcess(oldServer, 'SIGTERM');
      if (newServerChild.pid) stopTestProcess(newServerChild.pid);
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'stale adopted ownership cannot signal a former listener or a same-port different-address listener',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-opencode-listener-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const relinquishedFilePath = path.join(testDirectory, 'relinquished');
    const port = await getUnusedPort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const decoyUrl = `http://127.0.0.2:${port}`;
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_RELINQUISHED_FILE: process.env.FAKE_OPENCODE_RELINQUISHED_FILE,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = serverUrl;
    process.env.FAKE_OPENCODE_RELINQUISHED_FILE = relinquishedFilePath;
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    delete process.env[openCodeExternalHostEnvName];
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    const formerListener = spawn(
      fakeBinaryPath,
      ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
      { env: process.env, stdio: 'ignore' },
    );
    let decoyListenerPid: number | undefined;
    let replacementListenerPid: number | undefined;

    try {
      await waitForTestServerHealth(serverUrl);
      await ensureOpenCodeServer();
      assert.ok(formerListener.pid);
      process.kill(formerListener.pid, 'SIGUSR1');
      await waitForTestFile(relinquishedFilePath);

      const decoyListener = spawn(
        fakeBinaryPath,
        ['serve', '--hostname', '127.0.0.2', '--port', port.toString()],
        { env: process.env, stdio: 'ignore' },
      );
      const replacementListener = spawn(
        fakeBinaryPath,
        ['serve', '--hostname', '127.0.0.1', '--port', port.toString()],
        { env: process.env, stdio: 'ignore' },
      );
      decoyListenerPid = decoyListener.pid;
      replacementListenerPid = replacementListener.pid;
      await Promise.all([
        waitForTestServerHealth(decoyUrl),
        waitForTestServerHealth(serverUrl),
      ]);

      await restartOpenCodeServer();

      process.kill(formerListener.pid, 0);
      assert.ok(decoyListenerPid);
      process.kill(decoyListenerPid, 0);
      assert.ok(replacementListenerPid);
      await waitForTestProcessExit(replacementListenerPid);
      assert.equal(checkIsTestProcessAlive(replacementListenerPid), false);
      assert.equal(getSpawnedPids(spawnLogPath).length, 4);
    } finally {
      stopOpenCodeServer();
      if (formerListener.pid) stopTestProcess(formerListener.pid);
      if (decoyListenerPid) stopTestProcess(decoyListenerPid);
      if (replacementListenerPid) stopTestProcess(replacementListenerPid);
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a newly spawned never-ready server is killed and its ownership file is removed',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-opencode-not-ready-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_NEVER_READY: process.env.FAKE_OPENCODE_NEVER_READY,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_NEVER_READY = '1';
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    process.env[openCodeExternalHostEnvName] = openCodeExternalHostEnvValue;
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    try {
      await assert.rejects(
        ensureOpenCodeServer(),
        /did not become ready within 15 seconds/,
      );

      const [serverPid] = getSpawnedPids(spawnLogPath);
      assert.ok(serverPid);
      await waitForTestProcessExit(serverPid);
      assert.equal(checkIsTestProcessAlive(serverPid), false);
      assert.equal(fs.existsSync(ownershipFilePath), false);
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a direct process exit before readiness does not report a post-start crash',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-opencode-start-exit-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_EXIT_BEFORE_READY: process.env.FAKE_OPENCODE_EXIT_BEFORE_READY,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };
    let unexpectedExitCalls = 0;

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_EXIT_BEFORE_READY = '1';
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    delete process.env[openCodeExternalHostEnvName];
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;
    onOpenCodeServerExit(() => {
      unexpectedExitCalls += 1;
    });

    try {
      await assert.rejects(ensureOpenCodeServer(), /failed to start/);
      assert.equal(unexpectedExitCalls, 0);
      assert.equal(fs.existsSync(ownershipFilePath), false);
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      onOpenCodeServerExit(() => {});
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'a direct process exit at the health boundary is rejected or reported after readiness',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-opencode-health-exit-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_EXIT_AFTER_HEALTH: process.env.FAKE_OPENCODE_EXIT_AFTER_HEALTH,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };
    let unexpectedExitCalls = 0;

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_EXIT_AFTER_HEALTH = '1';
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    delete process.env[openCodeExternalHostEnvName];
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;
    onOpenCodeServerExit(() => {
      unexpectedExitCalls += 1;
    });

    try {
      let didStartupResolve = false;
      try {
        await ensureOpenCodeServer();
        didStartupResolve = true;
      } catch (error) {
        assert.match(
          error instanceof Error ? error.message : error?.toString() ?? '',
          /failed during readiness|failed to start/,
        );
      }
      const [serverPid] = getSpawnedPids(spawnLogPath);
      await waitForTestProcessExit(serverPid);
      // OS process disappearance can precede Node's ChildProcess `exit` event
      // by one event-loop turn.
      await new Promise<void>((resolve) => setTimeout(resolve, processExitPollMs));
      assert.equal(
        unexpectedExitCalls,
        didStartupResolve ? 1 : 0,
        'a health-boundary exit must never be silently suppressed after startup resolves',
      );
      assert.equal(fs.existsSync(ownershipFilePath), false);
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      onOpenCodeServerExit(() => {});
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'non-hot ensure keeps direct process ownership and reports an unexpected exit',
  { skip: process.platform === 'win32' },
  async () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegramcode-opencode-owned-'));
    const fakeBinaryPath = path.join(testDirectory, 'fake-opencode');
    const spawnLogPath = path.join(testDirectory, 'spawn.log');
    const pidFilePath = path.join(testDirectory, 'server.pid');
    const ownershipFilePath = path.join(testDirectory, 'owned-process');
    const port = await getUnusedPort();
    const savedEnv = {
      OPENCODE_BIN: process.env.OPENCODE_BIN,
      OPENCODE_URL: process.env.OPENCODE_URL,
      FAKE_OPENCODE_SPAWN_LOG: process.env.FAKE_OPENCODE_SPAWN_LOG,
      FAKE_OPENCODE_PID_FILE: process.env.FAKE_OPENCODE_PID_FILE,
      [openCodeExternalHostEnvName]: process.env[openCodeExternalHostEnvName],
      [openCodeOwnershipFileEnvName]: process.env[openCodeOwnershipFileEnvName],
    };

    fs.writeFileSync(fakeBinaryPath, fakeServerScript, { mode: 0o755 });
    process.env.OPENCODE_BIN = fakeBinaryPath;
    process.env.OPENCODE_URL = `http://127.0.0.1:${port}`;
    process.env.FAKE_OPENCODE_SPAWN_LOG = spawnLogPath;
    process.env.FAKE_OPENCODE_PID_FILE = pidFilePath;
    delete process.env[openCodeExternalHostEnvName];
    process.env[openCodeOwnershipFileEnvName] = ownershipFilePath;

    try {
      const exitResult = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        onOpenCodeServerExit((code, signal) => resolve({ code, signal }));
      });
      await ensureOpenCodeServer();
      const [serverPid] = getSpawnedPids(spawnLogPath);
      assert.equal(getProcessAncestorPids(serverPid).includes(process.pid), true);

      process.kill(-serverPid, 'SIGKILL');
      const result = await exitResult;
      assert.equal(result.signal, 'SIGKILL');
    } finally {
      stopOpenCodeServer();
      for (const pid of getSpawnedPids(spawnLogPath)) stopTestProcess(pid);
      onOpenCodeServerExit(() => {});
      restoreTestEnvironment(savedEnv);
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  },
);
