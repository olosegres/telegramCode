/**
 * @description PURE classifier that segments a scraped, ANSI-cleaned Claude
 * TUI pane chunk into TAGGED spans, carrying tool-fence context across poll
 * chunks (the same cross-poll state the relay already threads as
 * `session.openToolKind` through {@link stripTuiElementsWithContext}).
 *
 * This is the decision layer for the verbosity scopes (S4 `/tool_results`, S5
 * `/thinking`, S6 sub-agent panel fold): given a chunk it labels each run of
 * lines so a later caller can keep / drop / re-route them per the topic's
 * verbosity mode. S3 only BUILDS and TESTS the classifier — it is NOT wired
 * into the live relay yet, so the relay path keeps behaving exactly as today.
 *
 * Design rules:
 *  - Reuses the line-shape regexes from {@link ./claudeScrapeShapes} and the
 *    sub-agent progress shape from {@link ../progressLine} — ONE definition per
 *    shape, never a copy.
 *  - Conservative default: a line not positively recognised as tool / thinking
 *    / panel chatter / chrome is tagged {@link ClaudeChunkTag.Prose} — the
 *    agent's real answer is never swallowed.
 *  - Cross-poll fence semantics DERIVE FROM {@link fenceToolResultBodies} but
 *    are not identical (this classifier serves the verbosity consumer, not the
 *    fencer): a tool header opens a kind; a `⎿` body or its orphan indented
 *    continuation is the tool body for that kind; a solid prose line closes the
 *    kind. Two intentional divergences, flagged at their call sites below: a
 *    file-kind `⎿` summary is tagged `ToolBody` (the fencer keeps it prose),
 *    and a `◯`/`▰▱` panel line does NOT close an open kind (the fencer resets
 *    it). A future S4 reader must not assume identical reset behavior.
 */

import {
  ANY_TOOL_HEADER_RE,
  CODE_FENCE_LINE_RE,
  COLLAPSE_MARKER_RE,
  COLLAPSE_TOOLUSE_MARKER_RE,
  COMPLETION_SUMMARY_RE,
  FILE_TOOL_HEADER_RE,
  OUTPUT_TOOL_HEADER_RE,
  POST_THINKING_TRAILER_RE,
  PROGRESS_PASSTHROUGH_RE,
  SPINNER_TICK_RE,
  THINKING_HEADER_RE,
  TOOL_RESULT_MARKER_RE,
  TRANSIENT_TICK_RE,
  checkIsClaudeChromeLine,
  type ToolResultKind,
} from './claudeScrapeShapes';
import { SUBAGENT_PROGRESS_LINE_RE } from '../progressLine';

/**
 * @name ClaudeChunkTag
 * @description The classification of a run of pane lines.
 *  - `thinkingBlock`        — "Thinking for {N}s…" / "Thought for Ns" headers,
 *                             their reasoning body, and the post-thinking trailer.
 *  - `toolHeader`           — a tool-call header line (`● Bash(…)`, `✓ Read(…)`).
 *  - `toolBody`             — the `⎿` result body + its fenced/indented body.
 *  - `subagentPanelPreview` — the tool-PREVIEW chatter the TUI draws under a
 *                             running `◯` sub-agent panel (`⎿ Bash(…)` previews,
 *                             "… +N tool uses" walls) — distinct from the ◯
 *                             title line itself (progress, tagged chrome).
 *  - `prose`                — real agent answer text (the conservative default).
 *  - `chrome`               — TUI chrome the relay already drops (box-drawing,
 *                             nav hints, question/survey chrome, input echo,
 *                             installer ads, ◯ panel title, spinner ticks).
 */
export enum ClaudeChunkTag {
  ThinkingBlock = 'thinkingBlock',
  ToolHeader = 'toolHeader',
  ToolBody = 'toolBody',
  SubagentPanelPreview = 'subagentPanelPreview',
  Prose = 'prose',
  Chrome = 'chrome',
}

/** One classified run of consecutive same-tag lines, original order preserved. */
export interface ClaudeChunkSegment {
  tag: ClaudeChunkTag;
  text: string;
}

/**
 * @description Fence / block state threaded BETWEEN poll chunks — mirrors the
 * adapter's `session.openToolKind`. A tool body, a thinking block, or a
 * sub-agent panel can span the boundary between two scraped chunks (Claude
 * redraws the whole pane each poll; the diff emits only NEW lines, so a slow
 * command's output arrives in a later poll without its header).
 */
export interface ClaudeChunkContext {
  /** Open tool-result kind (`output`/`file`) whose body is still streaming, or null. */
  toolKind: ToolResultKind | null;
  /** A "Thinking for…" block is open and its reasoning body is still streaming. */
  isThinkingOpen: boolean;
  /** A `◯` sub-agent panel is on screen, so its `⎿`/`Tool(…)` previews are panel chatter. */
  isSubagentPanelOpen: boolean;
}

