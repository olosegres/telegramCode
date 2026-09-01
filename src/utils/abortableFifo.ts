import { getAbortError } from '../utils';

interface AbortableFifoWaiter {
  resolve: () => void;
  signal?: AbortSignal;
  handleAbort?: () => void;
}

/** FIFO waiter queue that removes canceled callers without consuming a permit. */
export class AbortableFifo {
  private waiters: AbortableFifoWaiter[] = [];

  get size(): number {
    return this.waiters.length;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(getAbortError(signal));
    return new Promise((resolve, reject) => {
      const waiter: AbortableFifoWaiter = {
        resolve,
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        const handleAbort = () => {
          const waiterIndex = this.waiters.indexOf(waiter);
          if (waiterIndex < 0) return;
          this.waiters.splice(waiterIndex, 1);
          reject(getAbortError(signal));
        };
        waiter.handleAbort = handleAbort;
        signal.addEventListener('abort', handleAbort, { once: true });
      }
      this.waiters.push(waiter);
      if (signal?.aborted) waiter.handleAbort?.();
    });
  }

  resolveNext(): boolean {
    const waiter = this.waiters.shift();
    if (!waiter) return false;
    this.removeAbortListener(waiter);
    waiter.resolve();
    return true;
  }

  resolveAll(): void {
    while (this.resolveNext()) {
      // Resolve synchronously in FIFO order before promise callbacks run.
    }
  }

  private removeAbortListener(waiter: AbortableFifoWaiter): void {
    if (waiter.signal && waiter.handleAbort) {
      waiter.signal.removeEventListener('abort', waiter.handleAbort);
    }
  }
}
