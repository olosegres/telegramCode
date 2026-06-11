/**
 * @description Single source of truth for the LINE-SHAPE regexes/predicates of
 * a scraped, ANSI-cleaned Claude TUI pane. These were originally private to
 * `adapters/claudeCliAdapter.ts`; they were lifted here so BOTH the adapter
 * (`stripTuiElementsWithContext` / `fenceToolResultBodies`) and the chunk
 * classifier (`utils/claudeChunkClassifier.ts`) consume ONE definition per
 * shape — never a copy. The rationale comments live with each shape below.
 *
 * Exception: {@link checkIsClaudeChromeLine} is a DELIBERATE parallel of the
 * adapter's inline chrome filters (the adapter drops those lines mid-strip and
 * is NOT yet rewired to this predicate — that wiring is a behavior change
 * deferred to S4–S6). Keep the two in sync until then; unify when the relay
 * starts consuming the classifier.
 *
 * Pure module: regexes + small line predicates only, no I/O, no state. Whole-
 * block detectors that need parsing state (question/survey extraction, input-
 * echo) stay in the adapter and are imported there, not here.
 */

/**
 * @description Active spinner tick, per-line shape used by Claude's TUI
 * while it is thinking or running a tool. Examples:
 *   `✽ Doing… (4s · ↓ 14 tokens)`
 *   `* Brewing… (1m 30s · ↑ 88 tokens · thought for 17s)`
 *   `· Working… (7s · ↓ 222 tokens)`
 *
 * Plan §2026-05-28 tg-output-readability / S4 (N1.b). Why a SECOND
 * regex on top of `PROGRESS_LINE_RE` (in `progressLine.ts`): different
 * job — this one strips tick lines that ride INSIDE a chunk that also
 * carries real output, while `PROGRESS_LINE_RE` classifies whole
 * pure-progress chunks bot-side. This regex does not require the token
 * counter (`(5s)` alone matches), `PROGRESS_LINE_RE` does. Both accept
 * a multi-word activity text since 2026-06-05 — the TUI now shows the
 * active task title there ("Fixing streaming output overwrite…"), and
 * the single-token `\S+…` let those ticks leak into permanent messages
 * (adapter side) / flood the topic (bot side). Since 2026-06-11 both
 * also accept single-level parenthesised segments inside the title —
 * the TUI appends bits like "(sub-agent)" while a Task sub-agent runs
 * ("Fixing relations add flow (sub-agent)…", the live topic flood), and
 * a task title can carry its own parens. The trailing end-anchored
 * `(<elapsed>[ · …])` parenthesis stays the load-bearing anchor — the
 * same safety argument as the multi-word widening.
 *
 * The required text-with-ellipsis disambiguates this from a tool-call
 * header (`● Bash(ls -la)`), which starts with the same `●` glyph but
 * has no ellipsis.
 */
export const SPINNER_TICK_RE =
  /^\s*[✻✽✶✢·*●○]\s+\S(?:[^()\n]|\([^()\n]*\))*?…\s*\((?:\d+h\s+)?(?:\d+m\s+)?\d+s(?:\s*·[^()]*)?\)\s*$/;

/**
 * @description Post-thinking trailer line that Claude's TUI prints
 * AFTER it has finished thinking (just before resuming the prompt
 * area). Examples observed in the live ExampleGroup debug session:
 *   `✻ Cooked for 27s`        (msg 1855, 1863)
 *   `✻ Cogitated for 20s`     (msg 1873)
 *   `✻ Crunched for 7s`       (msg 1869)
 *   `✻ Baked for 10s`         (msg 1837)
 *   `✻ Churned for 20s`       (msg 1897 — V3 iteration 1, 2026-05-28)
 *   `✻ Sautéed for 20s`       (msg 1909 — V3 iteration 2, 2026-05-28)
 *
 * Plan §2026-05-28 tg-output-readability / S3 (N1.a). The trailer
 * carries zero novel info — the same time was already streaming in
 * the active spinner that preceded it — so we drop it.
 *
 * Verb match is `\S+`, not an explicit list. The original plan called
 * for an explicit list of `-ed` forms (Cooked|Cogitated|...) on the
 * theory that a future Claude verb that IS real prose (e.g.
 * `✻ Ready for input`) could be silently swallowed. Two live V3
 * iterations on 2026-05-28 demonstrated the opposite failure mode:
 * Claude ships new spinner verbs faster than we'd realistically
 * extend the list (`Churned` and `Sautéed` both slipped through on
 * first encounter). The triple anchor `<glyph> <verb> for <N>s` is
 * shape-specific enough that real prose almost cannot satisfy it:
 *   - line must START with a spinner glyph (`✻✽✶✢·*●○`) — outside
 *     transient TUI status, Claude never emits these as the first
 *     non-whitespace char of a prose line;
 *   - line must END with `for \d+(?:m\s+\d+)?s` — a time literal,
 *     not a generic noun;
 *   - line has no other content (anchored `$`).
 * `\S+` is the minimal relaxation: one non-whitespace token between
 * the glyph and ` for `. Accepts `Sautéed`, `Churned`, future verbs,
 * and rejects anything containing whitespace or extra structure.
 */
