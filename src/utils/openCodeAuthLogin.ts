/**
 * @description Pure helpers behind the OpenCode `/connect` OAuth (subscription)
 * flow. The bot's `/connect` used to do API-key auth only (`PUT /auth/{id}` with
 * `{type:'api',key}`); this layer adds provider OAuth by driving
 * `opencode auth login -p <id> -m <label>` in a pty out-of-band — the same
 * pattern as the json-stream Claude `/login` flow (`utils/claudeAuthLogin.ts`).
 * These are the parse/decision helpers; the impure pty driving + per-thread
 * state live in `bot.ts`.
 *
 * Two OAuth shapes are handled, auto-detected from the pty output:
 *  - DEVICE flow (openai "ChatGPT Pro/Plus (headless)", github-copilot, …): the
 *    CLI prints a sign-in URL + a short code to ENTER at that URL, then polls
 *    ("Waiting for authorization…") and exits 0 once the user authorises in a
 *    browser. Nothing is pasted back — the bot relays URL+code and waits for exit.
 *  - PASTE flow: the CLI prints a URL then waits for the user to paste an
 *    authorization code back — the bot arms a pending-code state (next plain text
 *    is written into the pty, then deleted as a secret).
 *
 * Success is authoritative from the on-disk `auth.json` (the provider's entry
 * flips to `type:"oauth"`), with the process exit code as the fallback.
 */

import * as path from 'path';

/** One auth method offered by a provider in the `/provider/auth` catalog. */
export interface OpenCodeAuthMethod {
  /** `oauth` | `api` | (future) — verbatim from the catalog. */
  type: string;
  /** Human label, passed verbatim to `opencode auth login -m <label>`. */
  label: string;
  /** Whether the method carries extra `prompts` (multi-step, e.g. an instance URL). */
  hasPrompts: boolean;
}

/**
 * @description Strip ANSI/OSC escape sequences and carriage returns so the
 * text-shape detectors below match against clean content. Deliberately minimal
 * (detection-only) — the topic-facing relay reuses the fuller `cleanOutput`.
 */
export function stripAnsiForDetection(raw: string): string {
  return raw
    // CSI sequences: ESC [ … final-byte
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC sequences: ESC ] … (BEL | ESC \)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // stray single-char escapes
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

/**
 * @description Parse a provider's auth methods out of the `GET /provider/auth`
 * catalog (`{ providerId: [{type,label,prompts?}, …] }`). Returns `[]` for an
 * unknown provider or a malformed catalog. Order is preserved (the picker shows
 * methods in catalog order).
 */
export function parseProviderAuthMethods(raw: unknown, providerId: string): OpenCodeAuthMethod[] {
  if (!raw || typeof raw !== 'object') return [];
  const methods = (raw as Record<string, unknown>)[providerId];
  if (!Array.isArray(methods)) return [];
  const out: OpenCodeAuthMethod[] = [];
  for (const m of methods) {
    if (!m || typeof m !== 'object') continue;
    const { type, label, prompts } = m as { type?: unknown; label?: unknown; prompts?: unknown };
    if (typeof type !== 'string' || typeof label !== 'string') continue;
    out.push({ type, label, hasPrompts: Array.isArray(prompts) && prompts.length > 0 });
  }
  return out;
}

/** An OAuth (subscription/account) method. */
export function checkIsOAuthMethod(method: OpenCodeAuthMethod): boolean {
  return method.type === 'oauth';
}

/** A single-field API-key method (no extra prompts) — the legacy `/connect` path. */
export function checkIsSimpleApiMethod(method: OpenCodeAuthMethod): boolean {
  return method.type === 'api' && !method.hasPrompts;
}

/** argv for `opencode auth login`, skipping the interactive provider+method pickers. */
export function buildOpenCodeAuthLoginArgs(providerId: string, methodLabel: string): string[] {
  return ['auth', 'login', '-p', providerId, '-m', methodLabel];
}

/** First `http(s)` URL in the (ANSI-stripped) pty output — the sign-in link. */
const oauthUrlRe = /https?:\/\/[^\s\u0000-\u001f]+/;
export function parseOpenCodeOAuthUrl(ptyOutput: string): string | null {
  const match = stripAnsiForDetection(ptyOutput).match(oauthUrlRe);
  return match ? match[0] : null;
}

