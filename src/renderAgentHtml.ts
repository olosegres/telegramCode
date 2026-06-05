/**
 * @description Render the agent adapters' "markdown-ish" output
 * (`*bold*`, `**bold**`, `# headings`, `` `inline` ``, ```` ```fenced``` ````,
 * `[text](url)`) into Telegram **HTML**.
 *
 * Why HTML instead of the legacy Markdown path: Telegram's classic Markdown
 * drops the WHOLE message to unformatted plain text on a single stray `*` or
 * an unbalanced backtick — this is the live "git diff shows literal ``` ``` ```
 * ``` characters" bug. HTML's only specials are `& < >`, so lone punctuation is
 * inert and fenced code / diffs render as real monospaced blocks.
 *
 * Used ONLY for streamed agent output + status frames. Bot-authored `t(...)`
 * templates keep their legacy Markdown rendering — they don't have the bug.
 * Both adapters (Claude + OpenCode) share this single render path.
 */

/** HTML-escape the three characters Telegram's HTML parse_mode treats as
 *  special. Nothing else needs escaping in HTML text nodes / code spans. */
export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Matchers for the adapter's "markdown-ish" intermediate. Hoisted so they
// aren't recompiled per chunk; `g`-flag regexes are stateful, so every use
// goes through `String.replace` (which resets `lastIndex`), never `.exec`.
const FENCE_REGEX = /```([^\n`]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_REGEX = /`([^`\n]+)`/g;
// `**bold**` must run BEFORE the single-star `*bold*` matcher: otherwise the
// single-star regex matches from the 2nd asterisk of `**` and leaves a stray
// leading `*` (live OpenCode trace: `*<b>bold</b>*`). Non-greedy so adjacent
// pairs `**a** **b**` don't merge into one span.
const DOUBLE_BOLD_REGEX = /\*\*([^\n]+?)\*\*/g;
const BOLD_REGEX = /\*([^*\n]+)\*/g;
const LINK_REGEX = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
// Markdown ATX headings (`#`…`######` + text). Telegram has no heading
// element, so render the line as bold — the established convention. Anchored
// to line start with the `m` flag, so a `#` mid-line stays literal.
const HEADING_REGEX = /^#{1,6}\s+(.+)$/gm;
const PLACEHOLDER_REGEX = /\x00(\d+)\x00/g;
/**
 * C0 control chars except `\n` and `\t`. They never belong in a Telegram
 * message, and a stray `\x00` would collide with the placeholder sentinel
 * `\x00N\x00` and resurrect a wrong / `undefined` span — strip up front.
 */
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Code spans are protected first (stashed as placeholders) so prose-level
 * bold/link substitution can't reach inside them, then everything is
 * HTML-escaped, then bold/links are applied to the already-escaped prose (so
 * the tags we insert are not themselves escaped, and a lone `*`/backtick in
 * prose stays literal instead of breaking the parse).
 */
export function renderAgentHtml(text: string): string {
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    placeholders.push(html);
    return `\x00${placeholders.length - 1}\x00`;
  };

  // 0. Drop control chars up front so the placeholder sentinel we add in
  //    `stash` is the only `\x00` left to restore in step 5.
  const source = text.replace(CONTROL_CHARS_REGEX, '');

  // 1. Fenced blocks first — they contain the backticks inline code would
  //    otherwise mis-match. Escape only `& < >` inside code.
  let work = source.replace(FENCE_REGEX, (_match, info: string, body: string) => {
    // The info string's first token is the language (CommonMark); ignore any
    // trailing metadata. Escape `"` too, or it would break the class attribute.
    const language = info.trim().split(/\s+/)[0] ?? '';
    const cls = language
      ? ` class="language-${escapeHtmlText(language).replace(/"/g, '&quot;')}"`
      : '';
    return stash(`<pre><code${cls}>${escapeHtmlText(body.replace(/\n$/, ''))}</code></pre>`);
  });

  // 2. Inline code.
  work = work.replace(INLINE_CODE_REGEX, (_match, body: string) =>
    stash(`<code>${escapeHtmlText(body)}</code>`),
  );

  // 3. Escape the remaining prose.
  work = escapeHtmlText(work);

  // 4. Bold + links + headings on the escaped prose. Label/URL are already
  //    escaped by step 3, so we only additionally guard `"` in the href
  //    attribute. `**bold**` runs before `*bold*` (see DOUBLE_BOLD_REGEX).
  work = work.replace(DOUBLE_BOLD_REGEX, '<b>$1</b>');
  work = work.replace(BOLD_REGEX, '<b>$1</b>');
  work = work.replace(LINK_REGEX, (_match, label: string, url: string) =>
    `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
  );
  // Headings after bold/links: a heading line may already carry `<b>` from the
  // bold pass; Telegram accepts nested `<b>`, so no special-casing needed.
  work = work.replace(HEADING_REGEX, '<b>$1</b>');

  // 5. Restore the stashed code spans (already valid HTML — do not re-escape).
  return work.replace(PLACEHOLDER_REGEX, (match, idx: string) => placeholders[Number(idx)] ?? match);
}
