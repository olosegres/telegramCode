import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AbortableFifo } from '../utils/abortableFifo';

/** Test case: N/A — TelegramCode has no Jira tracker. */

test('AbortableFifo resolves live waiters in arrival order and reports its size', async () => {
  const fifo = new AbortableFifo();
  const resolved: string[] = [];
  const first = fifo.wait().then(() => resolved.push('first'));
  const second = fifo.wait().then(() => resolved.push('second'));

  assert.equal(fifo.size, 2);
  assert.equal(fifo.resolveNext(), true);
  await first;
  assert.deepEqual(resolved, ['first']);
  assert.equal(fifo.size, 1);

  assert.equal(fifo.resolveNext(), true);
  await second;
  assert.deepEqual(resolved, ['first', 'second']);
  assert.equal(fifo.resolveNext(), false);
  assert.equal(fifo.size, 0);
});

test('AbortableFifo removes an aborted waiter without consuming the next live waiter', async () => {
  const fifo = new AbortableFifo();
  const controller = new AbortController();
  const canceled = fifo.wait(controller.signal);
  const survivor = fifo.wait();

  controller.abort();
  await assert.rejects(canceled, { name: 'AbortError' });
  assert.equal(fifo.size, 1);

  assert.equal(fifo.resolveNext(), true);
  await survivor;
  assert.equal(fifo.size, 0);
});

test('AbortableFifo resolveAll releases every live waiter and empties the queue', async () => {
  const fifo = new AbortableFifo();
  const waiters = [fifo.wait(), fifo.wait(), fifo.wait()];

  fifo.resolveAll();

  await Promise.all(waiters);
  assert.equal(fifo.size, 0);
});
