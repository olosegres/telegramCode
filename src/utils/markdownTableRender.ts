/**
 * @description Pure pre-processing pass that turns raw GitHub-flavored
 * markdown tables (`| a | b |` …) into a readable Telegram form.
 *
 * Why this exists: OpenCode replies often contain GFM tables as plain pipe
 * text, which is unreadable on a phone. This module detects those blocks and
 * rewrites each one to a HYBRID rendering chosen by width:
 *  - narrow table (aligned form fits {@link tableMaxMonospaceWidth}) → a
 *    column-aligned box-drawing frame WRAPPED in a ``` fence, so the shared
 *    `renderAgentHtml` fence machinery turns it into a `<pre>` (monospace).
 *  - wide table → per-row "field: value" blocks as plain markdown lines, which
 *    flow through the normal bold/inline passes.
 *
 * It is wired as step 0.5 of `renderAgentHtml` (after the control-char strip,
 * before the fence regex) and therefore runs on EVERY agent output for BOTH
 * backends. Two safety invariants follow from that:
 *  1. it is FENCE-AWARE — lines inside an existing ```-delimited region are
 *     never scanned for tables (a code block full of pipes must survive);
 *  2. it leaves all non-table text byte-for-byte identical.
 *
 * The detector is narrow on purpose (header pipe row + GFM separator row +
 * ≥1 body rows), so ordinary prose containing a stray `|` never matches.
 */

/**
 * Width budget (in monospace code points) for the aligned form. If the widest
 * line of the box-drawing render exceeds this, the renderer falls back to the
 * "field: value" form instead. Chosen so an aligned table still fits a typical
 * phone without horizontal scroll. Tunable — the main agent confirms/adjusts
 * the exact value via live verification.
 */
export const tableMaxMonospaceWidth = 42;

/** A contiguous block of source lines that form one GFM table. */
export interface TableLineRange {
  startLine: number;
  endLineExclusive: number;
}

/** A parsed table: header cells + body rows (each row already padded to the
 *  header width). */
export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

// Box-drawing glyphs for the aligned frame.
const boxTopLeft = '┌';
const boxTopMid = '┬';
const boxTopRight = '┐';
const boxMidLeft = '├';
const boxMidMid = '┼';
const boxMidRight = '┤';
const boxBottomLeft = '└';
const boxBottomMid = '┴';
const boxBottomRight = '┘';
const boxVertical = '│';
const boxHorizontal = '─';

/** Field-value form: the marker that precedes each row's key cell. */
const fieldValueRowMarker = '▸';

/**
 * A GFM separator row: each column is dashes with optional leading/trailing
 * colons for alignment, cells split by `|`, outer pipes optional. At least one
 * dash per column. Examples: `|---|---|`, `:--:|:-:`, `| --- | :---: |`.
 */
const separatorRowRegex = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A line that looks like a table row: contains at least one `|`. The narrow
 *  detector below additionally requires a valid separator row to follow the
 *  header, so this loose check alone never triggers on prose. */
function checkIsPipeRow(line: string): boolean {
  return line.includes('|');
}

/**
 * Split one table row on UNESCAPED `|`, trim each cell, and drop the empty
 * edge cells produced by outer pipes (`| a | b |` → `['a', 'b']`). Escaped
 * `\|` is preserved as a literal pipe inside a cell.
 */
function parseRowCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === '\\' && line[index + 1] === '|') {
      current += '|';
      index += 2;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  cells.push(current);

  const trimmed = cells.map((cell) => cell.trim());
  // Drop a single empty cell at each edge — the artifact of outer pipes. Only
  // ONE per side: an intentionally-empty interior cell stays.
  if (trimmed.length > 0 && trimmed[0] === '') trimmed.shift();
  if (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

/**
 * Find every GFM table block in `text`, returning their line ranges. A block
 * is a header pipe row, a separator row directly below it, then ≥1 consecutive
 * pipe body rows. Lines inside an existing ```-fenced region are skipped, so a
 * code block containing pipes never matches.
 */
export function detectTables(text: string): TableLineRange[] {
  const lines = text.split('\n');
  const ranges: TableLineRange[] = [];
  let isInsideFence = false;
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];

    // Track ``` fence open/close state line by line — never scan inside one.
    if (/^\s*```/.test(line)) {
      isInsideFence = !isInsideFence;
      lineIndex += 1;
      continue;
    }
    if (isInsideFence) {
      lineIndex += 1;
      continue;
    }

    const separatorIndex = lineIndex + 1;
    const headerCells = parseRowCells(line);
    const isTableStart =
      checkIsPipeRow(line) &&
      separatorIndex < lines.length &&
      separatorRowRegex.test(lines[separatorIndex]) &&
      // A bare separator with no header text isn't a table.
      headerCells.length > 0 &&
      // GFM requires the delimiter row to match the header's column count. This
      // also rejects a `---` thematic break sitting under a pipe-bearing prose
      // line (which `separatorRowRegex` alone would accept) — a false positive
      // that matters because this runs on EVERY agent output.
      parseRowCells(lines[separatorIndex]).length === headerCells.length;

    if (!isTableStart) {
      lineIndex += 1;
      continue;
    }

    // Consume consecutive body rows after the separator.
    let bodyIndex = separatorIndex + 1;
    while (bodyIndex < lines.length && !/^\s*```/.test(lines[bodyIndex]) && checkIsPipeRow(lines[bodyIndex])) {
      bodyIndex += 1;
    }

    // Require ≥1 body row — a header+separator with no rows isn't worth a frame.
    if (bodyIndex > separatorIndex + 1) {
      ranges.push({ startLine: lineIndex, endLineExclusive: bodyIndex });
      lineIndex = bodyIndex;
      continue;
    }

    lineIndex += 1;
  }

  return ranges;
}

/**
 * Parse a table block (the raw lines of one detected range, joined by `\n`)
 * into headers + rows. Ragged rows shorter than the header are padded with
 * `''`; rows longer than the header keep their extra cells (so nothing is
 * silently lost — the aligned form widens to fit).
 */
export function parseTable(block: string): ParsedTable {
  const lines = block.split('\n').filter((line) => line.trim().length > 0);
  const headers = parseRowCells(lines[0]);
  // lines[1] is the separator row — skip it.
  const bodyLines = lines.slice(2);
  const rows = bodyLines.map((line) => {
    const cells = parseRowCells(line);
    while (cells.length < headers.length) cells.push('');
    return cells;
  });
  return { headers, rows };
}

/**
 * Strip the inline-markdown markers (`**`, `*`, `` ` ``) that are invisible in
 * the final render, so column width is measured on the VISIBLE text. Used for
 * width math only — the rendered cell keeps its markers.
 */
function getVisibleCellText(cell: string): string {
  return cell.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
}

/** Display width of a cell in CODE POINTS (not UTF-16 units), counted on the
 *  visible text so Cyrillic / emoji columns align. */
function getCellDisplayWidth(cell: string): number {
  return [...getVisibleCellText(cell)].length;
}

/** Right-pad `cell` with spaces to `width` code points (visible width). */
function padCellToWidth(cell: string, width: number): string {
  const padding = width - getCellDisplayWidth(cell);
  return padding > 0 ? cell + ' '.repeat(padding) : cell;
}

/** Per-column max display width across header + all rows. */
function getColumnWidths(table: ParsedTable): number[] {
  const columnCount = table.rows.reduce(
    (max, row) => Math.max(max, row.length),
    table.headers.length,
  );
  const widths: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    const headerWidth = column < table.headers.length ? getCellDisplayWidth(table.headers[column]) : 0;
    const bodyWidth = table.rows.reduce(
      (max, row) => Math.max(max, column < row.length ? getCellDisplayWidth(row[column]) : 0),
      0,
    );
    widths.push(Math.max(headerWidth, bodyWidth));
  }
  return widths;
}

