import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './state';

/**
 * @description Bounded, rotating diagnostic log for agent-backend lifecycle
 * milestones (SSE connect / stall / reconnect, prompt send / accept / fail,
 * response complete).
 *
 * The bot otherwise logs only to its controlling terminal, so a stall that
 * happens while nobody is watching is undiagnosable after the fact. This
 * writes ONE line per milestone to a size-capped file under `DATA_DIR`
 * (per-instance, so pet/work bots stay separate). It deliberately does NOT
 * receive the per-delta output firehose — the full console stream would
 * reach gigabytes in days.
 *
 * Size bound: once the file passes `maxLogBytes` it rolls to a single `.1`
 * backup (overwriting the previous backup), so total on-disk size never
 * exceeds roughly `2 × maxLogBytes`.
 */
const maxLogBytes = 512 * 1024;

const logFilePath = path.join(resolveDataDir(), 'agent-diag.log');

/** Ensure the log directory exists exactly once per process (cheap guard so we
 * don't issue an mkdir syscall on every append). Without this, a milestone that
 * fires before `DATA_DIR` is created throws and the breadcrumb is lost in the
 * `catch` — exactly when a fresh/misconfigured instance needs it most. */
let isLogDirEnsured = false;

function rotateIfOversized(): void {
  if (!existsSync(logFilePath)) return;
  if (statSync(logFilePath).size <= maxLogBytes) return;
  renameSync(logFilePath, `${logFilePath}.1`);
}

/**
 * @description Append one diagnostic line. Never throws — logging must not be
 * able to take the bot down, so every IO error is swallowed.
 */
export function appendDiagLog(message: string): void {
  try {
    if (!isLogDirEnsured) {
      mkdirSync(path.dirname(logFilePath), { recursive: true, mode: 0o700 });
      isLogDirEnsured = true;
    }
    rotateIfOversized();
    // Owner-only file (mode applies at creation) — diag lines may quote agent errors.
    appendFileSync(logFilePath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // Diagnostics are best-effort; a logging failure must never break the bot.
  }
}