export const POST_THINKING_TRAILER_RE =
  /^[✻✽✶✢·*●○]\s+\S+\s+for\s+\d+(?:m\s+\d+)?s\s*$/;

/**
 * @description Static "Thinking for {N}s…" header line the TUI prints at the
 * TOP of a finished reasoning block (distinct from {@link SPINNER_TICK_RE},
 * the LIVE rolling tick, and {@link POST_THINKING_TRAILER_RE}, the closing
 * "Cooked for Ns" trailer). After `cleanOutput`'s ANSI-bold→`*…*` conversion
 * the duration is bolded: `Thinking for *1m 6s*…`. The `⎿`-bodied reasoning
 * summary follows on the next lines (see claudeToolFencing.test.ts).
 *
 * Anchored: glyph-or-bullet-optional `Thinking for`, a duration (`30s`,
 * `1m 6s`, optionally `*`-wrapped), then the U+2026 ellipsis. The duration is
 * load-bearing so a prose sentence "Thinking for a moment about X" cannot
 * match (no `\d+s…` tail).
 */
export const THINKING_HEADER_RE =
  /^\s*[●○✻✽✶✢·*]?\s*Thinking for\s+\*?(?:\d+h\s+)?(?:\d+m\s+)?\d+s\*?…/;

/**
 * @description Code-producing tool headers whose `⎿` result is code / diff /
 * command output and should render as a monospaced Telegram code block. Two
 * classes, differing in what the `⎿` line itself holds:
 *
 *  - OUTPUT tools (`Bash`/`Grep`/`Glob`): the `⎿`-line content IS the first
 *    line of stdout, so it goes INSIDE the fence with the indented body;
 *  - FILE tools (`Read`/`Edit`/`Update`/`Write`/`MultiEdit`/`NotebookEdit`):
 *    the `⎿` line is a one-line summary (`Added N lines, removed M`) that
 *    stays as prose — only the deeper-indented diff/file body below it is
 *    fenced.
 *
 * Anchored on the tool NAME (optionally glyph-led and/or `*bold*` from the
 * ANSI-bold conversion), NEVER on body indent: Claude wraps long thinking
 * prose at the 300-col pane width into space-indented continuation lines
 * byte-identical in shape to a diff/output body, so only a known code header
 * may license fencing (a thinking block has no such header). Allowlist, not
 * blocklist — unknown shapes stay prose.
 */
