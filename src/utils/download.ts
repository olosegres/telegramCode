/**
 * @description Resilient file download for Telegram media (voice notes, etc.).
 *
 * Extracted from `bot.ts` so it is side-effect-free and unit-testable against a
 * local HTTP server (importing `bot.ts` would construct a Telegraf instance and
 * read ENV at module load).
 *
 * Why this exists as its own module with retries:
 *
 * Telegram **API calls** (getUpdates, getFileLink, sendMessage) ride a tuned,
 * keep-alive, IPv4-pinned `https.Agent` shared by Telegraf — so they reuse a
 * warm socket. File **downloads** previously used the global agent: a fresh
 * cold TCP+TLS handshake to `api.telegram.org` on every voice note. On a
 * throttled / high-latency link that handshake intermittently stalls and trips
 * the 20s timeout — surfacing to the user as "Download timed out", forcing a
 * manual re-send. We fix that two ways:
 *
 *   1. Reuse the caller's warm agent (passed via `opts.agent`) so downloads
 *      ride the same pooled IPv4 connection as the API calls.
 *   2. Retry transient failures (timeout / connection reset / 5xx / 429)
 *      automatically with exponential backoff, so a single stall recovers on
 *      its own instead of bubbling up to the user.
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import { promises as fsp } from 'fs';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2; // → up to 3 attempts total
const MAX_REDIRECTS = 5;

/** Backoff before retry attempt N (1-based): 500ms, 1500ms, 3500ms, … (capped). */
function backoffMs(attempt: number): number {
  return Math.min(500 * (2 ** attempt - 1), 8_000);
}

export interface DownloadOptions {
  /** Reuse a warm keep-alive agent (HTTPS only). Cuts the cold-handshake stall. */
  agent?: https.Agent;
  /** Per-attempt socket timeout. */
  timeoutMs?: number;
  /** Number of RETRIES after the first attempt (so attempts = retries + 1). */
  retries?: number;
  /** Observability hook fired before each retry (1-based attempt that just failed). */
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
}

/**
 * @description A download failure that knows whether retrying could help.
 * Network stalls (timeout, ECONNRESET, …), HTTP 429 and 5xx are retryable;
 * HTTP 4xx and "too many redirects" are not (resending the same request will
 * keep failing).
 */
export class DownloadError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;
  constructor(message: string, opts: { retryable: boolean; statusCode?: number; cause?: unknown } ) {
    super(message);
    this.name = 'DownloadError';
    this.retryable = opts.retryable;
    this.statusCode = opts.statusCode;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** Node socket/DNS error codes that are worth a retry. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ECONNABORTED',
]);

/**
 * @description Classify an arbitrary thrown value into retryable / not.
 * `DownloadError` carries its own verdict; raw socket errors are matched by
 * `code`; an unknown error is treated as NON-retryable (fail fast rather than
 * loop on a bug).
 */
export function checkIsRetryableDownloadError(err: unknown): boolean {
  if (err instanceof DownloadError) return err.retryable;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  // Telegraf/undici sometimes surface socket resets as a bare "socket hang up".
  const msg = err instanceof Error ? err.message : '';
  return /socket hang up|timed out|timeout/i.test(msg);
}

/**
 * @description One download attempt. Follows up to {@link MAX_REDIRECTS} 3xx
 * hops, rejects non-2xx with a status-tagged {@link DownloadError}, and tears
 * down the partial file on any failure. Reuses `opts.agent` for HTTPS so the
 * request rides the warm pooled connection instead of a cold handshake.
 */
export function downloadFileOnce(url: string, destPath: string, opts: DownloadOptions = {}, depth = 0): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (depth > MAX_REDIRECTS) {
    return Promise.reject(new DownloadError(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`, { retryable: false }));
  }

  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const client = isHttps ? https : http;
    const file = fs.createWriteStream(destPath);
    const cleanup = () => fsp.unlink(destPath).catch(() => {});

    // Only an https.Agent makes sense for https requests; never hand it to the
    // plain-http client (Telegram file URLs are https, but stay defensive).
    const reqOptions = isHttps && opts.agent ? { agent: opts.agent } : {};

    const req = client.get(url, reqOptions, (response) => {
      const status = response.statusCode ?? 0;

      // Follow redirects (301/302/303/307/308). Drain the response so the
      // socket can be returned to the keep-alive pool instead of being torn
      // down — important when reusing a shared agent.
      if ([301, 302, 303, 307, 308].includes(status)) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          response.resume();
          file.close(() => {
            cleanup().then(() =>
              downloadFileOnce(redirectUrl, destPath, opts, depth + 1).then(resolve, reject),
            );
          });
          return;
        }
      }

      // Anything outside 2xx is a failure. Without this the error body (HTML /
      // JSON) was piped into the file, yielding broken "audio" that Whisper
      // later rejected with an opaque 400. 4xx is permanent; 429/5xx may pass
      // on a retry.
      if (status < 200 || status >= 300) {
        response.resume();
        const retryable = status === 429 || status >= 500;
        file.close(() => {
          cleanup().then(() =>
            reject(new DownloadError(
              `Download failed: HTTP ${status} ${response.statusMessage ?? ''}`.trim(),
              { retryable, statusCode: status },
            )),
          );
        });
        return;
      }

      response.pipe(file);
      file.on('finish', () => { file.close(() => resolve()); });
      file.on('error', (err) => {
        // A local write error (disk full, etc.) is not worth retrying.
        cleanup().then(() => reject(new DownloadError(`Write failed: ${err.message}`, { retryable: false, cause: err })));
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new DownloadError(`Download timed out after ${timeoutMs}ms`, { retryable: true }));
    });

    req.on('error', (err) => {
      cleanup().then(() => {
        // `req.destroy(downloadError)` re-emits our own error here — pass it
        // through unchanged so its `retryable` verdict survives.
        if (err instanceof DownloadError) { reject(err); return; }
        reject(new DownloadError(
          err.message,
          { retryable: checkIsRetryableDownloadError(err), cause: err },
        ));
      });
    });
  });
}

/**
 * @description Download with automatic retries on transient failures. Resolves
 * once the file is written; rejects with the LAST error after exhausting
 * retries (or immediately on a non-retryable error). This is the function
 * callers should use — a stalled connection now recovers on its own instead of
 * forcing the user to re-send the media.
 */
export async function downloadFile(url: string, destPath: string, opts: DownloadOptions = {}): Promise<void> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  let lastErr: Error = new DownloadError('download not attempted', { retryable: false });

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await downloadFileOnce(url, destPath, opts);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const canRetry = attempt < retries && checkIsRetryableDownloadError(err);
      if (!canRetry) throw lastErr;
      const delay = backoffMs(attempt + 1);
      opts.onRetry?.(attempt + 1, lastErr, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
