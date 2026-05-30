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
  // The indented description sub-lines must not leak into the rendered options.
  assert.doesNotMatch(q.text, /The color red\./);
});

test('AskUserQuestion box: signature stable as the cursor moves across the separator', () => {
  const onRed = extractClaudeQuestion(askUserQuestionBox(1))!;
  const onChat = extractClaudeQuestion(askUserQuestionBox(5))!;
  assert.equal(onRed.signature, onChat.signature);
  assert.match(onChat.text, /❯ 5\. Chat about this/);
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