/** The all-closed starting context (also used when a fresh session begins). */
export function createInitialChunkContext(): ClaudeChunkContext {
  return { toolKind: null, isThinkingOpen: false, isSubagentPanelOpen: false };
}

/** Result of classifying one chunk: ordered segments + the context to thread on. */
export interface ClaudeChunkClassification {
  segments: ClaudeChunkSegment[];
  outgoingContext: ClaudeChunkContext;
}

/** Indented (leading-whitespace) non-blank continuation line of an open body. */
function checkIsIndentedContinuation(line: string): boolean {
  return /^\s/.test(line) && line.trim() !== '';
}

/** A `⎿` line whose post-marker content is itself a tool-call header = a sub-agent panel preview. */
function checkIsPanelToolPreviewMarker(line: string): boolean {
  const markerMatch = line.match(TOOL_RESULT_MARKER_RE);
  if (!markerMatch) return false;
  const afterMarker = line.slice(markerMatch[0].length);
  return ANY_TOOL_HEADER_RE.test(afterMarker);
}

/**
 * @description Classify one scraped, ANSI-cleaned chunk into tagged segments,
 * threading {@link ClaudeChunkContext} across polls.
 *
 * Per-line precedence (first match wins), then adjacent same-tag lines coalesce:
 *  1. blank line  → inherits the still-open block's tag (keeps a body contiguous)
 *  2. code fence  → toggles an agent fence; inside it everything is prose
 *  3. ◯ panel title / spinner tick / generic chrome → `chrome` (sets panel flag)
 *  4. sub-agent panel preview (`⎿ Tool(…)`, indented `Tool(…)`, "+N tool uses"
 *     while a panel is open) → `subagentPanelPreview`
 *  5. thinking header / trailer / open-thinking body → `thinkingBlock`
 *  6. tool header → `toolHeader` (opens the matching kind)
 *  7. `⎿` marker / indented continuation of an open tool kind → `toolBody`
 *  8. anything else → `prose` (closes any open tool/thinking block)
 */
