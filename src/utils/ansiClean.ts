/**
 * @description Convert ANSI escape codes to Telegram Markdown.
 * Uses a marker-based approach: bold-on → \x01, bold-off → \x02,
 * then strips all remaining ANSI, then converts markers to *bold*.
 * Previous regex approach had two bugs:
 * 1) Bold regex consumed \x1B[ of the following sequence, leaking codes like 38;5;231m
 * 2) Cleanup regex \*\s*\* merged adjacent bold sections, removing newlines between them
 */
export function convertAnsiToMarkdown(text: string): string {
  let result = text;

  // Step 0: Strip OSC 8 hyperlink escapes. Plan §2026-05-28
  // tg-output-readability / S2 (C2).
  //
  // The full sequence is one of:
  //   ESC ] 8 ; <params> ; <url> BEL    <visible text>  ESC ] 8 ; ; BEL
  //   ESC ] 8 ; <params> ; <url> ESC\   <visible text>  ESC ] 8 ; ; ESC\
  //
  // ECMA-48 / xterm spec allows either BEL (0x07) or the C1 string
  // terminator `ESC \` (0x1B 0x5C, "ST") as the OSC closer. Live
  // capture from tmux pane shows Claude uses ST, not BEL (see
  // `od -c` of `tmux capture-pane -e -p` during the live V3
  // re-verification on 2026-05-28). The two terminators are
  // interchangeable in the spec; we support both.
  //
  // The downstream control-char filter in `cleanOutput` removes the
  // bare ESC (0x1B) and BEL (0x07) bytes — but the *payload*
  // (`]8;...;file://...`, then duplicated visible text, then `]8;;`)
  // is plain ASCII and falls through, producing live artefacts like
  // `Update(8;id=...;file:///...IDEAS.mdIDEAS.md8;;)` in Telegram.
  // We strip the whole sequence here, while ESC/BEL are still present
  // to anchor the regex, and keep only the visible text in $1.
  //
  // `\\` inside the character class matches a literal backslash, so
  // `(?:\x07|\x1B\\\\)` is "BEL  or  ESC followed by `\`".
  //
  // Visible text is captured NON-greedily (`[\s\S]*?`) rather than
  // `[^\x1B\x07]*`: Claude emits an ANSI colour reset BETWEEN the visible
  // text and the closing `ESC]8;;` (live capture of the data-usage survey
  // prompt: `…<url>ESC\<url>ESC[39mESC]8;;ESC\`). The old class stopped at
  // that ESC and then failed to find `ESC]8;;`, so the whole sequence leaked
  // as `8;id=…;<url><url>8;;`. Non-greedy still stops at the FIRST `ESC]8;;`
  // (correct for multiple links on a line, and no closer → no match), and any
  // ANSI codes that ride along in $1 are stripped by Step 2 below.
  result = result.replace(
    // eslint-disable-next-line no-control-regex
    /\x1B\]8;[^;\x07\x1B]*;[^\x07\x1B]*(?:\x07|\x1B\\)([\s\S]*?)\x1B\]8;;(?:\x07|\x1B\\)/g,
    '$1',
  );

  // Step 1: Mark bold boundaries with control characters
  // Bold on: \x1B[1m → \x01 marker
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B\[1m/g, '\x01');

  // Bold off / reset: \x1B[0m or \x1B[22m → \x02 marker
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B\[(?:0|22)m/g, '\x02');

  // Step 2: Remove ALL remaining ANSI escape codes (colors, cursor, etc.)
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');

  // Step 3: Convert bold markers to Markdown *bold*
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x01([^\x01\x02]*)\x02/g, (_match, content) => {
    const trimmed = content.trim();
    return trimmed ? `*${trimmed}*` : content;
  });

  // Handle unclosed bold (bold start without matching end, e.g. at end of line)
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x01([^\x01\x02]+)$/gm, '*$1*');

  // Step 4: Clean up remaining markers
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[\x01\x02]/g, '');

  // Separate adjacent bold sections: *text1**text2* → *text1* *text2*
  result = result.replace(/\*\*/g, '* *');

  // Drop bold wrappers around a single Claude TUI spinner glyph. Plan
  // §2026-05-28 tg-output-readability / S5 (N3): claude's TUI toggles
  // ANSI bold on the spinner cell every redraw, which our bold→`*X*`
  // conversion above then turns into `*·* Brewing…` / `*✻* Smooshing…`.
  // The glyph itself carries the spinner semantics — the asterisks add
  // nothing and make the rolling status message look broken. Narrow
  // match (listed glyphs only) so a real `*x*` highlight from prose
  // survives.
  result = result.replace(/\*([✻✽✶✢·*●○])\*/g, '$1');

  return result;
}

/**
 * Join URLs that were broken by terminal line wrapping.
 * Terminal breaks long URLs into multiple lines, which breaks them in Telegram.
 */
function joinBrokenUrls(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const urlMatch = line.match(/(https?:\/\/\S*)$/);

    if (urlMatch) {
      let fullUrl = urlMatch[1];
      const prefix = line.slice(0, line.length - fullUrl.length);

      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j].trim();
        if (nextLine && !nextLine.includes(' ') && /^[\w\-._~:/?#\[\]@!$&'()*+,;=%]+$/.test(nextLine)) {
          fullUrl += nextLine;
          j++;
        } else {
          break;
        }
      }

      result.push(prefix + fullUrl);
      i = j;
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

export function cleanOutput(text: string): string {
  let cleaned = convertAnsiToMarkdown(text);
  cleaned = cleaned.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '');
  cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  cleaned = joinBrokenUrls(cleaned);
  // Trim trailing whitespace on every line WITHOUT dropping the line
  // itself. Plan §2026-05-28 tg-output-readability / S1 (C1):
  // `tmux capture-pane -e` pads every pane line with trailing spaces to
  // terminal width, so a "blank" paragraph separator arrives as e.g.
  // "                                                                    "
  // (not ""). The previous filter dropped any whitespace-only line,
  // gluing two paragraphs together in Telegram. Per-line trim preserves
  // the line, leaves a bare empty string in its place, and lets the
  // `\n{3,}→\n\n` collapse below normalise sequences of newlines.
  cleaned = cleaned.replace(/[ \t]+$/gm, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}
