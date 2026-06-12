/**
 * @description Plan §2026-05-30 tg-html-output / S2. Claude's interactive
 * choice prompts must be (a) detected from the scraped pane, (b) rendered
 * durably with EVERY option preserved — including the `❯`-highlighted line
 * the old `stripTuiElements` path dropped — and (c) de-duplicated by a
 * signature that is stable while the user moves the cursor (so arrow-key
 * repaints don't re-spam the thread). Ordinary prose must NOT be detected.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  extractClaudeQuestion,
  checkIsClaudeQuestionBlock,
  checkIsSelectorControlReply,
  stripTuiElements,
} from '../adapters/claudeCliAdapter';

// A realistic permission box as it looks after `cleanOutput` (box borders
// present, ANSI already stripped). Cursor on option 1.
const boxCursorOn1 = [
  '╭───────────────────────────────────────────────╮',
  '│ Do you want to proceed?                         │',
  '│                                                 │',
  '│ ❯ 1. Yes                                        │',
  "│   2. Yes, and don't ask again                   │",
  '│   3. No, and tell Claude what to do differently │',
  '│                                                 │',
  '│ Enter to select · Esc to cancel                 │',
  '╰───────────────────────────────────────────────╯',
].join('\n');

// Same box after the user pressed /down once — cursor now on option 2.
const boxCursorOn2 = [
  '╭───────────────────────────────────────────────╮',
  '│ Do you want to proceed?                         │',
  '│                                                 │',
  '│   1. Yes                                        │',
  "│ ❯ 2. Yes, and don't ask again                   │",
  '│   3. No, and tell Claude what to do differently │',
  '│                                                 │',
  '│ Enter to select · Esc to cancel                 │',
  '╰───────────────────────────────────────────────╯',
].join('\n');

test('detects a bordered choice box', () => {
  assert.equal(checkIsClaudeQuestionBlock(boxCursorOn1), true);
});

test('extracts the header and ALL options, keeping the highlighted one', () => {
  const q = extractClaudeQuestion(boxCursorOn1)!;
  assert.ok(q);
  assert.match(q.text, /Do you want to proceed\?/);
  // The ❯-highlighted option (previously dropped) must be present.
  assert.match(q.text, /❯ 1\. Yes/);
  assert.match(q.text, /2\. Yes, and don't ask again/);
  assert.match(q.text, /3\. No, and tell Claude what to do differently/);
});

test('signature is identical across cursor moves (de-dup holds)', () => {
  const a = extractClaudeQuestion(boxCursorOn1)!;
  const b = extractClaudeQuestion(boxCursorOn2)!;
  assert.equal(a.signature, b.signature);
});

test('the highlight marker tracks the cursor in the rendered text', () => {
  const a = extractClaudeQuestion(boxCursorOn1)!;
  const b = extractClaudeQuestion(boxCursorOn2)!;
  assert.match(a.text, /❯ 1\. Yes/);
  assert.match(b.text, /❯ 2\. Yes, and don't ask again/);
  assert.notEqual(a.text, b.text);
});

test('a borderless numbered prompt with a hint is still detected', () => {
  const borderless = [
    'Which approach?',
    '',
    '❯ 1. Rewrite',
    '  2. Patch',
    '',
    'Enter to select',
  ].join('\n');
  const q = extractClaudeQuestion(borderless)!;
  assert.ok(q);
  assert.match(q.text, /Which approach\?/);
  assert.equal(q.signature, '1.Rewrite|2.Patch');
});

// The real AskUserQuestion box (as scraped live): each option is followed by
// an indented description sub-line, and Claude's meta-options ("Type
// something" / "Chat about this") are split off below a full-width `────`
// separator. The option run is therefore NOT contiguous — detection must span
// the descriptions and the separator and still capture every option.
const askUserQuestionBox = (cursorOption: number) =>
  [
    ' ☐ Color',
    '',
    'Which color do you prefer?',
    '',
    `${cursorOption === 1 ? '❯' : ' '} 1. Red`,
    '     The color red.',
    `${cursorOption === 2 ? '❯' : ' '} 2. Green`,
    '     The color green.',
    `${cursorOption === 3 ? '❯' : ' '} 3. Blue`,
    '     The color blue.',
    `${cursorOption === 4 ? '❯' : ' '} 4. Type something.`,
    '────────────────────────────────────────────────────',
    `${cursorOption === 5 ? '❯' : ' '} 5. Chat about this`,
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');

test('AskUserQuestion box: spans descriptions + separator, keeps ALL options', () => {
  const q = extractClaudeQuestion(askUserQuestionBox(1))!;
  assert.ok(q);
  assert.match(q.text, /Which color do you prefer\?/);
  // Every option survives, including #5 below the `────` separator.
  assert.match(q.text, /❯ 1\. Red/);
  assert.match(q.text, /2\. Green/);
  assert.match(q.text, /3\. Blue/);
  assert.match(q.text, /4\. Type something\./);
  assert.match(q.text, /5\. Chat about this/);
  assert.equal(q.signature, '1.Red|2.Green|3.Blue|4.Type something.|5.Chat about this');
});

// S1 (Claude half, deferred into S4): the indented description sub-lines are
// ATTACHED to their option in the rendering — indented under the label, the
// same shape OpenCode's `buildQuestionBodyLines` produces. They previously
// were discarded entirely.
test('AskUserQuestion box: description sub-lines attach indented under their option', () => {
  const q = extractClaudeQuestion(askUserQuestionBox(1))!;
  assert.ok(q);
  assert.match(q.text, /❯ 1\. Red\n   The color red\./);
  assert.match(q.text, /  2\. Green\n   The color green\./);
  assert.match(q.text, /  3\. Blue\n   The color blue\./);
  // The separator between option 4 and 5 is chrome, never a description.
  assert.doesNotMatch(q.text, /Type something\.\n   ─/);
});

test('AskUserQuestion box: descriptions stay OUT of the signature (de-dup unaffected)', () => {
  const withDescriptions = extractClaudeQuestion(askUserQuestionBox(1))!;
  // Same options, descriptions not yet painted — signature must be identical.
  const withoutDescriptions = extractClaudeQuestion(
    [
      'Which color do you prefer?',
      '',
      '❯ 1. Red',
      '  2. Green',
      '  3. Blue',
      '  4. Type something.',
      '  5. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n'),
  )!;
  assert.equal(withDescriptions.signature, withoutDescriptions.signature);
});

test('AskUserQuestion box: signature stable as the cursor moves across the separator', () => {
  const onRed = extractClaudeQuestion(askUserQuestionBox(1))!;
  const onChat = extractClaudeQuestion(askUserQuestionBox(5))!;
  assert.equal(onRed.signature, onChat.signature);
  assert.match(onChat.text, /❯ 5\. Chat about this/);
});

// ── Side-by-side AskUserQuestion (options WITH previews) — bug #9 ──
//
// The REAL frame captured live 2026-06-10 (Claude Code v2.1.170, raw
// `tmux capture-pane -e -p` through `cleanOutput`; source fixture:
// agent/tmp/askuserquestion-preview-raw[-ansi].txt). Options sit in a left
// column; each option's `preview` snippet renders in a box on the right.
// Two scrape-breaking artifacts ride this layout:
//  1. every option line carries right-column box fragments (`┌`/`│` + preview
//     text) that polluted labels and signature;
//  2. `cleanOutput`'s ANSI-bold→`*…*` conversion renders the ❯-highlighted
//     label as `❯ 1.*winston*` (NO space after the dot), so the option regex
//     missed it, no cursor was found, extraction returned null and the frame
//     leaked half-eaten through the plain-output chrome filter — the live
//     zero-options message (msg 23990).
const buildSideBySideFrame = (optionLines: string[]) =>
  [
    ' ☐ Logger',
    '',
    '*Which logging approach should we use?*',
    '',
    ...optionLines,
    '                                  │ const logger = winston.createLogger({                      │',
    "                                  │   level: 'info',                                           │",
    '                                  │   format: winston.format.json(),                           │',
    '                                  │   transports: [new winston.transports.Console()],          │',
    '                                  │ });                                                        │',
    '                                  └────────────────────────────────────────────────────────────┘',
    '',
    '                                  Notes: press n to add notes',
    '',
    '────────────────────────────────────────────────────────────────────────────',
    '  Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
  ].join('\n');

// Verbatim option rows from the captured frame (cursor on option 1, with the
// ANSI-bold artifact on the highlighted label).
const sideBySideCursorOn1 = buildSideBySideFrame([
  '❯ 1.*winston*                      ┌────────────────────────────────────────────────────────────┐',
  "  2. pino                         │ import winston from 'winston';                             │",
  '  3. console                      │                                                            │',
]);

// Cursor moved to option 2 (the bold artifact rides the highlighted row).
const sideBySideCursorOn2 = buildSideBySideFrame([
  '  1. winston                      ┌────────────────────────────────────────────────────────────┐',
  "❯ 2.*pino*                        │ import winston from 'winston';                             │",
  '  3. console                      │                                                            │',
]);

// Cursor moved DOWN onto the unnumbered "Chat about this" meta-row: no
// numbered option is highlighted, and the preview pane pushes the footer
// beyond the normal hint lookahead.
const sideBySideCursorOnChat = buildSideBySideFrame([
  '  1. winston                      ┌────────────────────────────────────────────────────────────┐',
  "  2. pino                         │ import winston from 'winston';                             │",
  '  3. console                      │                                                            │',
]).replace('  Chat about this', '❯ Chat about this');

test('side-by-side preview frame: exactly the 3 left-column options, clean labels', () => {
  const q = extractClaudeQuestion(sideBySideCursorOn1)!;
  assert.ok(q);
  assert.match(q.text, /Which logging approach should we use\?/);
  // Exact rendering: highlighted=1, clean labels, nothing else.
  assert.equal(q.signature, '1.winston|2.pino|3.console');
  assert.match(q.text, /❯ 1\. winston\n  2\. pino\n  3\. console/);
  // No box glyphs or preview-pane content in the relayed question (the
  // preview body is deliberately TUI-only).
  assert.doesNotMatch(q.text, /[┌┐└┘├┤┬┴┼│┃]/);
  assert.doesNotMatch(q.text, /import winston|createLogger|transports/);
  // Layout chrome must not leak into the question text.
  assert.doesNotMatch(q.text, /Notes: press n|Chat about this|Enter to select/);
  // The `☐ <tab>` header line is skipped cleanly (not relayed).
  assert.doesNotMatch(q.text, /☐/);
});

test('side-by-side preview frame: signature stable across cursor moves (de-dup holds)', () => {
  const on1 = extractClaudeQuestion(sideBySideCursorOn1)!;
  const on2 = extractClaudeQuestion(sideBySideCursorOn2)!;
  assert.equal(on1.signature, on2.signature);
  assert.match(on2.text, /❯ 2\. pino/);
});

test('side-by-side: cursor on the unnumbered "Chat about this" row still extracts', () => {
  // No numbered option is highlighted; only the strong `Enter to select`
  // footer (beyond the normal lookahead, behind the preview pane) proves the
  // frame is interactive. Extraction must hold so `isQuestionPending` stays
  // armed and a digit reply keeps driving the selector.
  const q = extractClaudeQuestion(sideBySideCursorOnChat)!;
  assert.ok(q);
  assert.equal(q.signature, '1.winston|2.pino|3.console');
  assert.doesNotMatch(q.text, /❯/);
});

test('side-by-side: plain (no ANSI-bold artifact) capture variant also extracts', () => {
  // The same frame as captured WITHOUT `-e` (agent/tmp/askuserquestion-
  // preview-raw.txt): highlighted label keeps its space, no `*…*` markers.
  const plain = buildSideBySideFrame([
    '❯ 1. winston                      ┌────────────────────────────────────────────────────────────┐',
    "  2. pino                         │ import winston from 'winston';                             │",
    '  3. console                      │                                                            │',
  ]).replace('*Which logging approach should we use?*', 'Which logging approach should we use?');
  const q = extractClaudeQuestion(plain)!;
  assert.ok(q);
  assert.equal(q.signature, '1.winston|2.pino|3.console');
  assert.match(q.text, /❯ 1\. winston/);
});

test('side-by-side: a description sub-line keeps only its left-column part', () => {
  // Derived shape (no live capture of side-by-side WITH descriptions yet):
  // a description row would carry a right-column preview fragment like the
  // option rows do — the fragment must be cut, the description kept.
  const withDescriptions = buildSideBySideFrame([
    '❯ 1.*winston*                     ┌────────────────────────────────────────────────────────────┐',
    "     Structured JSON logging      │ import winston from 'winston';                             │",
    '  2. pino                         │                                                            │',
  ]);
  const q = extractClaudeQuestion(withDescriptions)!;
  assert.ok(q);
  assert.equal(q.signature, '1.winston|2.pino');
  assert.match(q.text, /❯ 1\. winston\n   Structured JSON logging\n  2\. pino/);
  assert.doesNotMatch(q.text, /[│┌┐└┘]|import winston/);
});

test('a sharp-cornered table with "N." rows is NOT a question (no cursor, no footer)', () => {
  // Box fragments on numbered lines positively identify a side-by-side
  // layout, which unlocks the EXTENDED footer window — a table must still be
  // rejected because nothing below it says "Enter to select".
  const tablePane = [
    'Here is the rollout order:',
    '┌───────────────────────────────────────────────────────────┬──────────┐',
    '│ 1. Read the existing configuration and back it up         │ done     │',
    '│ 2. Edit the function to accept the new parameter          │ pending  │',
    '└───────────────────────────────────────────────────────────┴──────────┘',
  ].join('\n');
  assert.equal(extractClaudeQuestion(tablePane), null);
  assert.equal(checkIsClaudeQuestionBlock(tablePane), false);
});

// The output-path guard: if a selector frame ever falls through to the plain
// OUTPUT path again (e.g. mid-paint), the side-by-side chrome must not leak
// as naked text — that was the visible half of live msg 23990.
test('stripTuiElements drops the side-by-side question chrome lines', () => {
  const stripped = stripTuiElements(sideBySideCursorOn1);
  assert.doesNotMatch(stripped, /Notes: press n to add notes/);
  assert.doesNotMatch(stripped, /Chat about this/);
  assert.doesNotMatch(stripped, /Enter to select/);
  // No half-eaten option/preview fragments either.
  assert.doesNotMatch(stripped, /import winston|createLogger/);
});

test('prose MENTIONING the side-by-side chrome phrases survives stripTuiElements', () => {
  // The drops are anchored whole-line; these prose lines must not be eaten.
  const prose = [
    'The TUI shows "Notes: press n to add notes" under the preview box.',
    'Users can always chat about this in the topic instead.',
  ].join('\n');
  const stripped = stripTuiElements(prose);
  assert.match(stripped, /Notes: press n to add notes/);
  assert.match(stripped, /chat about this in the topic/);
});

test('takes the LAST option group when the pane has prose above it', () => {
  const pane = [
    "Here's what I found in the codebase.",
    'Some explanation spanning a line.',
    '',
    '╭─────────────────────────╮',
    '│ Apply the change?        │',
    '│ ❯ 1. Apply               │',
    '│   2. Skip                │',
    '│ Enter to select          │',
    '╰─────────────────────────╯',
  ].join('\n');
  const q = extractClaudeQuestion(pane)!;
  assert.ok(q);
  assert.match(q.text, /Apply the change\?/);
  assert.equal(q.signature, '1.Apply|2.Skip');
  // Prose above the box must not leak into the header.
  assert.doesNotMatch(q.text, /codebase/);
});

test('a numbered prose list just above a boxed prompt does not merge into the options', () => {
  // The box top border must stop the upward option-group walk, or the agent's
  // own numbered list above the box leaks in as fake options and breaks de-dup.
  const pane = [
    "I'll touch these files:",
    '1. alpha.ts',
    '2. beta.ts',
    '╭─────────────────────────╮',
    '│ Apply the change?        │',
    '│ ❯ 1. Apply               │',
    '│   2. Skip                │',
    '│ Enter to select          │',
    '╰─────────────────────────╯',
  ].join('\n');
  const q = extractClaudeQuestion(pane)!;
  assert.ok(q);
  assert.equal(q.signature, '1.Apply|2.Skip');
  assert.doesNotMatch(q.text, /alpha\.ts/);
  assert.doesNotMatch(q.text, /beta\.ts/);
});

test('ordinary prose with a numbered list is NOT detected (no cursor, no hint)', () => {
  const prose = [
    'I will do three things:',
    '1. Read the file',
    '2. Edit the function',
    '3. Run the tests',
    '',
    'Starting now.',
  ].join('\n');
  assert.equal(checkIsClaudeQuestionBlock(prose), false);
  assert.equal(extractClaudeQuestion(prose), null);
});

test('a single option line is not a choice block', () => {
  const oneOption = ['Pick one:', '❯ 1. Only choice', 'Enter to select'].join('\n');
  assert.equal(checkIsClaudeQuestionBlock(oneOption), false);
});

test('non-question text returns null', () => {
  assert.equal(extractClaudeQuestion('just a normal sentence.'), null);
  assert.equal(extractClaudeQuestion(''), null);
});

// The real /login method selector as scraped live (2026-06-05). Detection is
// what arms `isQuestionPending`, which in turn lets a bare digit reply drive
// the menu in place — pre-fix the "1" was forwarded as a prompt, whose
// interrupt Escape cancelled the menu ("⎿ Login interrupted").
test('the /login method menu is detected as a question (digit-reply armed)', () => {
  const loginMenu = [
    'Select login method:',
    '',
    '❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
    '  2. Anthropic Console account · API usage billing',
  ].join('\n');
  const q = extractClaudeQuestion(loginMenu)!;
  assert.ok(q);
  assert.match(q.text, /Select login method:/);
  assert.match(q.text, /❯ 1\. Claude account with subscription/);
  assert.match(q.text, /2\. Anthropic Console account/);
});

// ── Selector reply routing (break-out vs drive-in-place) ──
//
// While a selector is on screen, only a bare option number or a single y/n
// should DRIVE it; anything else is a free-form message that must break out
// (Escape + send as a fresh turn). This predicate is the routing seam.

test('bare option numbers drive the selector in place', () => {
  assert.equal(checkIsSelectorControlReply('1'), true);
  assert.equal(checkIsSelectorControlReply('2'), true);
  assert.equal(checkIsSelectorControlReply('10'), true);
  assert.equal(checkIsSelectorControlReply('  3 '), true); // trimmed
});

test('y/n quick replies drive the selector in place', () => {
  assert.equal(checkIsSelectorControlReply('y'), true);
  assert.equal(checkIsSelectorControlReply('n'), true);
  assert.equal(checkIsSelectorControlReply('Y'), true);
  assert.equal(checkIsSelectorControlReply('N'), true);
});

test('free-form text is NOT a control reply → breaks out of the selector', () => {
  // The exact kind of message that used to be swallowed by the selector.
  assert.equal(checkIsSelectorControlReply('по-русски спрашивай'), false);
  assert.equal(checkIsSelectorControlReply('go with option 2 please'), false);
  assert.equal(checkIsSelectorControlReply('2 looks wrong, do something else'), false);
  assert.equal(checkIsSelectorControlReply('yes do it'), false);
  assert.equal(checkIsSelectorControlReply('123'), false); // 3+ digits: not an option index
  assert.equal(checkIsSelectorControlReply(''), false);
});

// ── Permission prompt: relay the action context, not just the tail ──
//
// The CURRENT Claude TUI (v2.1.175) renders a permission prompt WITHOUT a box:
// a full-width `────` divider, then `Bash command` + the command + a one-line
// description, a blank line, then `Do you want to proceed?` + options. The
// header walk used to stop at that blank line, so Telegram got only
// `Do you want to proceed?` and the user couldn't tell WHAT was being approved
// (live thread 15812 "overview 2", 2026-06-12). The walk must span the blank
// and climb to the `────` divider.
const bashPermissionPrompt = [
  '────────────────────────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  '   rm -f agent/tmp/probeScope.mjs && rm -rf agent/tmp/probe-scope-userdata && \\',
  '   projects/overviewDesktop/e2e/results/* 2>/dev/null; echo "cleaned"; git status --short',
  '   Clean probe scripts, temp dirs, e2e results',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  "   2. Yes, and don't ask again for similar commands in /home/user/src/overview",
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend · ctrl+e to explain',
].join('\n');

test('permission prompt (divider layout): relays the command box, not just the question', () => {
  const q = extractClaudeQuestion(bashPermissionPrompt)!;
  assert.ok(q);
  // The action context that used to be lost.
  assert.match(q.text, /Bash command/);
  assert.match(q.text, /rm -f agent\/tmp\/probeScope\.mjs/);
  assert.match(q.text, /Clean probe scripts, temp dirs, e2e results/);
  // The question line + every option still present.
  assert.match(q.text, /Do you want to proceed\?/);
  assert.match(q.text, /❯ 1\. Yes/);
  assert.match(q.text, /3\. No/);
  // The full-width `────` divider bounds the box and is NOT relayed.
  assert.doesNotMatch(q.text, /────/);
  // Signature is options-only → de-dup unaffected by the richer header.
  assert.equal(
    q.signature,
    "1.Yes|2.Yes, and don't ask again for similar commands in /home/user/src/overview|3.No",
  );
});

test('permission prompt (Edit, bordered): box top bounds the header, inner diff kept', () => {
  const editPrompt = [
    'Some transcript prose above the box.',
    '',
    '╭──────────────────────────────────────────────╮',
    '│ Edit file src/foo.ts                          │',
    '│                                               │',
    '│   - const value = 1;                          │',
    '│   + const value = 2;                          │',
    '│                                               │',
    '│ Do you want to make this edit?                │',
    '│ ❯ 1. Yes                                      │',
    '│   2. No                                       │',
    '│                                               │',
    '│ Enter to select · Esc to cancel               │',
    '╰──────────────────────────────────────────────╯',
  ].join('\n');
  const q = extractClaudeQuestion(editPrompt)!;
  assert.ok(q);
  assert.match(q.text, /Edit file src\/foo\.ts/);
  assert.match(q.text, /\+ const value = 2;/);
  assert.match(q.text, /Do you want to make this edit\?/);
  // The `╭──╮` box top bounds the walk — transcript prose above it stays out.
  assert.doesNotMatch(q.text, /transcript prose/);
});

test('permission prompt: an oversized box is truncated (head + tail kept, middle dropped)', () => {
  const diffLines = Array.from({ length: 40 }, (_, i) => `   + line ${i + 1} of the diff`);
  const oversized = [
    '────────────────────────────────────────────────────────────────────────────',
    ' Edit file big.ts',
    '',
    ...diffLines,
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel',
  ].join('\n');
  const q = extractClaudeQuestion(oversized)!;
  assert.ok(q);
  // Identifying top kept.
  assert.match(q.text, /Edit file big\.ts/);
  assert.match(q.text, /\+ line 1 of the diff/);
  // Question line (bottom of the header) kept.
  assert.match(q.text, /Do you want to proceed\?/);
  // A middle line is dropped behind the truncation marker.
  assert.match(q.text, /truncated/);
  assert.doesNotMatch(q.text, /\+ line 25 of the diff/);
});

test('permission prompt: the AskUserQuestion `☐` tab still never leaks into the header', () => {
  // Spanning blanks must not drag the category tab in (the existing
  // side-by-side `☐` no-leak guard, re-asserted against the new walk).
  const q = extractClaudeQuestion(askUserQuestionBox(1))!;
  assert.ok(q);
  assert.match(q.text, /Which color do you prefer\?/);
  assert.doesNotMatch(q.text, /☐/); // the " ☐ Color" tab label stays out
});
