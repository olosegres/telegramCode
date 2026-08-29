/**
 * @description Regression coverage for the IPv4-first startup fix shared by
 * the public CLI and internal hot worker entry.
 *
 * Test case: N/A - TelegramCode has no Jira tracker.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';
import { applyDnsFix } from '../cli/applyDnsFix';

test('applyDnsFix selects IPv4-first DNS resolution', () => {
  const originalOrder = dns.getDefaultResultOrder();
  try {
    applyDnsFix();
    assert.equal(dns.getDefaultResultOrder(), 'ipv4first');
  } finally {
    dns.setDefaultResultOrder(originalOrder);
  }
});

test('public and hot-worker entries both apply the DNS fix', () => {
  const publicCliSource = fs.readFileSync(path.join(__dirname, '..', 'cli.ts'), 'utf8');
  const hotWorkerSource = fs.readFileSync(
    path.join(__dirname, '..', 'cli', 'botEntry.ts'),
    'utf8',
  );

  assert.match(publicCliSource, /import \{ applyDnsFix \}[^;]+;[\s\S]+applyDnsFix\(\);/);
  assert.match(hotWorkerSource, /import \{ applyDnsFix \}[^;]+;[\s\S]+applyDnsFix\(\);/);
  assert.ok(hotWorkerSource.indexOf('applyDnsFix();') < hotWorkerSource.indexOf('runBot()'));
});
