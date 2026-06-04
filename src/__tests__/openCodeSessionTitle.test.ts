import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildSessionTitleSnippet,
  checkIsMeaningfulPrompt,
  checkIsPlaceholderTitle,
  meaningfulPromptMinLength,
  sessionTitleSnippetMaxLength,
} from '../openCodeSessionTitle';
import {
  buildThreadContextPreamble,
  prependThreadContextPreamble,
} from '../threadContextPreamble';

const threadKey = { chatId: -1001111111111, threadId: 9085 };

// ── checkIsMeaningfulPrompt ──────────────────────────────────────────────────

test('checkIsMeaningfulPrompt: a slash command is never meaningful', () => {
  assert.equal(checkIsMeaningfulPrompt('/clear'), false);
  // Long slash commands are still control tokens, not name sources.
  assert.equal(checkIsMeaningfulPrompt('/model anthropic/claude-opus-4-8'), false);
});

test('checkIsMeaningfulPrompt: a 9-char prompt is below the threshold', () => {
  const nineChars = 'fix login';
  assert.equal(nineChars.length, 9);
  assert.equal(checkIsMeaningfulPrompt(nineChars), false);
});

test('checkIsMeaningfulPrompt: a 10-char prompt meets the threshold', () => {
  const tenChars = 'fix login!';
  assert.equal(tenChars.length, meaningfulPromptMinLength);
  assert.equal(checkIsMeaningfulPrompt(tenChars), true);
});

test('checkIsMeaningfulPrompt: trivial acknowledgements are not meaningful', () => {
  assert.equal(checkIsMeaningfulPrompt('да'), false);
  assert.equal(checkIsMeaningfulPrompt('go'), false);
  assert.equal(checkIsMeaningfulPrompt('...'), false);
});

test('checkIsMeaningfulPrompt: length is judged after trimming surrounding whitespace', () => {
  // Ten visible chars but padded — must still count as meaningful (trim) …
  assert.equal(checkIsMeaningfulPrompt('   fix login!   '), true);
  // … and padding around a short word must NOT inflate it past the threshold.
  assert.equal(checkIsMeaningfulPrompt('   ok   '), false);
});

// ── buildSessionTitleSnippet ─────────────────────────────────────────────────

test('buildSessionTitleSnippet: short text passes through unchanged', () => {
  assert.equal(buildSessionTitleSnippet('Fix the login flow'), 'Fix the login flow');
});

test('buildSessionTitleSnippet: collapses internal whitespace and newlines to single spaces', () => {
  assert.equal(
    buildSessionTitleSnippet('Fix   the\nlogin\t\tflow'),
    'Fix the login flow',
  );
});

test('buildSessionTitleSnippet: truncates to the cap with an ellipsis', () => {
  const longText = 'a'.repeat(120);
  const snippet = buildSessionTitleSnippet(longText);
  assert.ok(snippet.length <= sessionTitleSnippetMaxLength, 'never exceeds the cap');
  assert.ok(snippet.endsWith('…'), 'marks the truncation');
  // Exactly cap-1 content chars + the ellipsis.
  assert.equal(snippet, 'a'.repeat(sessionTitleSnippetMaxLength - 1) + '…');
});

test('buildSessionTitleSnippet: a prompt at exactly the cap is NOT truncated', () => {
  const exact = 'b'.repeat(sessionTitleSnippetMaxLength);
  const snippet = buildSessionTitleSnippet(exact);
  assert.equal(snippet, exact);
  assert.equal(snippet.endsWith('…'), false);
});

test('buildSessionTitleSnippet: strips the thread-context preamble — title is RAW user text', () => {
  const preamble = buildThreadContextPreamble({
    topicName: 'Login bug',
    groupTitle: 'ExampleGroup',
    key: threadKey,
    subdir: 'telegramCode',
  });
  const userText = 'Investigate the broken OAuth redirect on staging';
  const glued = prependThreadContextPreamble(preamble, userText);

  const snippet = buildSessionTitleSnippet(glued);
  // The whole point: no service header leaks into the title.
  assert.equal(snippet, userText);
  assert.ok(!snippet.includes('Telegram thread context'), 'no preamble header');
  assert.ok(!snippet.includes('folder:'), 'no preamble fields');
});

test('checkIsMeaningfulPrompt + strip: a glued preamble over a trivial reply is still trivial', () => {
  // This mirrors the adapter call site, which strips the preamble BEFORE
  // judging meaningfulness — otherwise the preamble length would make every
  // "да" look meaningful and name the session after the boilerplate.
  const preamble = buildThreadContextPreamble({ key: threadKey, subdir: 'telegramCode' });
  const glued = prependThreadContextPreamble(preamble, 'да');
  // Stripping first is the adapter's responsibility; the snippet helper proves
  // the raw text is recovered, so meaningfulness judged on it is correct.
  assert.equal(buildSessionTitleSnippet(glued), 'да');
});

// ── checkIsPlaceholderTitle ──────────────────────────────────────────────────

test('checkIsPlaceholderTitle: opencode untitled placeholder is overwritable', () => {
  assert.equal(checkIsPlaceholderTitle('New session - 2026-06-04T19:07:28.705Z'), true);
});

test('checkIsPlaceholderTitle: legacy bot title is overwritable', () => {
  assert.equal(checkIsPlaceholderTitle('Telegram session -1001111111111:9085'), true);
});

test('checkIsPlaceholderTitle: missing / empty title counts as placeholder', () => {
  assert.equal(checkIsPlaceholderTitle(undefined), true);
  assert.equal(checkIsPlaceholderTitle(''), true);
});

test('checkIsPlaceholderTitle: a real auto-generated name is left alone', () => {
  assert.equal(checkIsPlaceholderTitle('Debug broken Node login flow'), false);
  assert.equal(checkIsPlaceholderTitle('Checkout failing with empty cart'), false);
});
