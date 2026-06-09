/**
 * @description Plan §2026-06-09-markdown-tables / S1. Raw GFM markdown tables
 * (mostly OpenCode output) must reach Telegram readable: a narrow table becomes
 * a column-aligned box-drawing frame wrapped in a ``` fence (→ <pre>), a wide
 * one becomes per-row "field: value" blocks. Load-bearing safety: this pass
 * runs on EVERY agent output, so non-table text and fenced code must come back
 * byte-for-byte identical, and column width must be counted by CODE POINTS so
 * Cyrillic / emoji columns still align (the classic `.length` trap).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTables,
  parseTable,
  renderAligned,
  renderFieldValue,
  renderTable,
  renderMarkdownTables,
  tableMaxMonospaceWidth,
} from '../utils/markdownTableRender';
import { renderAgentHtml } from '../renderAgentHtml';

/** The plan's example ratchet table (narrow, mixed scripts) used as a fixture. */
const ratchetTable = [
  '| Scope | Что | Ratchet |',
  '|---|---|---|',
  '| S1 | date | 8 → 2 |',
  '| S2 | scroll | 1 → 0 |',
].join('\n');

/** Pull only the box-drawing content lines out of a fenced aligned render. */
function getBoxLines(rendered: string): string[] {
  return rendered
    .split('\n')
    .filter((line) => line.startsWith('│'));
}

describe('detectTables', () => {
  it('finds a GFM table with header + separator + body rows', () => {
    const ranges = detectTables(ratchetTable);
    assert.equal(ranges.length, 1);
    assert.deepEqual(ranges[0], { startLine: 0, endLineExclusive: 4 });
  });

  it('ignores a single pipe-containing prose line with no separator row', () => {
    const prose = 'use the | pipe operator | in your shell command';
    assert.deepEqual(detectTables(prose), []);
  });

  it('ignores a header+separator that has NO body rows', () => {
    const headerOnly = '| A | B |\n|---|---|';
    assert.deepEqual(detectTables(headerOnly), []);
  });

  it('SKIPS a GFM table that lives inside a ``` fence', () => {
    const fenced = ['```', ...ratchetTable.split('\n'), '```'].join('\n');
    assert.deepEqual(detectTables(fenced), []);
  });

  it('rejects a `---` thematic break under a pipe-bearing prose line (column-count mismatch)', () => {
    // `some | text` has 2 cells; the `---` break parses to 1 separator column.
    // GFM requires header and delimiter column counts to match, so this prose
    // must NOT be mistaken for a table even though `---` matches the separator
    // shape and pipe rows surround it.
    const prose = ['choose A | B option', '---', 'then C | D follows'].join('\n');
    assert.deepEqual(detectTables(prose), []);
  });
});

describe('parseTable', () => {
  it('splits cells, drops empty edge cells, skips the separator row', () => {
    const parsed = parseTable(ratchetTable);
    assert.deepEqual(parsed.headers, ['Scope', 'Что', 'Ratchet']);
    assert.deepEqual(parsed.rows, [
      ['S1', 'date', '8 → 2'],
      ['S2', 'scroll', '1 → 0'],
    ]);
  });

  it('pads a ragged row (fewer cells than headers) with empty strings', () => {
    const ragged = ['| A | B | C |', '|---|---|---|', '| only-a |'].join('\n');
    const parsed = parseTable(ragged);
    assert.deepEqual(parsed.rows, [['only-a', '', '']]);
  });

  it('tolerates missing outer pipes', () => {
    const noOuter = ['A | B', '---|---', '1 | 2'].join('\n');
    const parsed = parseTable(noOuter);
    assert.deepEqual(parsed.headers, ['A', 'B']);
    assert.deepEqual(parsed.rows, [['1', '2']]);
  });
});

describe('renderAligned — code-point width, columns line up', () => {
  it('aligns a Cyrillic + emoji + ASCII mix (the .length trap)', () => {
    // Cyrillic "Что" is 3 code points but 6 UTF-16 units; the emoji column
    // mixes 1-char and multi-char cells. If width used .length, the box pipes
    // would NOT line up.
    const mixed = [
      '| Key | Текст | Mark |',
      '|---|---|---|',
      '| a | Привет | ✅ |',
      '| bb | Да | ❌ |',
    ].join('\n');
    const aligned = renderAligned(parseTable(mixed));
    const boxLines = getBoxLines(aligned);

    // Every content row must have the SAME code-point length and the SAME
    // positions for the interior `│` separators — that is what "aligned" means.
    const codePointLengths = boxLines.map((line) => [...line].length);
    assert.ok(
      codePointLengths.every((length) => length === codePointLengths[0]),
      `box rows must share one code-point width, got ${codePointLengths.join(',')}`,
    );
    const pipePositions = boxLines.map((line) =>
      [...line].reduce<number[]>((positions, char, index) => {
        if (char === '│') positions.push(index);
        return positions;
      }, []),
    );
    assert.ok(
      pipePositions.every((positions) => positions.join(',') === pipePositions[0].join(',')),
      'the interior box pipes must align across header and body rows',
    );
  });

  it('renders the full frame for the ratchet fixture', () => {
    const aligned = renderAligned(parseTable(ratchetTable));
    assert.ok(aligned.startsWith('┌'));
    assert.ok(aligned.includes('├'));
    assert.ok(aligned.trimEnd().endsWith('┘'));
    // Body rows present.
    assert.ok(aligned.includes('S1'));
    assert.ok(aligned.includes('S2'));
    assert.ok(aligned.includes('8 → 2'));
  });
});

