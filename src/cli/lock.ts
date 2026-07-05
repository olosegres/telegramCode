import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { DEFAULT_WATCHDOG_MS } from '../shutdown';

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
 * @description Default same-token handoff wait: the predecessor's graceful
 * shutdown is bounded by its watchdog ({@link DEFAULT_WATCHDOG_MS} — which now
 * covers the bounded output flush), so the incoming process must out-wait that
 * WHOLE window plus margin. Undersizing this re-creates the live 2026-07-05
 * outage: nodemon spawns the replacement while the old process is still
 * flushing, the lock wait expires, the replacement exits "already running",
 * and nodemon then idles until the next file change — bot down.
 */
export const lockHandoffMaxWaitMs = DEFAULT_WATCHDOG_MS + 2000;

/**
 * @description Same as {@link tryAcquireLock} but waits up to `maxWaitMs`
 * for a same-token holder to release before giving up.
 *
 * Why same-token-only: a different token means a genuinely different bot
 * instance is running against the same `DATA_DIR` (operator mistake — they
 * forgot to set distinct `DATA_DIR`s). We MUST refuse fast in that case;
 * polite waiting would mask the misconfiguration. A matching token, on the
 * other hand, almost always means "my own predecessor is in the middle of
 * its graceful-shutdown sequence" — typical during a `nodemon`-driven hot
 * reload where the old PID has been signalled but is still flushing. That
 * shutdown is bounded by the predecessor's watchdog, so the default wait
 * ({@link lockHandoffMaxWaitMs}) out-waits it with margin and the new process
 * picks the lock back up without spamming the operator with a "live-holder"
 * abort.
 *
 * The sleep function is injected so unit tests can drive the retry loop
 * deterministically without spending real wall-clock time.
 */
export async function tryAcquireLockWithRetry(opts: {
  maxWaitMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<AcquireResult> {
  const maxWaitMs = opts.maxWaitMs ?? lockHandoffMaxWaitMs;
  const intervalMs = opts.intervalMs ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const ourTokenHash = hashToken(process.env.TELEGRAM_BOT_TOKEN);

  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const r = tryAcquireLock();
    if (r.ok) return r;

    // Foreign holder: refuse fast, no retry. Wrong DATA_DIR config or two
    // different bots competing — surfacing the conflict is correct.
    if (r.reason !== 'live-holder' || r.holder.tokenHash !== ourTokenHash) {
      return r;
    }

    // Same-token live holder. Wait for it to release (nodemon hot reload
    // handoff), then retry. Bounded by `maxWaitMs` so a wedged old process
    // can't keep us spinning forever.
    if (Date.now() >= deadline) return r;
    await sleep(intervalMs);
  }
}

/**
 * @description Acquire the single-instance lock for this `DATA_DIR`, or
 * `process.exit(1)` after printing diagnostics.
 *
 * Thin user-facing wrapper around {@link tryAcquireLockWithRetry} — the
 * retry tolerates a brief overlap between an exiting old bot and the
 * incoming new bot during a `nodemon` hot reload (same token, same
 * `DATA_DIR`). Foreign holders still fail immediately.
 */
export async function acquireLock(): Promise<void> {
  const r = await tryAcquireLockWithRetry();
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
 * @description Register exit / crash handlers that release the lock.
 *
 * Wired once from `runBot()`. Covers:
 *   - normal exit (release on `process.exit`) — fires whenever any code
 *     path calls `process.exit(N)`, including the bot's own ordered
 *     shutdown (`bot.stop → state.flush → releaseLock → exit(0)`). The
 *     redundant release here is a belt-and-suspenders for code paths that
 *     hit `process.exit` without going through the bot shutdown (CLI
 *     misuse, early env-validation failures).
 *   - `uncaughtException` (release on crash).
 *
 * **Signal handlers are intentionally NOT installed here.** That used to
 * be the case, but it caused a race: this module loads first
 * (`cli/bot.ts:54`), so its `SIGINT`/`SIGTERM` handler always fires before
 * the bot's own (`bot.ts: shutdown(...)`); a synchronous `process.exit(0)`
 * inside the lock handler then pre-empts the bot's *async* `state.flush()`
 * and the last <500ms of state never reaches disk. Letting the bot own
 * signal handling (and ending with `releaseLock(); process.exit(0)` itself)
 * makes the sequence deterministic. If a SIGINT/SIGTERM arrives before the
 * bot installs its handler (very narrow window during boot), Node's
 * default action terminates the process and we leak the lock file —
 * harmless, because the next start sees a dead pid and reclaims it via
 * the stale-lock recovery path in {@link tryAcquireLock}.
 *
 * SIGKILL is not catchable, hence the same stale-lock recovery path.
 */
export function installLockCleanupHandlers(): void {
  const cleanup = (): void => releaseLock();
  process.on('exit', cleanup);
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
