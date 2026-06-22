import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * @description Shared retention window for the time-bucketed log files (the
 * output trace and the bot-console tee). Both prune buckets older than this.
 */
export const retentionHours = 6;

const millisecondsPerHour = 60 * 60 * 1000;

/** Retention window in milliseconds, derived from {@link retentionHours}. */
export const retentionMs = retentionHours * millisecondsPerHour;

function padTwo(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * @description Path of the hourly bucket file a write at `nowMs` belongs to:
 * `<dir>/<base>-YYYYMMDDHH.<ext>`, using the HOST-LOCAL clock (so the operator
 * reading the file sees buckets aligned to their own wall time). Pure — does no
 * IO, just composes the name.
 */
export function getHourBucketPath(dir: string, base: string, ext: string, nowMs: number): string {
  const now = new Date(nowMs);
  const stamp =
    `${now.getFullYear()}` +
    padTwo(now.getMonth() + 1) +
    padTwo(now.getDate()) +
    padTwo(now.getHours());
  return path.join(dir, `${base}-${stamp}.${ext}`);
}

/** Match `<base>-<10 digits>.<ext>` and its `.1` rollover sibling. */
function buildBucketMatcher(base: string, ext: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(base)}-\\d{10}\\.${escape(ext)}(?:\\.1)?$`);
}

/**
 * @description Delete every bucket file for `<base>.<ext>` (including its `.1`
 * rollover) whose mtime is older than the retention window. Time-bucketing means
 * we only ever unlink WHOLE buckets the writer is no longer appending to — no
 * race with the live writer (it only ever touches the current bucket). Pruning
 * is best-effort: a missing dir, an unreadable entry, or a failed `unlink` is
 * swallowed per-file so one bad entry can never abort the sweep or throw into
 * the boot/interval path.
 */
export async function pruneExpiredBuckets(
  dir: string,
  base: string,
  ext: string,
  retentionWindowMs: number,
  nowMs: number,
): Promise<void> {
  const matcher = buildBucketMatcher(base, ext);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  const cutoffMs = nowMs - retentionWindowMs;
  for (const name of entries) {
    if (!matcher.test(name)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = await fsp.stat(filePath);
      if (stat.mtimeMs < cutoffMs) await fsp.unlink(filePath);
    } catch {
      // Best-effort: ignore a vanished/locked file, keep sweeping the rest.
    }
  }
}