/**
 * @description The short device code the user types AT the sign-in URL
 * ("Enter code: 95J2-4U74J"). Returns the code, or `null` for a non-device
 * (paste-style) flow that shows no such line.
 */
const deviceCodeRe = /Enter code:\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/;
export function parseOpenCodeDeviceCode(ptyOutput: string): string | null {
  const match = stripAnsiForDetection(ptyOutput).match(deviceCodeRe);
  return match ? match[1] : null;
}

/** The device flow has printed everything and is polling for authorisation. */
export function checkIsAwaitingAuthorization(ptyOutput: string): boolean {
  return /Waiting for authorization/i.test(stripAnsiForDetection(ptyOutput));
}

/**
 * @description A paste-style flow is asking for the authorization code back
 * (the bot then treats the next plain text as that code). Kept a closed set of
 * phrasings so an unrelated line never false-arms the code-paste state.
 */
const pastePromptRe = /paste (?:the )?code|enter the (?:authorization|auth) code|authorization code:/i;
export function checkIsOpenCodeOAuthPastePrompt(ptyOutput: string): boolean {
  return pastePromptRe.test(stripAnsiForDetection(ptyOutput));
}

/**
 * @description Whether the accumulated pty output has reached the point where the
 * sign-in info is fully rendered and ready to relay: a URL is present AND the
 * flow has reached a stable stage (a device code, the "waiting" poll, or a paste
 * prompt). Gating on this avoids relaying a URL that is still rendering.
 */
export function checkIsOAuthInfoReady(ptyOutput: string): boolean {
  if (!parseOpenCodeOAuthUrl(ptyOutput)) return false;
  return (
    parseOpenCodeDeviceCode(ptyOutput) !== null ||
    checkIsAwaitingAuthorization(ptyOutput) ||
    checkIsOpenCodeOAuthPastePrompt(ptyOutput)
  );
}

/**
 * @description Resolve the OpenCode credentials file path, honouring
 * `XDG_DATA_HOME` (falls back to `~/.local/share`). This is where a completed
 * `opencode auth login` writes the provider's credential entry.
 */
export function getOpenCodeAuthFilePath(env: {
  XDG_DATA_HOME?: string;
  HOME?: string;
}): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(env.HOME || '', '.local', 'share');
  return path.join(dataHome, 'opencode', 'auth.json');
}

/**
 * @description Whether the provider is authed in the parsed `auth.json` map. When
 * `wantType` is given (e.g. `'oauth'`), the entry's `type` must match — this is
 * what distinguishes a fresh OAuth success from a stale `api` entry left by an
 * earlier key-based `/connect`. Returns `null` when the map is unreadable so the
 * caller can fall back to the process exit code.
 */
export function checkProviderAuthed(
  authJson: unknown,
  providerId: string,
  wantType?: string,
): boolean | null {
  if (authJson === null || authJson === undefined) return null;
  if (typeof authJson !== 'object') return false;
  const entry = (authJson as Record<string, unknown>)[providerId];
  if (!entry || typeof entry !== 'object') return false;
  const type = (entry as { type?: unknown }).type;
  if (typeof type !== 'string') return false;
  return wantType ? type === wantType : true;
}

/**
 * @description Final success decision for the OAuth flow. `auth.json` is
 * authoritative (it reflects the real on-disk credential the CLI just wrote); the
 * process exit code is only the fallback when the file could not be read
 * (`authed === null`).
 */
export function checkIsOpenCodeOAuthSucceeded(input: {
  exitCode: number | null;
  authed: boolean | null;
}): boolean {
  if (input.authed !== null) return input.authed;
  return input.exitCode === 0;
}

/**
 * @description Short button label for a method in the `/connect` picker: a lock
 * for OAuth, a key for API. The catalog label is used verbatim but capped so a
 * long label never blows the inline-button width.
 */
export function buildConnectMethodButtonLabel(method: OpenCodeAuthMethod): string {
  const emoji = checkIsOAuthMethod(method) ? '🔓' : '🔑';
  const label = method.label.length > 40 ? `${method.label.slice(0, 39)}…` : method.label;
  return `${emoji} ${label}`;
}
