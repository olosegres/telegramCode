/**
 * @description Pure helpers behind the OpenCode `/connect` OAuth flow: parse the
 * provider auth catalog, detect the device-flow URL/code + the paste-flow
 * prompt out of real `opencode auth login` pty output, and decide success from
 * the on-disk `auth.json`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProviderAuthMethods,
  checkIsOAuthMethod,
  checkIsSimpleApiMethod,
  buildOpenCodeAuthLoginArgs,
  parseOpenCodeOAuthUrl,
  parseOpenCodeDeviceCode,
  checkIsAwaitingAuthorization,
  checkIsOpenCodeOAuthPastePrompt,
  checkIsOAuthInfoReady,
  getOpenCodeAuthFilePath,
  checkProviderAuthed,
  checkIsOpenCodeOAuthSucceeded,
  buildConnectMethodButtonLabel,
  parseOAuthAuthorizeDetails,
  checkIsLoopbackOAuthFlow,
  checkIsPlausibleOAuthCode,
  parseOAuthCallbackFromReply,
  classifyOpenCodeOAuthReply,
  buildLoopbackCompletionUrl,
} from '../utils/openCodeAuthLogin';

/** The real `/provider/auth` catalog shape (trimmed to the shapes that matter). */
const catalog = {
  openai: [
    { type: 'oauth', label: 'ChatGPT Pro/Plus (browser)' },
    { type: 'oauth', label: 'ChatGPT Pro/Plus (headless)' },
    { type: 'api', label: 'Manually enter API Key' },
  ],
  'github-copilot': [
    {
      type: 'oauth',
      label: 'Login with GitHub Copilot',
      prompts: [{ type: 'select', key: 'deploymentType', message: 'Select GitHub deployment type' }],
    },
  ],
  gitlab: [
    { type: 'oauth', label: 'GitLab OAuth', prompts: [{ type: 'text', key: 'instanceUrl' }] },
    { type: 'api', label: 'GitLab Personal Access Token', prompts: [{ type: 'text', key: 'instanceUrl' }] },
  ],
};

/** A trimmed capture of a REAL `opencode auth login -p openai -m ...headless` pty stream. */
const deviceFlowRaw =
  '\u001b[0m\r\n' +
  '\u001b[90m│\u001b[39m\r\n' +
  '\u001b[34m●\u001b[39m  Go to: https://auth.openai.com/codex/device\r\n' +
  '\u001b[90m│\u001b[39m\r\n' +
  '\u001b[34m●\u001b[39m  Enter code: 95J2-4U74J\r\n' +
  '\u001b[?25l\u001b[90m│\u001b[39m\r\n' +
  '\u001b[35m◒\u001b[39m  Waiting for authorization\u001b[999D\u001b[J';

describe('parseProviderAuthMethods', () => {
  test('parses methods in catalog order with hasPrompts', () => {
    const methods = parseProviderAuthMethods(catalog, 'openai');
    assert.deepEqual(methods, [
      { type: 'oauth', label: 'ChatGPT Pro/Plus (browser)', hasPrompts: false },
      { type: 'oauth', label: 'ChatGPT Pro/Plus (headless)', hasPrompts: false },
      { type: 'api', label: 'Manually enter API Key', hasPrompts: false },
    ]);
  });

  test('flags methods carrying extra prompts', () => {
    const [copilot] = parseProviderAuthMethods(catalog, 'github-copilot');
    assert.equal(copilot.hasPrompts, true);
    const gitlab = parseProviderAuthMethods(catalog, 'gitlab');
    assert.deepEqual(gitlab.map((m) => [m.type, m.hasPrompts]), [
      ['oauth', true],
      ['api', true],
    ]);
  });

  test('unknown provider / malformed catalog → []', () => {
    assert.deepEqual(parseProviderAuthMethods(catalog, 'nope'), []);
    assert.deepEqual(parseProviderAuthMethods(null, 'openai'), []);
    assert.deepEqual(parseProviderAuthMethods({ openai: 'x' }, 'openai'), []);
  });

  test('method classifiers', () => {
    const [browser, headless, api] = parseProviderAuthMethods(catalog, 'openai');
    assert.equal(checkIsOAuthMethod(browser), true);
    assert.equal(checkIsOAuthMethod(headless), true);
    assert.equal(checkIsOAuthMethod(api), false);
    assert.equal(checkIsSimpleApiMethod(api), true);
    // gitlab's api method carries an instanceUrl prompt → not "simple"
    const gitlabApi = parseProviderAuthMethods(catalog, 'gitlab')[1];
    assert.equal(checkIsSimpleApiMethod(gitlabApi), false);
  });
});

test('buildOpenCodeAuthLoginArgs skips the interactive pickers', () => {
  assert.deepEqual(buildOpenCodeAuthLoginArgs('openai', 'ChatGPT Pro/Plus (headless)'), [
    'auth', 'login', '-p', 'openai', '-m', 'ChatGPT Pro/Plus (headless)',
  ]);
});

