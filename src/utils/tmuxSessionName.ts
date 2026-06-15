import type { ThreadKey } from '../types';

/**
 * @description Tmux session name for a `ThreadKey`, namespaced by a backend
 * `prefix` so different adapters (Claude `claude-…`, terminal `term-…`) never
 * collide on one tmux server.
 *
 * Format: `<prefix>-<chatId>-<threadId>`. Negative chat ids (forum supergroups
 * are negative) keep their minus sign — tmux session names accept it. The
 * format is `parse`-able back to `ThreadKey` via {@link parseTmuxSessionName}
 * with the SAME prefix.
 */
export function buildTmuxSessionName(prefix: string, key: ThreadKey): string {
  return `${prefix}-${key.chatId}-${key.threadId}`;
}

/**
 * @description Inverse of {@link buildTmuxSessionName} for a given `prefix`.
 * Returns `null` for names that don't match the `<prefix>-<chatId>-<threadId>`
 * format (e.g. an unrelated tmux session a user started by hand, or one owned
 * by a different backend's prefix).
 *
 * Carefully handles negative chat ids: `claude--1001234-42` parses to
 * `chatId=-1001234, threadId=42`. We split from the right on the last `-` so
 * the trailing token is always `threadId` regardless of `chatId`'s sign.
 *
 * Strict regex on each half (audit S1 / #22): plain `Number(...)` accepts
 * `1e5`, `0x10`, `1.5`, `" 42 "`. Such values come from a foreign tmux session
 * whose name happens to share our prefix; treating them as ours would cause an
 * adopt path to attach to an unrelated session.
 */
export function parseTmuxSessionName(prefix: string, name: string): ThreadKey | null {
  const head = `${prefix}-`;
  if (!name.startsWith(head)) return null;
  const rest = name.slice(head.length);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash <= 0) return null;
  const chatIdStr = rest.slice(0, lastDash);
  const threadIdStr = rest.slice(lastDash + 1);
  if (!/^-?\d+$/.test(chatIdStr)) return null;
  if (!/^\d+$/.test(threadIdStr)) return null;
  const chatId = Number(chatIdStr);
  const threadId = Number(threadIdStr);
  if (!Number.isFinite(chatId) || !Number.isFinite(threadId)) return null;
  return { chatId, threadId };
}