/** Build one bordered content line: `│ cell │ cell │` padded to column widths. */
function buildAlignedRow(cells: string[], widths: number[]): string {
  const padded = widths.map((width, column) => padCellToWidth(cells[column] ?? '', width));
  return `${boxVertical} ${padded.join(` ${boxVertical} `)} ${boxVertical}`;
}

/** Build one frame line (top / middle / bottom) from the three corner glyphs. */
function buildFrameLine(left: string, mid: string, right: string, widths: number[]): string {
  const segments = widths.map((width) => boxHorizontal.repeat(width + 2));
  return `${left}${segments.join(mid)}${right}`;
}

/**
 * Render the table as a monospace, column-aligned box-drawing frame. The
 * caller wraps the result in a ``` fence so the HTML layer makes it a `<pre>`.
 */
export function renderAligned(table: ParsedTable): string {
  const widths = getColumnWidths(table);
  const out: string[] = [];
  out.push(buildFrameLine(boxTopLeft, boxTopMid, boxTopRight, widths));
  out.push(buildAlignedRow(table.headers, widths));
  out.push(buildFrameLine(boxMidLeft, boxMidMid, boxMidRight, widths));
  for (const row of table.rows) out.push(buildAlignedRow(row, widths));
  out.push(buildFrameLine(boxBottomLeft, boxBottomMid, boxBottomRight, widths));
  return out.join('\n');
}

/**
 * Render the table as per-row "field: value" blocks for the wide case. The
 * first column is the key cell (after `▸`); remaining columns become
 * `  <header>: <cell>` lines. Inline markdown in cell text is kept — the HTML
 * layer renders it. When there is only one column (no obvious key/value split)
 * the rows are numbered instead.
 */
export function renderFieldValue(table: ParsedTable): string {
  const hasKeyColumn = table.headers.length >= 2;
  const blocks = table.rows.map((row, rowIndex) => {
    const lines: string[] = [];
    if (hasKeyColumn) {
      lines.push(`${fieldValueRowMarker} ${row[0] ?? ''}`);
      for (let column = 1; column < table.headers.length; column += 1) {
        lines.push(`  ${table.headers[column]}: ${row[column] ?? ''}`);
      }
    } else {
      // No key column to anchor on — number the rows so they stay distinct.
      lines.push(`${fieldValueRowMarker} ${rowIndex + 1}. ${row[0] ?? ''}`);
    }
    return lines.join('\n');
  });
  return blocks.join('\n');
}

/** Widest line (in code points) of an aligned render — the width-budget input. */
function getAlignedWidestLineWidth(aligned: string): number {
  return aligned.split('\n').reduce((max, line) => Math.max(max, [...line].length), 0);
}

/**
 * Pick the rendering for one table: aligned (fenced) if its widest line fits
 * {@link tableMaxMonospaceWidth}, else the field-value form. Returns the text
 * already wrapped for the HTML layer (``` fence for aligned, plain lines for
 * field-value).
 */
export function renderTable(table: ParsedTable): string {
  const aligned = renderAligned(table);
  if (getAlignedWidestLineWidth(aligned) <= tableMaxMonospaceWidth) {
    return `\`\`\`\n${aligned}\n\`\`\``;
  }
  return renderFieldValue(table);
}

/**
 * Replace every detected GFM table block in `text` with its chosen rendering,
 * in place. Non-table text and fenced regions are returned byte-for-byte
 * unchanged. This is the single entry point wired into `renderAgentHtml`.
 */
export function renderMarkdownTables(text: string): string {
  const ranges = detectTables(text);
  if (ranges.length === 0) return text;

  const lines = text.split('\n');
  const out: string[] = [];
  let lineIndex = 0;
  let rangeIndex = 0;

  while (lineIndex < lines.length) {
    const range = ranges[rangeIndex];
    if (range && lineIndex === range.startLine) {
      const block = lines.slice(range.startLine, range.endLineExclusive).join('\n');
      out.push(renderTable(parseTable(block)));
      lineIndex = range.endLineExclusive;
      rangeIndex += 1;
      continue;
    }
    out.push(lines[lineIndex]);
    lineIndex += 1;
  }

  return out.join('\n');
}