describe('device-flow detection (real pty capture)', () => {
  test('extracts the clean sign-in URL past the ANSI', () => {
    assert.equal(parseOpenCodeOAuthUrl(deviceFlowRaw), 'https://auth.openai.com/codex/device');
  });

  test('extracts the device code', () => {
    assert.equal(parseOpenCodeDeviceCode(deviceFlowRaw), '95J2-4U74J');
  });

  test('detects the waiting-for-authorization poll', () => {
    assert.equal(checkIsAwaitingAuthorization(deviceFlowRaw), true);
  });

  test('a device flow is NOT mistaken for a paste prompt', () => {
    assert.equal(checkIsOpenCodeOAuthPastePrompt(deviceFlowRaw), false);
  });

  test('info is ready once URL + code are present', () => {
    assert.equal(checkIsOAuthInfoReady(deviceFlowRaw), true);
    // A bare URL with nothing else yet is NOT ready (still rendering).
    assert.equal(checkIsOAuthInfoReady('Go to: https://auth.openai.com/codex/device'), false);
  });
});

describe('paste-flow detection', () => {
  const pasteRaw = 'Open https://example.com/oauth and then paste the code here:';
  test('detects the paste prompt + URL, no device code', () => {
    assert.equal(parseOpenCodeOAuthUrl(pasteRaw), 'https://example.com/oauth');
    assert.equal(parseOpenCodeDeviceCode(pasteRaw), null);
    assert.equal(checkIsOpenCodeOAuthPastePrompt(pasteRaw), true);
    assert.equal(checkIsOAuthInfoReady(pasteRaw), true);
  });
});

describe('auth.json success signal', () => {
  test('path honours XDG_DATA_HOME then ~/.local/share', () => {
    assert.equal(
      getOpenCodeAuthFilePath({ XDG_DATA_HOME: '/x/data', HOME: '/home/u' }),
      '/x/data/opencode/auth.json',
    );
    assert.equal(
      getOpenCodeAuthFilePath({ HOME: '/home/u' }),
      '/home/u/.local/share/opencode/auth.json',
    );
  });

  test('a stale api entry does NOT count as oauth success', () => {
    const stale = { openai: { type: 'api' }, anthropic: { type: 'oauth' } };
    assert.equal(checkProviderAuthed(stale, 'openai', 'oauth'), false);
    assert.equal(checkProviderAuthed(stale, 'openai'), true); // present (any type)
    assert.equal(checkProviderAuthed(stale, 'anthropic', 'oauth'), true);
  });

  test('unreadable map → null (caller falls back to exit code)', () => {
    assert.equal(checkProviderAuthed(null, 'openai', 'oauth'), null);
    assert.equal(checkProviderAuthed(undefined, 'openai', 'oauth'), null);
    assert.equal(checkProviderAuthed({}, 'openai', 'oauth'), false);
  });

  test('auth.json is authoritative; exit code is the fallback', () => {
    assert.equal(checkIsOpenCodeOAuthSucceeded({ exitCode: 1, authed: true }), true);
    assert.equal(checkIsOpenCodeOAuthSucceeded({ exitCode: 0, authed: false }), false);
    assert.equal(checkIsOpenCodeOAuthSucceeded({ exitCode: 0, authed: null }), true);
    assert.equal(checkIsOpenCodeOAuthSucceeded({ exitCode: 1, authed: null }), false);
  });
});

// A REAL `opencode auth login -p openai -m "ChatGPT Pro/Plus (browser)"` capture:
// the loopback (browser) flow — redirect_uri is localhost, NO device code, then
// it polls "Waiting for authorization" against its own local callback server.
// Shaped exactly like a real `-m "ChatGPT Pro/Plus (browser)"` capture, but all
// credential-bearing values (client_id / code_challenge / state) are SYNTHETIC —
// never commit a real OAuth code/state (public repo, privacy gate).
const loopbackFlowRaw =
  '\u001b[0m\r\n' +
  '\u001b[90m┌\u001b[39m  Add credential\r\n' +
  '\u001b[90m│\u001b[39m\r\n' +
  '\u001b[34m●\u001b[39m  Go to: https://auth.openai.com/oauth/authorize?response_type=code' +
  '&client_id=app_exampleClientId0000000000' +
  '&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback' +
  '&scope=openid+profile+email+offline_access' +
  '&code_challenge=exampleChallenge0000000000000000000000000&code_challenge_method=S256' +
  '&id_token_add_organizations=true&codex_cli_simplified_flow=true' +
  '&state=exampleAuthState000000000000000000000&originator=opencode\r\n' +
  '\u001b[90m│\u001b[39m\r\n' +
  '\u001b[34m●\u001b[39m  Complete authorization in your browser. This window will close automatically.\r\n' +
  '\u001b[35m◒\u001b[39m  Waiting for authorization\u001b[999D\u001b[J';