export function classifyClaudeChunk(
  chunkText: string,
  incomingContext: ClaudeChunkContext,
): ClaudeChunkClassification {
  const lines = chunkText.split('\n');
  const context: ClaudeChunkContext = { ...incomingContext };
  const segments: ClaudeChunkSegment[] = [];
  let inAgentFence = false;

  const push = (tag: ClaudeChunkTag, line: string): void => {
    const last = segments[segments.length - 1];
    if (last && last.tag === tag) {
      last.text += `\n${line}`;
      return;
    }
    segments.push({ tag, text: line });
  };

  /** The tag a blank line / inherited run carries given the open block. */
  const getOpenBlockTag = (): ClaudeChunkTag => {
    if (context.toolKind !== null) return ClaudeChunkTag.ToolBody;
    if (context.isThinkingOpen) return ClaudeChunkTag.ThinkingBlock;
    return ClaudeChunkTag.Prose;
  };

  for (const line of lines) {
    // 0. Inside an agent-authored ``` block: pass through as prose, the fence
    // toggles on its delimiters. A fence line itself stays prose (it is real
    // agent content). Tool/thinking context is irrelevant inside the fence.
    if (CODE_FENCE_LINE_RE.test(line)) {
      inAgentFence = !inAgentFence;
      context.toolKind = null;
      context.isThinkingOpen = false;
      push(ClaudeChunkTag.Prose, line);
      continue;
    }
    if (inAgentFence) {
      push(ClaudeChunkTag.Prose, line);
      continue;
    }

    // 1. Blank line — keep the open block contiguous (do NOT close it; the
    // adapter's fencer also leaves the kind intact across blanks).
    if (line.trim() === '') {
      push(getOpenBlockTag(), line);
      continue;
    }

    // 2. ◯ sub-agent panel title / compaction bar / spinner tick → chrome. The
    // ◯ line marks a panel as open so its previews below are panel chatter; it
    // does NOT close an open tool/thinking block (the panel is a separate pane).
    if (PROGRESS_PASSTHROUGH_RE.test(line) || SUBAGENT_PROGRESS_LINE_RE.test(line)) {
      context.isSubagentPanelOpen = true;
      push(ClaudeChunkTag.Chrome, line);
      continue;
    }
    if (SPINNER_TICK_RE.test(line)) {
      push(ClaudeChunkTag.Chrome, line);
      continue;
    }

    // 3. Sub-agent panel preview chatter (the bulk of the overview-2 flood):
    //   - a `⎿  Bash(…)` whose marker content is itself a tool header;
    //   - a "… +N tool uses" collapse wall while a panel is open;
    //   - an indented bare `Tool(…)` header continuation while a panel is open.
    if (checkIsPanelToolPreviewMarker(line)) {
      context.isSubagentPanelOpen = true;
      push(ClaudeChunkTag.SubagentPanelPreview, line);
      continue;
    }
    if (context.isSubagentPanelOpen && COLLAPSE_MARKER_RE.test(line)) {
      push(ClaudeChunkTag.SubagentPanelPreview, line);
      continue;
    }
    if (
      context.isSubagentPanelOpen &&
      checkIsIndentedContinuation(line) &&
      ANY_TOOL_HEADER_RE.test(line)
    ) {
      push(ClaudeChunkTag.SubagentPanelPreview, line);
      continue;
    }

    // An orphan "… +N tool uses" collapse wall (panel already closed / scrolled
    // off, no open panel context above) is still sub-agent panel chrome — drop it
    // rather than leak it as prose. The panel-OPEN case is handled above (folds to
    // a sub-agent status activity); this catches the orphan tail. "+N lines" (a
    // real tool-body summary) is deliberately NOT matched here.
    if (COLLAPSE_TOOLUSE_MARKER_RE.test(line)) {
      push(ClaudeChunkTag.Chrome, line);
      continue;
    }

    // 4. Thinking block: header opens it, trailer / body continue it.
    if (THINKING_HEADER_RE.test(line)) {
      context.isThinkingOpen = true;
      context.toolKind = null;
      context.isSubagentPanelOpen = false;
      push(ClaudeChunkTag.ThinkingBlock, line);
      continue;
    }
    if (POST_THINKING_TRAILER_RE.test(line.trim())) {
      // The trailer closes the thinking block (the reasoning is done).
      context.isThinkingOpen = false;
      push(ClaudeChunkTag.ThinkingBlock, line);
      continue;
    }
    if (context.isThinkingOpen) {
      // The reasoning body: the `⎿  <summary>` line and its indented wrapped
      // continuation. A non-indented, non-`⎿` solid line ends the block (it is
      // the agent resuming prose / a tool header), handled by falling through.
      if (TOOL_RESULT_MARKER_RE.test(line) || checkIsIndentedContinuation(line)) {
        push(ClaudeChunkTag.ThinkingBlock, line);
        continue;
      }
      context.isThinkingOpen = false;
    }

    // 5. Tool header → opens the matching fence kind (output / file / generic).
    if (ANY_TOOL_HEADER_RE.test(line)) {
      context.isSubagentPanelOpen = false;
      if (OUTPUT_TOOL_HEADER_RE.test(line)) context.toolKind = 'output';
      else if (FILE_TOOL_HEADER_RE.test(line)) context.toolKind = 'file';
      else context.toolKind = 'output'; // non-code tools: treat the body region as one block
      push(ClaudeChunkTag.ToolHeader, line);
      continue;
    }

    // 6. `⎿` result marker. With an open tool kind it is the tool body. With no
    // open kind the header was consumed by a prior poll's line-SET diff and an
    // interleaved prose line nulled the context (rule #10) — the `⎿` glyph is
    // itself a positive tool-result signal in the TUI, so OPEN a synthetic
    // `output` kind and tag it ToolBody. The indented-continuation branch (#7)
    // then keeps the rest of the orphan result region as ToolBody until a solid
    // prose line ends the run. Without this an orphan `⎿ trace rows: …` block
    // leaked as Prose, which the router always keeps even in minimal.
    if (TOOL_RESULT_MARKER_RE.test(line)) {
      if (context.toolKind === null) context.toolKind = 'output';
      context.isSubagentPanelOpen = false;
      push(ClaudeChunkTag.ToolBody, line);
      continue;
    }

    // 7. Orphan indented continuation of an open tool body (header / `⎿` came in
    // a prior poll) → tool body. Mirrors the adapter's orphan-output fencing.
    if (context.toolKind !== null && checkIsIndentedContinuation(line)) {
      push(ClaudeChunkTag.ToolBody, line);
      continue;
    }

    // 8. Tool-body status / summary lines (`Running…`, "… +N lines",
    // "Done (… tokens)") belong to the open tool body region.
    if (
      context.toolKind !== null &&
      (TRANSIENT_TICK_RE.test(line) ||
        COLLAPSE_MARKER_RE.test(line) ||
        COMPLETION_SUMMARY_RE.test(line))
    ) {
      push(ClaudeChunkTag.ToolBody, line);
      continue;
    }

    // 9. Generic TUI chrome (box-drawing, nav hints, installer ad, input echo).
    if (checkIsClaudeChromeLine(line)) {
      push(ClaudeChunkTag.Chrome, line);
      continue;
    }

    // 10. Default: real agent prose. A solid prose line CLOSES any open tool /
    // thinking / panel block (the agent has resumed answering).
    context.toolKind = null;
    context.isThinkingOpen = false;
    context.isSubagentPanelOpen = false;
    push(ClaudeChunkTag.Prose, line);
  }

  return { segments, outgoingContext: context };
}
