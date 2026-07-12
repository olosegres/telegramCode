/**
 * @description Pure helpers behind the json-stream `/login` out-of-band auth
 * flow. The json-stream Claude backend has no TUI to host Claude's interactive
 * `/login`, so the bot drives `claude auth login --claudeai` in a pty and relays
 * it through the topic (URL out -> pasted code in). These are the parse/decision
 * helpers; the impure pty driving + per-thread state live in `bot.ts` (mirrors
 * the `apiErrorRetry.ts` pure-layer / bot.ts-manager split).
 *
 * The success signal is authoritative from `claude auth status --json`
 * (`{"loggedIn": true, ...}`), with the process exit code as the fallback.
 */

/**
 * @description The load-bearing marker line of Claude's `/login` OAuth
 * "paste the code" step (`Paste code here if prompted > `). Shared with the
 * tmux-scrape backend's login-paste detection so the marker string has a single
 * definition.
 */
export const claudeLoginPastePromptRe = /Paste code here if prompted/;

/** Matches the first http(s) URL, stopping at whitespace or any C0 control char. */
const oauthLoginUrlRe = /https?:\/\/[^\s\u0000-\u001f]+/;

/**
 * @description First `http(s)` URL in `claude auth login`'s pty output — the
 * OAuth sign-in link. The CLI prints it inside an OSC-8 hyperlink
 * (`ESC]8;;<url>BEL`) and again as visible blue text; the match stops at the
 * first whitespace / C0 control char (the BEL that terminates the OSC-8 target),
 * so the captured URL is already clean of ANSI. Returns `null` if none yet.
 */
export function parseClaudeAuthLoginUrl(ptyOutput: string): string | null {
  const match = ptyOutput.match(oauthLoginUrlRe);
  return match ? match[0] : null;
}

/**
 * @description Whether the accumulated pty output has reached the "paste the
 * code" prompt — i.e. the CLI has printed the sign-in URL and is now waiting for
 * the code. Used to gate the URL relay so a URL split across pty chunks is never
 * relayed half-rendered.
 */
export function checkIsClaudeAuthLoginCodePrompt(ptyOutput: string): boolean {
  return claudeLoginPastePromptRe.test(ptyOutput);
}

/**
 * @description Read `loggedIn` out of `claude auth status --json`. Returns the
 * boolean, or `null` when the JSON is missing/malformed or lacks the field.
 */
export function parseAuthStatusLoggedIn(statusJson: string): boolean | null {
  try {
    const parsed = JSON.parse(statusJson) as { loggedIn?: unknown };
    return typeof parsed.loggedIn === 'boolean' ? parsed.loggedIn : null;
  } catch {
    return null;
  }
}

/**
 * @description Decide whether the login succeeded. `claude auth status` is
 * authoritative (it reflects the real on-disk credentials after the flow); the
 * process exit code is only the fallback when the status probe could not be read
 * (`loggedIn === null`).
 */
export function checkIsAuthLoginSucceeded(input: {
  exitCode: number | null;
  loggedIn: boolean | null;
}): boolean {
  if (input.loggedIn !== null) return input.loggedIn;
  return input.exitCode === 0;
}

/** How a `/login` slash command is handled for a thread. */
export type LoginCommandRoute = 'outOfBand' | 'forwardToAgent';

/**
 * @description Route a `/login` command by the thread's Claude backend. Only the
 * json-stream backend (which has no TUI to host the OAuth flow) intercepts it
 * into the bot-driven out-of-band flow; every other case — tmux-scrape Claude
 * (its TUI hosts `/login` itself), OpenCode/terminal, or a no-pick thread — keeps
 * the existing verbatim forward.
 *
 * The backend is read from the thread's RAW adapter pick, NOT a "resolve to the
 * Claude default" call: an OpenCode/terminal thread has a non-Claude raw pick, so
 * gating on the raw name avoids wrongly intercepting `/login` on those threads
 * (which a default-resolving check would do once json-stream is the default).
 * `jsonStreamBackendName` is injected to keep this helper free of an adapter
 * import.
 */
export function getLoginCommandRoute(input: {
  command: string;
  rawBackendName: string | undefined;
  jsonStreamBackendName: string;
}): LoginCommandRoute {
  return input.command === 'login' && input.rawBackendName === input.jsonStreamBackendName
    ? 'outOfBand'
    : 'forwardToAgent';
}