export const OUTPUT_TOOL_HEADER_RE = /^\s*[●○⏳✓]?\s*\*?(?:Bash|Grep|Glob)\*?\s*\(/;
export const FILE_TOOL_HEADER_RE =
  /^\s*[●○⏳✓]?\s*\*?(?:Read|Edit|Update|Write|MultiEdit|NotebookEdit)\*?\s*\(/;

/**
 * @description ANY tool-call header line (`● Bash(…)`, `✓ Read(…)`,
 * `● Task(…)`, `● TodoWrite(…)`, `● WebFetch(…)`). Superset of the two
 * fence-deciding headers above (which only cover code-producing tools): used
 * by the classifier to TAG a header line as `toolHeader` regardless of whether
 * its body would be fenced. Anchored on the tool NAME from Claude's known set,
 * optionally glyph-led and/or `*bold*`, followed by `(`.
 */
export const ANY_TOOL_HEADER_RE =
  /^\s*[●○⏳✓]?\s*\*?(?:Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep|Task|Agent|TodoWrite|WebFetch|WebSearch)\*?\s*\(/;

/** Tool RESULT marker line: `  ⎿  <summary or first output line>`. */
export const TOOL_RESULT_MARKER_RE = /^(\s*)⎿/;

/** An agent-authored fenced code block delimiter, possibly indented. */
export const CODE_FENCE_LINE_RE = /^\s*```/;

/**
 * @description Lines the bot's progress-collapse owns and must receive
 * UN-fenced: a sub-agent task line (`◯`, optionally `❯`-cursor-led, U+25EF —
 * NOT the `○`/`●` glyphs) and a compaction progress bar (`▰▱`). They are
 * indented in the pane, so a stale `output` tool kind would otherwise route
 * them through the orphan-continuation fence; the resulting ```` ``` ````
 * delimiters then fail `checkIsProgressChunk` (progressLine.ts), so the burst
 * is NOT coalesced and the topic floods with one fenced tick per second.
 */
export const PROGRESS_PASSTHROUGH_RE = /^\s*(?:❯\s+)?◯\s|^\s*[▰▱]/;

/**
 * @description Transient activity tick the TUI paints INSIDE a tool-result
 * body while the command is still running (`Running…`, `Waiting…`), with no
 * elapsed-time paren. {@link SPINNER_TICK_RE} only catches the glyph-led
 * `(Ns)` form, so these bare words slip through and get fenced as if they
 * were stdout. They are ephemeral chrome, never command output: render plain,
 * and DROP entirely when real output supersedes them in the same body.
 */
export const TRANSIENT_TICK_RE = /^\s*(?:Running|Waiting)…\s*(?:\([^)]*\))?\s*$/;

/**
 * @description The TUI's "output was collapsed" marker (`… +1 tool use`,
 * `… +33 lines`). Anchored to the literal `… +N tool use(s)/line(s)` shape so
 * a real one-line stdout that merely ends in `…` is never matched. Chrome, not
 * output → render plain, never fenced.
 */
export const COLLAPSE_MARKER_RE = /^\s*…\s*\+\d+\s+(?:tool use|line)s?\b.*$/;

/**
 * @description Turn / sub-agent completion summary (`Done (14 tool uses ·
 * 66.9k tokens · 1m 55s)`). The `tokens` inside the paren is the load-bearing
 * anchor — a real `Done (…)` stdout line without token stats is not matched.
 * Chrome, not output → render plain, never fenced.
 */
export const COMPLETION_SUMMARY_RE = /^\s*Done\s*\([^)]*tokens[^)]*\)\s*$/;

/**
 * @description Which tool a `⎿` result body belongs to, deciding how it is
 * fenced: `output` (Bash/Grep/Glob — the `⎿` line is stdout, fenced with the
 * body) vs `file` (Read/Edit/Update/Write — the `⎿` line is a prose summary,
 * only the body below is fenced).
 */
export type ToolResultKind = 'output' | 'file';

/**
 * @description Whole-line TUI chrome a scrape chunk can carry that the relay
 * already drops: rounded box-drawing borders, full-width rules, nav / hint
 * footers ("Enter to select", "esc to …", "↑/↓ …"), the bypass-permissions
 * footer, tab-bar rows, and the native-installer ad. Consolidated here from
 * the inline filters in `stripTuiElementsWithContext` so the classifier tags
 * the SAME lines as `chrome` without re-declaring each shape.
 *
 * Conservative by design — every branch is anchored on a TUI-only glyph or an
 * exact phrase, so a real prose line is never mistaken for chrome (the
 * classifier's default is `prose`).
 */
export function checkIsClaudeChromeLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  return (
    // Full-width horizontal rule.
    /^[─━]+$/.test(trimmed) ||
    // Pure box-drawing / blank composite (rounded chrome borders).
    /^[╭╮╰╯┌┐└┘├┤┬┴┼─━│┃\s]+$/.test(trimmed) ||
    // Wide bordered chrome panel row (rounded corners, >50 chars).
    (/[╭─╮│╰╯]/.test(line) && trimmed.length > 50) ||
    // Block / shade UI fill.
    /^[▐▛▜▌▝▘█▀▄░▒▓\s]+$/.test(trimmed) ||
    // Tab-bar navigation row (← … →).
    /^←.*→\s*$/.test(trimmed) ||
    // Selection / navigation hint footers.
    /Enter to select/i.test(line) ||
    /\(shift\+tab to cycle\)/i.test(line) ||
    /⏵⏵\s*(?:bypass permissions|accept edits)\s*(?:on|off)/i.test(line) ||
    // Input-box cursor row / cursor-led nav.
    /^❯/.test(trimmed) ||
    // Ephemeral "Tip:" affordance under a turn.
    /^⎿\s*Tip:\s/i.test(trimmed) ||
    // Native-installer ad / docs link.
    /claude code has switched|native installer|Run.*install.*or see/i.test(line) ||
    /docs\.anthropic\.com/i.test(line) ||
    // Resume / welcome chrome.
    /Recent activity|What's new|\/resume for more/i.test(line) ||
    /Welcome\s*back/i.test(line)
  );
}
