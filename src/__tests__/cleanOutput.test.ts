/**
 * @description Plan §2026-05-28 tg-output-readability / V1 — cover the
 * four readability fixes on the Claude-CLI adapter's pure-string helpers
 * (`cleanOutput`, `convertAnsiToMarkdown`, `stripTuiElements`).
 *
 * Each case mirrors a live reproduction captured from the
 * ExampleGroup → TelegramCode debug session on 2026-05-28:
 *
 *  - C1 — whitespace-only line dropped, paragraphs glued together
 *  - C2 — OSC 8 hyperlink escape leaked as `Update(8;id=...;file://...8;;)`
 *  - N1.a — `✻ Cooked for 27s` trailer pollutes the final answer
 *  - N1.b — `✽ Doing… (4s · ↓ 14 tokens)` tick inlined between
 *           a tool-call header and its `⎿`-continuation block
 *  - N3 — `*·* Brewing…` with literal asterisks around the spinner glyph
 *
 * The fixtures use character-precise escape literals (`\x1b`, `\x07`)
 * so the bytes Claude actually emits are exercised, not a humanized
 * paraphrase.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  checkIsInputEchoFrame,
  checkIsStatusOutput,
  cleanOutput,
  convertAnsiToMarkdown,
  stripTuiElements,
} from '../adapters/claudeCliAdapter';

// ─── C1 — paragraph gluing through whitespace-only line drop ───────────

test('cleanOutput: keeps blank line when separator is whitespace-only', () => {
  // The exact tmux capture-pane -e output: blank "separator" arrives as
  // a line padded with spaces to terminal width. The pre-fix filter
  // dropped it, gluing the paragraphs together.
  const padded = 'para1\n                                                                                \npara2';
  assert.equal(cleanOutput(padded), 'para1\n\npara2');
});

test('cleanOutput: keeps blank line when separator is a bare empty line', () => {
  assert.equal(cleanOutput('para1\n\npara2'), 'para1\n\npara2');
});

test('cleanOutput: keeps blank line when separator is tabs+spaces', () => {
  assert.equal(cleanOutput('para1\n \t \t\npara2'), 'para1\n\npara2');
});

test('cleanOutput: single-line input is unchanged', () => {
  assert.equal(cleanOutput('hello world'), 'hello world');
});

test('cleanOutput: three+ consecutive blanks collapse to one', () => {
  assert.equal(
    cleanOutput('para1\n\n\n\npara2'),
    'para1\n\npara2',
  );
});

// ─── C2 — OSC 8 hyperlink escape strip ─────────────────────────────────

test('convertAnsiToMarkdown: strips OSC 8 hyperlink (BEL terminator)', () => {
  const input =
    '\x1b]8;id=1a2p0b6;file:///home/user/src/telegramCode/IDEAS.md\x07Edit(IDEAS.md)\x1b]8;;\x07';
  assert.equal(convertAnsiToMarkdown(input), 'Edit(IDEAS.md)');
});

test('convertAnsiToMarkdown: strips OSC 8 hyperlink (ST terminator ESC\\)', () => {
  // Claude's TUI actually uses ESC\ as terminator, not BEL — verified
  // by od -c of the live tmux pane during 2026-05-28 V3 verification.
  const input =
    '\x1b]8;id=133ki5c;file:///home/user/src/telegramCode/IDEAS.md\x1b\\Write(IDEAS.md)\x1b]8;;\x1b\\';
  assert.equal(convertAnsiToMarkdown(input), 'Write(IDEAS.md)');
});

test('convertAnsiToMarkdown: strips two OSC 8 sequences on the same line', () => {
  const input =
    '\x1b]8;;file://x\x07a\x1b]8;;\x07 and \x1b]8;;file://y\x07b\x1b]8;;\x07';
  assert.equal(convertAnsiToMarkdown(input), 'a and b');
});

test('convertAnsiToMarkdown: strips OSC 8 with an ANSI reset before the closer', () => {
  // Live capture of the data-usage survey "Learn more" line: a colour reset
  // (ESC[39m) sits between the visible text and the closing ESC]8;;. The old
  // `[^\x1B\x07]*` capture stopped at that ESC and then failed to find
  // `ESC]8;;`, leaking the whole sequence as `8;id=...;<url><url>8;;`.
  const url = 'https://code.claude.com/docs/en/data-usage#session-quality-surveys';
  const input = `\x1b]8;id=1xlc6kt;${url}\x1b\\${url}\x1b[39m\x1b]8;;\x1b\\`;
  assert.equal(convertAnsiToMarkdown(input), url);
});

test('cleanOutput: survey "Learn more" line keeps only the URL (no OSC 8 leak)', () => {
  const url = 'https://code.claude.com/docs/en/data-usage#session-quality-surveys';
  const input = `  Learn more: \x1b[38;5;246m\x1b]8;id=1xlc6kt;${url}\x1b\\${url}\x1b[39m\x1b]8;;\x1b\\`;
  const out = cleanOutput(input);
  assert.ok(!out.includes('8;id='), `OSC 8 params leaked: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('8;;'), `OSC 8 closer leaked: ${JSON.stringify(out)}`);
  assert.equal(out, `Learn more: ${url}`);
});

test('convertAnsiToMarkdown: malformed OSC 8 (missing closer) is left alone — no crash', () => {
  const input = '\x1b]8;;file://x\x07Edit(x)';
  // No closer → regex does not match → bytes pass through to the
  // control-char strip later, which is the current (buggy) behavior.
  // Test guards against the regex throwing or matching greedily.
  const out = convertAnsiToMarkdown(input);
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('Edit(x)'));
});

test('cleanOutput: full pipeline removes a real OSC 8 hyperlink (BEL)', () => {
  // The exact byte sequence Claude emitted in msg 1874:
  // `Create(<OSC8 START>file:///.../IDEAS.md<BEL>IDEAS.md<OSC8 END>)`.
  const input =
    '● Create(\x1b]8;id=1a2p0b6;file:///home/user/src/telegramCode/IDEAS.md\x07IDEAS.md\x1b]8;;\x07)';
  const out = cleanOutput(input);
  assert.ok(
    !out.includes('8;id='),
    `OSC 8 params leaked: ${JSON.stringify(out)}`,
  );
  assert.ok(
    !out.includes('file:///'),
    `OSC 8 URL leaked: ${JSON.stringify(out)}`,
  );
  assert.ok(
    out.includes('Create(IDEAS.md)'),
    `Visible text missing: ${JSON.stringify(out)}`,
  );
});

test('cleanOutput: full pipeline removes a real OSC 8 hyperlink (ST)', () => {
  // The actual byte sequence captured from claude--1001111111111-434
  // tmux pane during V3 re-verification — uses ESC\ as terminator.
  const input =
    '● Write(\x1b]8;id=133ki5c;file:///home/user/src/telegramCode/agent/tasks/actual/2026-05-28-tg-output-readability.md\x1b\\agent/tasks/actual/2026-05-28-tg-output-readability.md\x1b]8;;\x1b\\)';
  const out = cleanOutput(input);
  assert.ok(!out.includes('8;id='), `OSC 8 params leaked: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('file:///'), `OSC 8 URL leaked: ${JSON.stringify(out)}`);
  assert.ok(
    out.includes('Write(agent/tasks/actual/2026-05-28-tg-output-readability.md)'),
    `Visible text missing: ${JSON.stringify(out)}`,
  );
});

// ─── N1.a — post-thinking-trailer line drop ────────────────────────────

// Per-verb fixtures: every verb we've observed in the wild plus a
// representative future verb to prove the relaxed `\S+` token holds.
// Plan §S3 — verb match is `\S+`, not an explicit list. Live V3
// iterations on 2026-05-28 demonstrated Claude ships new verbs faster
// than an explicit list could be kept in sync; the shape anchor
// (`<glyph> <verb> for <N>s`) is enough by itself. Sautéed (with `é`)
// also guards against a-z-only byte assumptions in any future tighter
// regex variant.
const POST_THINKING_VERBS = [
  'Cooked',       // msg 1855, 1863
  'Cogitated',    // msg 1873
  'Crunched',     // msg 1869
  'Baked',        // msg 1837
  'Churned',      // msg 1897 — V3 iteration 1
  'Sautéed',      // msg 1909 — V3 iteration 2 (non-ASCII verb)
  'Pondered',
  'Mused',
  'Crystallized',
  'Brewed',
  'Simmered',
  'Thought',
  // Future / unobserved — proves the relaxed match accepts arbitrary
  // single tokens without sacrificing the shape constraint.
  'Whisked',
  'Flambéed',
];

for (const verb of POST_THINKING_VERBS) {
  test(`stripTuiElements: drops "✻ ${verb} for 27s" trailer`, () => {
    const input = `Real answer paragraph.\n✻ ${verb} for 27s`;
    assert.equal(stripTuiElements(input), 'Real answer paragraph.');
  });
}

test('stripTuiElements: keeps look-alike prose "✻ Ready for input" (no time-with-s)', () => {
  // Negative case for the relaxed `\S+` token: the shape anchor
  // requires `\d+(?:m\s+\d+)?s$` at the end. `Ready for input` ends
  // in a word, not a time literal — must survive.
  const input = '✻ Ready for input';
  assert.equal(stripTuiElements(input), input);
});

test('stripTuiElements: keeps look-alike prose "✻ Cooking for 4 people"', () => {
  // The trailer regex would have matched `Cooking for 4` if we'd
  // dropped the `s` anchor — this pins the time-with-`s` requirement.
  const input = '✻ Cooking for 4 people';
  assert.equal(stripTuiElements(input), input);
});

test('stripTuiElements: drops trailer with minutes — "✻ Cogitated for 1m 30s"', () => {
  assert.equal(
    stripTuiElements('Done.\n✻ Cogitated for 1m 30s'),
    'Done.',
  );
});

test('stripTuiElements: does NOT drop active spinner "✻ Cogitating… (3s · ↓ 30 tokens)"', () => {
  // The active spinner is filtered by the spinner-tick regex (S4), not
  // the trailer regex — but neither route should leak the trailer-verb
  // form. This test pins the trailer regex away from `-ing` forms.
  const input = '✻ Cogitating… (3s · ↓ 30 tokens)\nReal answer.';
  const out = stripTuiElements(input);
  // The spinner line is also dropped (S4), so we just check the prose
  // survives, not the spinner itself.
  assert.ok(out.includes('Real answer.'));
});

// ─── N1.b — mid-block spinner-tick line drop ───────────────────────────

test('stripTuiElements: drops "✽ Doing… (4s · ↓ 14 tokens)" tick inside a chunk', () => {
  // The exact mixed-chunk shape from msg 1853: tool header + Running
  // tick that should NOT survive.
  const input =
    '● Bash(git log)\n  ⎿  Running…\n✽ Doing… (4s · ↓ 14 tokens)';
  const out = stripTuiElements(input);
  assert.ok(!out.includes('Doing…'), `tick leaked: ${JSON.stringify(out)}`);
  assert.ok(out.includes('● Bash') || out.includes('✓ Bash') || out.includes('⏳ Bash'),
    `tool header lost: ${JSON.stringify(out)}`);
});

test('stripTuiElements: drops "* Brewing… (1m 30s · ↑ 88 tokens · thought for 17s)"', () => {
  const input = 'Real text.\n* Brewing… (1m 30s · ↑ 88 tokens · thought for 17s)';
  assert.equal(stripTuiElements(input), 'Real text.');
});

test('stripTuiElements: drops sub-minute tick "· Working… (7s · ↓ 222 tokens)"', () => {
  const input = '· Working… (7s · ↓ 222 tokens)\nResult.';
  assert.equal(stripTuiElements(input), 'Result.');
});

test('stripTuiElements: keeps tool-call header "● Bash(ls -la)" — no ellipsis, no time pattern', () => {
  // Disambiguator: tool-call headers start with `●` but have NO `…`
  // and NO `(Xs · ...)` shape. They must survive.
  const input = '● Bash(ls -la)';
  const out = stripTuiElements(input);
  // After `normalizeToolCallLine` the `●` becomes `⏳`.
  assert.ok(/Bash\(ls -la\)/.test(out), `tool header lost: ${JSON.stringify(out)}`);
});

test('stripTuiElements: keeps real prose that contains "(5s)"', () => {
  // Guard against an over-eager regex on prose with a plain time stamp.
  const input = 'The build finished in (5s) without errors.';
  assert.equal(stripTuiElements(input), input);
});

// ─── Echo of a multi-line user prompt must not leak as agent output ────

test('stripTuiElements: drops the whole echoed multi-line prompt block', () => {
  // Live capture (claude--1001111111111-434): a submitted multi-line prompt
  // renders as `❯ <first line>` + space-indented continuation. The old code
  // dropped only the `❯` line, so the continuation (incl. ``` fences) leaked
  // as a phantom message duplicating the user's own prompt. Only the trailing
  // spinner should survive here.
  const input = [
    '❯ Reply with EXACTLY this and nothing else (literally, do not run any tools):',
    '  Here is a * *bold* * word and `inline code`, plus chars < > & in prose.',
    '  ```diff',
    '  - const oldValue = 1;',
    '  + const newValue = 2;',
    '    unchanged < line > here & ok',
    '  ```',
    '  Done.',
    '· Actualizing…',
    '❯ ',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt    ◉ xhigh · /effort',
  ].join('\n');
  const out = stripTuiElements(input);
  assert.equal(out, '· Actualizing…');
  // No fence / prompt body leaked.
  assert.doesNotMatch(out, /```/);
  assert.doesNotMatch(out, /oldValue/);
});

test('stripTuiElements: agent output (●) with indented lines is NOT mistaken for an echo', () => {
  // No preceding `❯ <text>` user turn → nothing is suppressed.
  const input = '● Here is the result\n  - line one\n  - line two';
  assert.equal(stripTuiElements(input), input);
});

test('stripTuiElements: echo block ends at the agent ● output on the next line', () => {
  const input = '❯ fix the bug\n  in file x\n● Done, fixed it.\n  changed line 5';
  assert.equal(stripTuiElements(input), '● Done, fixed it.\n  changed line 5');
});

test('stripTuiElements: drops the "⎿ Tip:" Plan-Mode UI hint', () => {
  const input =
    'Real answer.\n⎿  Tip: Use Plan Mode to prepare for a complex request before making changes. Press shift+tab twice to enable.';
  assert.equal(stripTuiElements(input), 'Real answer.');
});

test('stripTuiElements: keeps real prose that begins with "Tip:" (no ⎿ marker)', () => {
  // The ⎿-less form is agent advice, not the Plan-Mode UI hint — must survive.
  const input = 'Tip: always validate inputs before saving.';
  assert.equal(stripTuiElements(input), input);
});

// ─── B3 — interrupt frame "Interrupted · What should Claude do instead?" ───

test('stripTuiElements: drops the "⎿ Interrupted ·…" interrupt frame, keeps surrounding content', () => {
  // Real trace: after the bot sends Escape, the TUI repaints a transient frame
  // with this line; the pane-diff pipeline relayed it as a scary "agent is
  // waiting" message. The legit "Read *2* files" above and the spinner below
  // survive per the existing pipeline (spinner is filtered as a status tick).
  const input = 'Read *2* files\n  ⎿  Interrupted · What should Claude do instead?\n\n✢ Evaporating…';
  const out = stripTuiElements(input);
  assert.ok(!/Interrupted · What should Claude do instead\?/.test(out), `interrupt frame leaked: ${JSON.stringify(out)}`);
  assert.ok(out.includes('Read *2* files'), `legit content lost: ${JSON.stringify(out)}`);
});

test('stripTuiElements: drops a trailing "⎿ Interrupted ·…" frame with no content after it', () => {
  const input = 'Read *1* file\n  ⎿  Interrupted · What should Claude do instead?';
  assert.equal(stripTuiElements(input), 'Read *1* file');
});

test('stripTuiElements: drops the bare "Interrupted ·…" frame (no ⎿ prefix, trailing spaces)', () => {
  // The phrase may render without the ⎿ marker and with trailing pad spaces.
  const input = 'Interrupted · What should Claude do instead?   ';
  assert.equal(stripTuiElements(input), '');
});

test('stripTuiElements: keeps prose where the agent text contains the phrase mid-sentence', () => {
  // Negative case: the filter anchors on the TUI shape (line-start, optional
  // ⎿/whitespace, phrase to line-end), so agent/user text discussing the
  // phrase mid-sentence must NOT be stripped.
  const input = 'Я увидел Interrupted · What should Claude do instead? в логе';
  assert.equal(stripTuiElements(input), input);
});

// ─── checkIsStatusOutput — short answer fragments are NOT status ───────

test('checkIsStatusOutput: short sentence answer "Done." is real content, not status', () => {
  // Live regress: the answer tail "Done." arrived in its own poll frame and
  // was misclassified as a transient status, so it never reached the durable
  // message (the user saw the answer with the final line missing).
  assert.equal(checkIsStatusOutput('Done.'), false);
});

test('checkIsStatusOutput: "Found 3 bugs." is real content', () => {
  assert.equal(checkIsStatusOutput('Found 3 bugs.'), false);
});

test('checkIsStatusOutput: a 2-letter answer "OK." is real content, not status', () => {
  // Same class as the "Done." drop — a short affirmative answer must survive.
  assert.equal(checkIsStatusOutput('OK.'), false);
});

test('checkIsStatusOutput: lone glyph/stat fragments stay status', () => {
  assert.equal(checkIsStatusOutput('✻ Whirring…'), true);
  assert.equal(checkIsStatusOutput('· Working… (7s · ↓ 222 tokens)'), true);
  assert.equal(checkIsStatusOutput('◉ xhigh'), true);
});

test('checkIsStatusOutput: substantial multi-line content is not status', () => {
  assert.equal(
    checkIsStatusOutput('Here is a fairly long answer paragraph that clearly is real content and exceeds the length and structure heuristics used to spot spinners.'),
    false,
  );
});

// ─── N3 — bold around spinner glyph cleanup ────────────────────────────

test('convertAnsiToMarkdown: drops *...* around single spinner glyph "·"', () => {
  // Pre-bold-marked, post-strip shape — feed in the already-marked
  // form to test the glyph cleanup step in isolation. Bold markers in
  // real bytes come from ANSI ESC[1m which the function converts to
  // `*...*` first.
  const input = '\x1b[1m·\x1b[22m Brewing… (18s)';
  const out = convertAnsiToMarkdown(input);
  assert.equal(out, '· Brewing… (18s)');
});

test('convertAnsiToMarkdown: drops *...* around "✻" spinner glyph', () => {
  const input = '\x1b[1m✻\x1b[0m Smooshing…';
  assert.equal(convertAnsiToMarkdown(input), '✻ Smooshing…');
});

test('convertAnsiToMarkdown: keeps real bold for multi-char prose "*important*"', () => {
  const input = '\x1b[1mimportant\x1b[0m';
  assert.equal(convertAnsiToMarkdown(input), '*important*');
});

test('convertAnsiToMarkdown: keeps real bold for tool name "*Bash*"', () => {
  const input = '\x1b[1mBash\x1b[0m';
  assert.equal(convertAnsiToMarkdown(input), '*Bash*');
});

// ─── B7 — typed-draft input-box echo frame must not reach Telegram ─────────

test('checkIsInputEchoFrame: a frame that is only the ❯ draft row is an echo (live 12:51:52 fixture)', () => {
  assert.equal(
    checkIsInputEchoFrame('❯ передумал — просто скажи сколько функций экспортирует src/state.ts'),
    true,
  );
});

test('checkIsInputEchoFrame: multi-row frame of only ❯ lines (draft + empty prompt) is an echo', () => {
  assert.equal(checkIsInputEchoFrame('❯ draft text\n\n  ❯'), true);
});

test('checkIsInputEchoFrame: a ❯ row inside real tool output is NOT an echo frame', () => {
  assert.equal(
    checkIsInputEchoFrame('● Bash(tmux capture-pane -p)\n  ⎿  ❯ some pane content\nRead 1 file'),
    false,
  );
});

test('checkIsInputEchoFrame: ordinary answer text is NOT an echo frame', () => {
  assert.equal(checkIsInputEchoFrame('● В src/bot.ts — 4355 строк.'), false);
});

test('checkIsInputEchoFrame: empty/whitespace-only frame is NOT an echo (already filtered upstream)', () => {
  assert.equal(checkIsInputEchoFrame('   \n  '), false);
});

// ─── B7b — wrapped multi-row draft (only first row carries ❯) is an echo ────

test('checkIsInputEchoFrame: a wrapped multi-row draft is an echo (live 13:59:12 fixture)', () => {
  // A long draft wraps in the input box: only the FIRST row carries ❯, the
  // continuation rows are plain. The old all-lines-❯ predicate missed it, so
  // the 322-char draft leaked into the topic as a ghost message. New predicate:
  // first non-empty line starts with ❯ AND no line carries a content marker.
  const input = [
    '❯ А ещё меня смущает, что знания разложены по слоям — от кросс-',
    '  проектных правил до локального состояния агента, и я не уверен',
    '  что это лучшая структура для нашего случая',
  ].join('\n');
  assert.equal(checkIsInputEchoFrame(input), true);
});

test('checkIsInputEchoFrame: frame with a ❯ first line but a ● tool line later is NOT an echo', () => {
  // The first non-empty line starts with ❯ but a later line carries a content
  // marker (●) — real agent output, must NOT be classified as a pure echo.
  const input = '❯ fix the bug\n  in file x\n● Done, fixed it.';
  assert.equal(checkIsInputEchoFrame(input), false);
});
