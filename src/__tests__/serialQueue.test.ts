import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmuxAsync } from '../adapters/claudeCliAdapter';
import { createSerialQueue } from '../utils/serialQueue';

const execFileAsync = promisify(execFile);

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkHasTmux(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

describe('createSerialQueue', () => {
  it('runs functions one-at-a-time in enqueue order', async () => {
    const queue = createSerialQueue();
    const starts: number[] = [];
    const completions: number[] = [];

    const first = queue.run(async () => {
      starts.push(1);
      await delay(30);
      completions.push(1);
      return 'first';
    });
    const second = queue.run(async () => {
      starts.push(2);
      await delay(1);
      completions.push(2);
      return 'second';
    });

    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.deepEqual(starts, [1, 2]);
    assert.deepEqual(completions, [1, 2]);
  });

  it('continues after a rejection and preserves later order', async () => {
    const queue = createSerialQueue();
    const order: string[] = [];

    const failing = queue.run(async () => {
      order.push('fail');
      throw new Error('boom');
    });
    const next = queue.run(async () => {
      order.push('next');
      return 42;
    });

    await assert.rejects(failing, /boom/);
    assert.equal(await next, 42);
    assert.deepEqual(order, ['fail', 'next']);
  });

  it('returns each function result', async () => {
    const queue = createSerialQueue();
    assert.equal(await queue.run(async () => 'value'), 'value');
  });
});

describe('tmuxAsync', () => {
  it('returns stdout on success when tmux is installed', async (t) => {
    if (!(await checkHasTmux())) {
      t.skip('tmux is not installed');
      return;
    }

    const out = await tmuxAsync('-V');
    assert.match(out, /^tmux\s+/);
  });

  it('returns empty string on a failing tmux command', async () => {
    assert.equal(await tmuxAsync('definitely-not-a-real-tmux-command'), '');
  });
});
