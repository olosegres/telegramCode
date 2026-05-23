import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

/**
 * @description Number of acquisition attempts before giving up.
 *
 * One retry is enough to recover from a stale lockfile we cleared in the
 * first iteration. More attempts buy nothing — if two live processes both
 * see EEXIST with a valid live holder, we're in a real conflict and the
 * polite thing is to surface it instead of spinning.
 */
const MAX_ACQUIRE_ATTEMPTS = 2;

/**
 * @description On-disk shape of `${DATA_DIR}/instance.lock`.
 *
 * `tokenHash` is the first 12 hex chars of SHA-256(TELEGRAM_BOT_TOKEN) so the
 * lockfile reveals which bot is holding it, without leaking the token itself.
 * Useful when a user has multiple tokens behind multiple `DATA_DIR`s and
 * confuses them.
 */
interface LockData {
  pid: number;
  cwd: string;
  startedAt: string;
  tokenHash: string;
}

/**
 * @description Resolve the data directory the lockfile lives in.
 *
 * Mirrors `src/state.ts:694` — kept independent (not imported) because lock
 * acquisition runs BEFORE the bot module is loaded, and `state.ts` reads
 * `process.env.DATA_DIR` at module scope which we want to avoid coupling to.
 */
function dataDir(): string {
  return process.env.DATA_DIR || path.join(os.homedir(), '.telegramCode');
}

/** @description Lockfile path: `${DATA_DIR}/instance.lock`. */
export function lockPath(): string {
  return path.join(dataDir(), 'instance.lock');
}

/**
 * @description Is the given pid currently a live process?
 *
 * `process.kill(pid, 0)` is the standard portable liveness probe:
 *   - throws `ESRCH` → no such process (dead)
 *   - throws `EPERM` → process exists but we lack permission to signal it
 *     (still counts as alive for our purposes)
 *   - resolves → alive
 *
 * Notably it does NOT verify that `pid` is *our* old bot vs. an unrelated
 * process that happened to inherit the same pid number. PID reuse is a known
 * edge case (see plan §risks/2); we accept it.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

/**
 * @description Try to read and parse an existing lockfile. Returns `null` for
 * any I/O or JSON error (file gone, truncated, corrupted) so the caller can
 * treat it the same as "stale".
 */