describe('renderFieldValue — wide tables', () => {
  it('emits a ▸ key line + field: value lines per row', () => {
    const wide = [
      '| Scope | Что | Ratchet |',
      '|---|---|---|',
      '| S1 | date-хелперы → solUtils | 8 → 2 |',
      '| S2 | ScrollView → KitEngine | 1 → 0 |',
    ].join('\n');
    const fieldValue = renderFieldValue(parseTable(wide));
    const expected = [
      '▸ S1',
      '  Что: date-хелперы → solUtils',
      '  Ratchet: 8 → 2',
      '▸ S2',
      '  Что: ScrollView → KitEngine',
      '  Ratchet: 1 → 0',
    ].join('\n');
    assert.equal(fieldValue, expected);
  });

  it('numbers rows when there is no key column (single column)', () => {
    const oneColumn = ['| OnlyHeader |', '|---|', '| alpha |', '| beta |'].join('\n');
    const fieldValue = renderFieldValue(parseTable(oneColumn));
    assert.equal(fieldValue, ['▸ 1. alpha', '▸ 2. beta'].join('\n'));
  });
});

describe('renderTable — hybrid width pick', () => {
  it('narrow table → ```-fenced aligned box', () => {
    const rendered = renderTable(parseTable(ratchetTable));
    assert.ok(rendered.startsWith('```\n'));
    assert.ok(rendered.endsWith('\n```'));
    assert.ok(rendered.includes('┌'));
  });

  it('wide table (> budget) → field-value, no fence', () => {
    const longCell = 'x'.repeat(tableMaxMonospaceWidth + 10);
    const wide = ['| Key | Value |', '|---|---|', `| k | ${longCell} |`].join('\n');
    const rendered = renderTable(parseTable(wide));
    assert.ok(!rendered.includes('```'));
    assert.ok(!rendered.includes('┌'));
    assert.ok(rendered.startsWith('▸ k'));
    assert.ok(rendered.includes(`Value: ${longCell}`));
  });
});

describe('renderMarkdownTables — in-place replace, safety guards', () => {
  it('non-table prose WITHOUT a pipe → byte-identical', () => {
    const prose = 'Just a normal paragraph.\nSecond line, no tables here.';
    assert.equal(renderMarkdownTables(prose), prose);
  });

  it('non-table prose WITH a stray pipe → byte-identical (load-bearing)', () => {
    const prose = 'Run `a | b` then read | the output | carefully.\nNo separator row exists.';
    assert.equal(renderMarkdownTables(prose), prose);
  });

  it('a GFM table inside a ``` fence → byte-identical', () => {
    const fenced = ['Here is code:', '```', ...ratchetTable.split('\n'), '```', 'done'].join('\n');
    assert.equal(renderMarkdownTables(fenced), fenced);
  });

  it('preserves surrounding prose and replaces only the table block', () => {
    const input = ['Before the table.', ratchetTable, 'After the table.'].join('\n');
    const out = renderMarkdownTables(input);
    assert.ok(out.startsWith('Before the table.\n'));
    assert.ok(out.endsWith('\nAfter the table.'));
    // The raw pipe header is gone, replaced by a fenced box.
    assert.ok(!out.includes('| Scope | Что | Ratchet |'));
    assert.ok(out.includes('```'));
    assert.ok(out.includes('┌'));
  });

  it('ragged row → padded, no crash', () => {
    const ragged = ['| A | B | C |', '|---|---|---|', '| only |'].join('\n');
    assert.doesNotThrow(() => renderMarkdownTables(ragged));
  });
});

describe('renderAgentHtml integration', () => {
  it('a narrow OpenCode-style table yields a <pre> with all rows present', () => {
    const html = renderAgentHtml(ratchetTable);
    assert.ok(html.startsWith('<pre><code>'));
    assert.ok(html.endsWith('</code></pre>'));
    // No raw pipe header, no literal ``` leaked.
    assert.ok(!html.includes('| Scope |'));
    assert.ok(!html.includes('```'));
    // Body rows survived into the rendered box.
    assert.ok(html.includes('S1'));
    assert.ok(html.includes('S2'));
    // Box glyphs reach Telegram (they are not in the HTML-escape set).
    assert.ok(html.includes('┌'));
  });

  it('arbitrary non-table text round-trips through renderAgentHtml unchanged', () => {
    const plain = 'just some text with a | pipe but no table';
    assert.equal(renderAgentHtml(plain), 'just some text with a | pipe but no table');
  });
});
