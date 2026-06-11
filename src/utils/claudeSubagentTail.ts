/**
 * @description Pure decision logic for tailing Claude's on-disk SUB-AGENT
 * transcripts (`/subagent full` on the Claude backend, plan
 * 2026-06-11-subagent-claude-and-progress-flood S3). Claude writes each
 * Task-tool child transcript to
 * `<projectsRoot>/<slug>/<claudeSessionId>/subagents/agent-<agentId>.jsonl`;
 * the adapter's poll loop scans that directory and feeds file sizes /
 * appended bytes in — this module owns every decision (what to read, what to
 * emit) and never touches the filesystem, so the rules are unit-testable
 * without tmux or a real transcript dir.
 *
 * Locked rules:
 * - the FIRST scan of a session seeds every existing file's offset to its
 *   current size and emits NOTHING — resuming/adopting a session must never
 *   replay an old sub-agent's backlog (a fresh session's dir is empty, so
 *   nothing is lost there);
 * - mode ≠ `full` fast-forwards offsets to the current size WITHOUT the
 *   caller reading file contents, so a mid-run flip to `full` streams from
 *   that moment, not from history;
 * - only `text` blocks of `assistant` entries are extracted — child reasoning
 *   (`thinking`) and `tool_use` blocks are never rendered (parity with the
 *   OpenCode sub-agent matrix in `subagentRender.ts`).
 */
import type { DisplayVerbosityMode } from '../types';

/** Claude's sub-agent transcript filename shape (`agent-<agentId>.jsonl`).
 * The sibling `agent-<agentId>.meta.json` files must NOT match. */
const subagentTranscriptNamePattern = /^agent-.+\.jsonl$/;

/**
 * @description Tail bookkeeping for ONE sub-agent transcript file.
 */
export interface SubagentFileTail {
  /** Bytes of this transcript already consumed (or deliberately skipped). */
  offsetBytes: number;
  /** Trailing partial line carried into the next appended read. */
  carry: string;
}

/**
 * @description Per-session sub-agent tail state. Created fresh on every
 * session object (start / resume / adopt) so the first-scan seeding rule
 * applies per session lifetime. Bounded by the session's sub-agent count —
 * no eviction needed (the transcript dir is scoped to one `claudeSessionId`).
 */
export interface SubagentTailState {
  /** Flips on the very first scan, which only seeds offsets and never reads. */
  isFirstScanDone: boolean;
  /** Per transcript-file tail, keyed by file name (unique within the dir). */
  fileTails: Map<string, SubagentFileTail>;
}

/** One transcript file observed by a directory scan: its name + current size. */
export interface SubagentScanFile {
  fileName: string;
  sizeBytes: number;
}

/** A byte range the caller must read and feed to
 * {@link extractAppendedSubagentTexts}: `[startOffset..endOffset)`. */
export interface SubagentTailRead {
  fileName: string;
  /** First byte to read (inclusive). */
  startOffset: number;
  /** Byte to stop at (exclusive) — the file's size at scan time. */
  endOffset: number;
}

export function createSubagentTailState(): SubagentTailState {
  return { isFirstScanDone: false, fileTails: new Map() };
}

/**
 * @description Is `fileName` a sub-agent transcript (`agent-*.jsonl`)?
 * Filters out the sibling `agent-*.meta.json` files and anything else the
 * directory may grow in future Claude versions.
 */
export function checkIsSubagentTranscriptName(fileName: string): boolean {
  return subagentTranscriptNamePattern.test(fileName);
}

/**
 * @description Narrow an untyped `JSON.parse` result to a plain object so its
 * fields can be read with `typeof` guards instead of casts (parse-boundary
 * pattern for untrusted on-disk data; mirrors `isRecord` in `state.ts`).
 */
function checkIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @description Decide which byte ranges the caller must read this scan,
 * advancing per-file offsets. Offsets advance OPTIMISTICALLY (to the scanned
 * size) even before the read happens: if the caller's read then fails, those
 * bytes are skipped rather than replayed — drop-over-resend, same tradeoff as
 * the relay window.
 *
 * - First scan ever → seed every file's offset to its size, return no reads
 *   (no backlog replay on resume/adopt).
 * - Mode ≠ `full` → fast-forward offsets to the current size, return no reads
 *   (the carry is dropped too: its line's remainder was skipped with the jump).
 * - Mode = `full` → return `[offset..size)` for every grown file; a file first
 *   seen AFTER the first scan starts at offset 0 (it belongs to work started
 *   under this session).
 * - A file SMALLER than its recorded offset (truncated/rewritten — should not
 *   happen for append-only transcripts) is re-seeded to its new EOF.
 */
export function getSubagentTailReads(
  state: SubagentTailState,
  scannedFiles: readonly SubagentScanFile[],
  mode: DisplayVerbosityMode,
): SubagentTailRead[] {
  if (!state.isFirstScanDone) {
    state.isFirstScanDone = true;
    for (const { fileName, sizeBytes } of scannedFiles) {
      state.fileTails.set(fileName, { offsetBytes: sizeBytes, carry: '' });
    }
    return [];
  }

  const reads: SubagentTailRead[] = [];
  for (const { fileName, sizeBytes } of scannedFiles) {
    const tail = state.fileTails.get(fileName);
    if (!tail) {
      state.fileTails.set(fileName, { offsetBytes: sizeBytes, carry: '' });
      if (mode === 'full' && sizeBytes > 0) {
        reads.push({ fileName, startOffset: 0, endOffset: sizeBytes });
      }
      continue;
    }
    if (sizeBytes < tail.offsetBytes) {
      tail.offsetBytes = sizeBytes;
      tail.carry = '';
      continue;
    }
    if (sizeBytes === tail.offsetBytes) continue;
    if (mode !== 'full') {
      tail.offsetBytes = sizeBytes;
      tail.carry = '';
      continue;
    }
    reads.push({ fileName, startOffset: tail.offsetBytes, endOffset: sizeBytes });
    tail.offsetBytes = sizeBytes;
  }
  return reads;
}

/**
 * @description Pull the renderable text out of ONE transcript JSONL line.
 * Only `assistant` entries contribute, and only their `text` content blocks —
 * `thinking` / `tool_use` blocks and `user` / `attachment` entries are
 * dropped (locked parity with OpenCode sub-agent rendering). A line that is
 * not valid JSON (torn write caught mid-append) is skipped silently — the
 * next complete line still parses.
 */
function getAssistantTextBlocks(line: string): string[] {
  const trimmedLine = line.trim();
  if (!trimmedLine) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedLine);
  } catch {
    return [];
  }
  if (!checkIsRecord(parsed) || parsed.type !== 'assistant') return [];
  const message = parsed.message;
  if (!checkIsRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (checkIsRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      texts.push(block.text);
    }
  }
  return texts;
}

/**
 * @description Turn the bytes appended to one transcript (the range a
 * {@link getSubagentTailReads} entry asked for) into the ordered list of
 * renderable sub-agent text blocks. Prepends the file's carried partial line,
 * splits on `\n`, keeps the new trailing partial line as the carry, and
 * extracts via {@link getAssistantTextBlocks}.
 */
export function extractAppendedSubagentTexts(
  state: SubagentTailState,
  fileName: string,
  appendedText: string,
): string[] {
  const tail = state.fileTails.get(fileName);
  if (!tail) return [];
  const combined = tail.carry + appendedText;
  const lines = combined.split('\n');
  tail.carry = lines.pop() ?? '';
  const texts: string[] = [];
  for (const line of lines) {
    texts.push(...getAssistantTextBlocks(line));
  }
  return texts;
}