// Shaped like the callback URL a user pastes back (synthetic code/state).
const pastedCallbackUrl =
  'http://localhost:1455/auth/callback?code=ac_exampleCode00000000000000000' +
  '.exampleTail0000000000000000000000000' +
  '&scope=openid+profile+email+offline_access' +
  '&state=exampleCallbackState00000000000000';

describe('loopback (browser) OAuth flow', () => {
  test('parses redirect port/path/state out of the authorize URL', () => {
    const d = parseOAuthAuthorizeDetails(loopbackFlowRaw);
    assert.equal(d.isLoopback, true);
    assert.equal(d.redirectPort, 1455);
    assert.equal(d.redirectPath, '/auth/callback');
    assert.equal(d.state, 'exampleAuthState000000000000000000000');
  });

  test('is detected as loopback (no device code), device flow is not', () => {
    assert.equal(checkIsLoopbackOAuthFlow(loopbackFlowRaw), true);
    assert.equal(checkIsLoopbackOAuthFlow(deviceFlowRaw), false);
  });

  test('the loopback flow still counts as info-ready (URL + waiting poll)', () => {
    assert.equal(checkIsOAuthInfoReady(loopbackFlowRaw), true);
    // …but must NOT be mistaken for a device flow.
    assert.equal(parseOpenCodeDeviceCode(loopbackFlowRaw), null);
  });
});

describe('OAuth reply parsing (URL-first, then validated code)', () => {
  test('a pasted callback URL is parsed to code/state/port (URL wins)', () => {
    const parts = parseOAuthCallbackFromReply(pastedCallbackUrl);
    assert.ok(parts);
    assert.equal(parts!.port, 1455);
    assert.equal(parts!.path, '/auth/callback');
    assert.equal(parts!.state, 'exampleCallbackState00000000000000');
    assert.ok(parts!.code!.startsWith('ac_exampleCode00000000000000000'));
    const reply = classifyOpenCodeOAuthReply(`  ${pastedCallbackUrl}  `);
    assert.equal(reply?.kind, 'callback');
  });

  test('a bare plausible code classifies as code', () => {
    assert.equal(checkIsPlausibleOAuthCode('ac_exampleCode00000000000000000.exampleTail'), true);
    assert.equal(checkIsPlausibleOAuthCode('95J2-4U74J'), true);
    assert.equal(checkIsPlausibleOAuthCode('abc123#state-xyz_9'), true);
    const reply = classifyOpenCodeOAuthReply('ac_exampleCode00000000000000000.exampleTail');
    assert.equal(reply?.kind, 'code');
  });

  test('an ordinary chat message is NOT a code (the "я перезагрузил" bug)', () => {
    assert.equal(checkIsPlausibleOAuthCode('я перезагрузил'), false);
    assert.equal(checkIsPlausibleOAuthCode('I restarted the bot'), false);
    assert.equal(checkIsPlausibleOAuthCode('ok'), false); // too short
    assert.equal(classifyOpenCodeOAuthReply('я перезагрузил'), null);
    assert.equal(classifyOpenCodeOAuthReply('what is the status?'), null);
  });

  test('parseOAuthCallbackFromReply ignores a plain non-callback URL', () => {
    assert.equal(parseOAuthCallbackFromReply('see https://example.com/docs'), null);
  });

  test('builds the loopback completion URL against 127.0.0.1 only when complete', () => {
    assert.equal(
      buildLoopbackCompletionUrl({ port: 1455, path: '/auth/callback', code: 'ac_x', state: 'st' }),
      'http://127.0.0.1:1455/auth/callback?code=ac_x&state=st',
    );
    // Missing state (bare code with no stored state) → cannot complete.
    assert.equal(buildLoopbackCompletionUrl({ port: 1455, path: '/auth/callback', code: 'ac_x', state: null }), null);
    assert.equal(buildLoopbackCompletionUrl({ port: null, path: null, code: 'ac_x', state: 'st' }), null);
    // Path defaults + encodes params.
    assert.equal(
      buildLoopbackCompletionUrl({ port: 8080, path: null, code: 'a b', state: 's/t' }),
      'http://127.0.0.1:8080/auth/callback?code=a+b&state=s%2Ft',
    );
  });
});

test('buildConnectMethodButtonLabel marks oauth vs api and caps length', () => {
  const [browser, , api] = parseProviderAuthMethods(catalog, 'openai');
  assert.equal(buildConnectMethodButtonLabel(browser), '🔓 ChatGPT Pro/Plus (browser)');
  assert.equal(buildConnectMethodButtonLabel(api), '🔑 Manually enter API Key');
  const long = buildConnectMethodButtonLabel({ type: 'oauth', label: 'x'.repeat(60), hasPrompts: false });
  // '🔓 ' prefix (3 UTF-16 units) + label capped at 40 (39 chars + '…').
  assert.ok(long.length <= 3 + 40, `label too long: ${long.length}`);
  assert.ok(long.endsWith('…'));
});
