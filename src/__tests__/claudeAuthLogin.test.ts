/**
 * @description Unit tests for the json-stream `/login` out-of-band auth helpers
 * (plan 2026-07-11-jsonstream-login-outofband-auth, S2). Covers the pure
 * parse/decision layer:
 *  - `parseClaudeAuthLoginUrl` extracts the clean OAuth URL out of the real
 *    ANSI/OSC-8-wrapped `claude auth login` pty output (empirically captured
 *    from `claude` v2.1.207).
 *  - `checkIsClaudeAuthLoginCodePrompt` detects the "paste code" gate.
 *  - `parseAuthStatusLoggedIn` / `checkIsAuthLoginSucceeded` — success decision.
 *  - `getLoginCommandRoute` — ONLY the json-stream backend intercepts `/login`;
 *    the tmux/opencode/no-pick threads keep the verbatim forward (this is the
 *    routing test: `/login` on a json-stream thread routes out-of-band and NEVER
 *    reaches the agent forward; a tmux thread's `/login` is unchanged).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  parseClaudeAuthLoginUrl,
  checkIsClaudeAuthLoginCodePrompt,
  parseAuthStatusLoggedIn,
  checkIsAuthLoginSucceeded,
  getLoginCommandRoute,
} from '../utils/claudeAuthLogin';
import { claudeJsonStreamAdapterName } from '../adapters/claudeJsonStreamAdapter';

// Real terminal control bytes, built at runtime so no raw control char lands in
// this source file (keeps it grep-clean and unambiguous).
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// The exact OAuth URL claude prints (query params carry `+`, `%`, `&`, `=`, `:` —
// none of which may terminate the match).
const oauthUrl =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=laasrd7Hxp4A1s-W0bHjqu' +
  '&code_challenge_method=S256&state=fkJuwK41l6L2rrt8D5lBK5DuKu7XYJnvixWQn2yploU';

// The full pty frame: prose + OSC-8 hyperlink (`ESC]8;;<url>BEL`) + a second
// blue-coloured visible copy + the "paste code" input row — exactly the shape the
// live capture showed.
const loginPtyFrame =
  "Opening browser to sign in…\r\nIf the browser didn't open, visit: " +
  ESC + ']8;;' + oauthUrl + BEL +
  ESC + '[94m' + oauthUrl + ESC + '[39m' +
  ESC + ']8;;' + BEL +
  '\r\nPaste code here if prompted > ';

// The prose printed BEFORE the URL/prompt lands (a chunk boundary case).
const loginPtyFrameBeforeUrl = 'Opening browser to sign in…\r\n';

test('parseClaudeAuthLoginUrl: extracts the clean URL from the ANSI/OSC-8 frame', () => {
  assert.equal(parseClaudeAuthLoginUrl(loginPtyFrame), oauthUrl);
});

test('parseClaudeAuthLoginUrl: no URL yet → null', () => {
  assert.equal(parseClaudeAuthLoginUrl(loginPtyFrameBeforeUrl), null);
  assert.equal(parseClaudeAuthLoginUrl(''), null);
});

test('checkIsClaudeAuthLoginCodePrompt: false before the prompt, true once it lands', () => {
  assert.equal(checkIsClaudeAuthLoginCodePrompt(loginPtyFrameBeforeUrl), false);
  assert.equal(checkIsClaudeAuthLoginCodePrompt(loginPtyFrame), true);
});

test('parseAuthStatusLoggedIn: reads loggedIn, or null for malformed/absent', () => {
  assert.equal(parseAuthStatusLoggedIn('{"loggedIn": true, "email": "x@y.z"}'), true);
  assert.equal(parseAuthStatusLoggedIn('{"loggedIn": false}'), false);
  assert.equal(parseAuthStatusLoggedIn('{"authMethod": "claude.ai"}'), null); // field absent
  assert.equal(parseAuthStatusLoggedIn('not json'), null);
  assert.equal(parseAuthStatusLoggedIn(''), null);
});

test('checkIsAuthLoginSucceeded: status is authoritative, exit code is the fallback', () => {
  // loggedIn known → trust it regardless of the exit code.
  assert.equal(checkIsAuthLoginSucceeded({ exitCode: 1, loggedIn: true }), true);
  assert.equal(checkIsAuthLoginSucceeded({ exitCode: 0, loggedIn: false }), false);
  // status unreadable → fall back to the exit code.
  assert.equal(checkIsAuthLoginSucceeded({ exitCode: 0, loggedIn: null }), true);
  assert.equal(checkIsAuthLoginSucceeded({ exitCode: 1, loggedIn: null }), false);
  assert.equal(checkIsAuthLoginSucceeded({ exitCode: null, loggedIn: null }), false);
});

// ── /login routing: only json-stream intercepts, everything else forwards ──

test('getLoginCommandRoute: /login on a json-stream thread → outOfBand (never forwarded)', () => {
  assert.equal(
    getLoginCommandRoute({
      command: 'login',
      rawBackendName: claudeJsonStreamAdapterName,
      jsonStreamBackendName: claudeJsonStreamAdapterName,
    }),
    'outOfBand',
  );
});

test('getLoginCommandRoute: /login on a tmux-scrape Claude thread is unchanged (forwarded)', () => {
  assert.equal(
    getLoginCommandRoute({
      command: 'login',
      rawBackendName: 'claude',
      jsonStreamBackendName: claudeJsonStreamAdapterName,
    }),
    'forwardToAgent',
  );
});

test('getLoginCommandRoute: /login on opencode / no-pick threads is not intercepted', () => {
  for (const rawBackendName of ['opencode', 'terminal', undefined] as const) {
    assert.equal(
      getLoginCommandRoute({
        command: 'login',
        rawBackendName,
        jsonStreamBackendName: claudeJsonStreamAdapterName,
      }),
      'forwardToAgent',
      String(rawBackendName),
    );
  }
});

test('getLoginCommandRoute: a non-login command on a json-stream thread is untouched', () => {
  assert.equal(
    getLoginCommandRoute({
      command: 'compact',
      rawBackendName: claudeJsonStreamAdapterName,
      jsonStreamBackendName: claudeJsonStreamAdapterName,
    }),
    'forwardToAgent',
  );
});