function readLock(lp: string): LockData | null {
  try {
    const raw = fs.readFileSync(lp, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockData>;
    if (typeof parsed.pid !== 'number') return null;
    return parsed as LockData;
  } catch {
    return null;
  }
}

/**
 * @description Hash a bot token for display in the lockfile.
 *
 * 12 hex chars from SHA-256 is enough collision resistance for "is this the
 * same token the running instance is using" but reveals nothing useful to an
 * attacker who reads `~/.telegramCode/instance.lock`.
 */
function hashToken(token: string | undefined): string {
  if (!token) return 'no-token';
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

/**
 * @description Result of a pure `tryAcquireLock` call. Lifted out of
 * {@link acquireLock} so unit tests don't have to spawn a child process to
 * inspect the failure path.
 *
 *   - `ok: true`              — lock was created with our pid in it
 *   - `live-holder`           — another process already owns the lock
 *   - `lost-race`             — both retry attempts hit EEXIST without a
 *                                clearly-live or clearly-dead holder
 *                                (concurrent starter, exotic FS, etc.)
 */
export type AcquireResult =
  | { ok: true }
  | { ok: false; reason: 'live-holder'; holder: LockData; lockPath: string }
  | { ok: false; reason: 'lost-race'; lockPath: string };

/**
 * @description Core acquisition logic — no side effects beyond the
 * filesystem. Returns a structured result for the caller to decide whether
 * to print + exit or to handle programmatically.
 *
 * **Atomicity strategy** — naïve `fs.openSync(lp, 'wx')` followed by
 * `writeSync` is racy: between open and write, a concurrent
 * `tryAcquireLock` could read an empty lockfile, parse-fail, treat it as
 * stale, and `unlinkSync` our just-created file. Both processes then think
 * they own the lock.
 *
 * Instead we write the payload to a per-pid tmp file first, then use
 * `fs.linkSync(tmp, lp)` to publish it atomically: `link` either creates
 * `lp` linked to our already-populated tmp inode (success) or fails
 * EEXIST (someone else got there first). The tmp file is always unlinked
 * afterwards. Readers in the EEXIST branch only ever see a fully-written
 * lockfile.
 *
 * On EEXIST we re-read the existing lockfile:
 *
 *   - holder is alive → return `live-holder` with their details
 *   - holder is dead or lockfile is corrupted → unlink and retry
 *
 * Retry count is capped at `MAX_ACQUIRE_ATTEMPTS` to avoid pathological
 * loops; persistent EEXIST surfaces as `lost-race`.
 */
export function tryAcquireLock(): AcquireResult {
  fs.mkdirSync(dataDir(), { recursive: true });
  const lp = lockPath();
  const payload: LockData = {
    pid: process.pid,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    tokenHash: hashToken(process.env.TELEGRAM_BOT_TOKEN),
  };
  const tmpPath = `${lp}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));

  try {
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
      try {
        fs.linkSync(tmpPath, lp);
        return { ok: true };
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code !== 'EEXIST') throw e;

        const existing = readLock(lp);
        if (!existing || !isAlive(existing.pid)) {
          try {
            fs.unlinkSync(lp);
          } catch {
            // Lost the race against another cleaner; the next iteration's
            // linkSync will see whatever they left.
          }
          continue;
        }

        return {
          ok: false,
          reason: 'live-holder',
          holder: existing,
          lockPath: lp,
        };
      }
    }

    return { ok: false, reason: 'lost-race', lockPath: lp };
  } finally {
    // Always clean up the tmp file — successful link bumps refcount, so the
    // payload survives via `lp`; failed link leaves an orphan we must remove.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort
    }
  }
}

/**
 * @description Acquire the single-instance lock for this `DATA_DIR`, or
 * `process.exit(1)` after printing diagnostics.
 *
 * Thin user-facing wrapper around {@link tryAcquireLock}. Kept separate so
 * the testable core stays pure.
 */
export function acquireLock(): void {
  const r = tryAcquireLock();
  if (r.ok) return;

  if (r.reason === 'live-holder') {
    process.stderr.write(
      `telegramCode is already running:\n` +
        `  pid:        ${r.holder.pid}\n` +
        `  cwd:        ${r.holder.cwd}\n` +
        `  started:    ${r.holder.startedAt}\n` +
        `  token hash: ${r.holder.tokenHash}\n` +
        `  lock file:  ${r.lockPath}\n\n` +
        `Stop the running instance first, or set DATA_DIR to use a separate state dir.\n`,
    );
  } else {
    process.stderr.write(
      `telegramCode could not acquire ${r.lockPath} after retry. ` +
        `Another instance is likely starting concurrently.\n`,
    );
  }
  process.exit(1);
}

/**
 * @description Best-effort lockfile removal.
 *
 * Called from process-exit handlers; we deliberately swallow errors because
 * an exit-time crash here masks the real shutdown cause. The worst case
 * (file left behind after a `kill -9`) is harmless — the next `acquireLock`
 * detects the dead pid and reclaims.
 *
 * Refuses to delete a lockfile that does NOT name us — defensive against
 * `kill -9` parent + child still holding a stale handle.
 */
export function releaseLock(): void {
  const lp = lockPath();
  const existing = readLock(lp);
  if (!existing || existing.pid !== process.pid) return;
  try {
    fs.unlinkSync(lp);
  } catch {
    // best effort
  }
}

/**
 * @description Register exit / signal handlers that release the lock.
 *
 * Wired once from `runBot()`. Handles:
 *   - normal exit (release on `process.exit`)
 *   - SIGINT / SIGTERM / SIGHUP (release then exit 0)
 *   - uncaughtException (release then re-throw so Node's default handler runs)
 *
 * SIGKILL is not catchable, hence the stale-lock recovery path in
 * {@link acquireLock}.
 */
export function installLockCleanupHandlers(): void {
  const cleanup = (): void => releaseLock();
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
  process.on('uncaughtException', (err) => {
    cleanup();
    // Print the original error ourselves and exit with the canonical
    // crash-on-uncaught code. We intentionally do NOT re-throw — re-throwing
    // would fire `uncaughtException` again, re-enter our handler, schedule
    // another re-throw, and loop forever (the process would never exit and
    // the user would never see the original stack).
    console.error(err);
    process.exit(1);
  });
}
