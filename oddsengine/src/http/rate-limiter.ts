/**
 * Sliding-window rate limiter
 * ─────────────────────────────────────────────────────────────────────────────
 * Client-side politeness: keeps the engine under a requests-per-minute budget
 * without depending on the provider telling us off first. It is deliberately a
 * *waiting* limiter (callers await their slot) rather than a rejecting one, so a
 * slow provider makes the engine slower instead of making it drop fixtures.
 *
 * Set the budget from the provider's published limits. It is a safety net, not
 * a licence to poll faster — the poll intervals are the real control.
 */
export type RateLimiter = {
  /** Resolve when a request may be made. Rejects if `signal` aborts first. */
  acquire: (signal?: AbortSignal) => Promise<void>;
  /** Current configured budget. 0 means unlimited. */
  readonly limitPerMinute: number;
  /** How many requests are waiting for a slot (for logs and health). */
  readonly queued: () => number;
};

/** Wait `ms`, or reject as soon as `signal` aborts. */
function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted while waiting for a rate-limit slot', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted while waiting for a rate-limit slot', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createRateLimiter(
  limitPerMinute: number,
  now: () => number = Date.now,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = defaultWait,
): RateLimiter {
  const windowMs = 60_000;
  const timestamps: number[] = [];

  const prune = (at: number): void => {
    const cutoff = at - windowMs;
    while (timestamps.length > 0 && (timestamps[0] as number) <= cutoff) timestamps.shift();
  };

  const nextSlotDelay = (at: number): number => {
    prune(at);
    if (limitPerMinute <= 0) return 0;
    if (timestamps.length < limitPerMinute) return 0;
    const oldest = timestamps[0] as number;
    return Math.max(0, oldest + windowMs - at);
  };

  const acquire = async (signal?: AbortSignal): Promise<void> => {
    if (limitPerMinute <= 0) return;

    for (;;) {
      const at = now();
      const delay = nextSlotDelay(at);
      if (delay <= 0) {
        timestamps.push(at);
        return;
      }
      // +5ms so we never wake a hair too early and spin.
      await wait(delay + 5, signal);
    }
  };

  return {
    acquire,
    limitPerMinute,
    queued: () => Math.max(0, timestamps.length - limitPerMinute),
  };
}

/**
 * Run `task` over `items` with at most `concurrency` in flight, preserving input
 * order in the result. Rejections are captured per item (`{ ok: false, error }`)
 * so one failing fixture never aborts a whole cycle — that isolation is a
 * requirement, not a convenience.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  const size = Math.max(1, Math.min(concurrency, items.length));

  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = { ok: true, value: await task(item, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}
