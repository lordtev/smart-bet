/**
 * HTTP client
 * ─────────────────────────────────────────────────────────────────────────────
 * One place for everything that must be true of every provider request:
 *
 *  - a hard timeout (a hung socket cannot stall a worker cycle);
 *  - retries with exponential backoff and jitter on 408/425/429/5xx and on
 *    transport errors, honouring `Retry-After`;
 *  - a client-side rate limit;
 *  - cancellation from the worker's shutdown signal;
 *  - redaction of credentials in every URL and message that leaves this module;
 *  - quota bookkeeping from response headers (values are recorded, header names
 *    are not assumed beyond a small known set).
 *
 * It returns the raw parsed body. Interpreting it is the adapter's job.
 */

import type { HttpClient, HttpRequest, HttpResponse } from '../providers/types.ts';
import type { Logger } from '../logging/logger.ts';
import { redact } from '../logging/logger.ts';
import { createRateLimiter, type RateLimiter } from './rate-limiter.ts';

export type HttpClientOptions = {
  log: Logger;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  rateLimitPerMinute: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type HttpClientHandle = HttpClient & {
  readonly limiter: RateLimiter;
  /** Counters since start, for the health table. */
  stats: () => { requests: number; failures: number; retries: number; rateLimited: number };
  /** Last seen values of any quota-ish response headers. */
  quota: () => Record<string, number>;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Headers that may carry quota information. */
const QUOTA_HEADERS = new Set([
  'x-requests-remaining',
  'x-requests-used',
  'x-requests-last',
  'x-ratelimit-remaining',
  'x-ratelimit-limit',
  'retry-after',
]);

/** How a failed attempt should be treated by the retry loop. */
type AttemptFailure = {
  kind: 'retryable' | 'fatal';
  message: string;
  waitMs: number | null;
  status: number | null;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Append query parameters to an absolute URL, dropping empty values. */
export function buildUrl(url: string, query?: HttpRequest['query']): string {
  const parsed = new URL(url);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

function parseRetryAfterMs(headers: Record<string, string>): number | null {
  const raw = headers['retry-after'];
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 120_000);

  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 120_000));

  return null;
}

export function createHttpClient(options: HttpClientOptions): HttpClientHandle {
  const log = options.log;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const limiter = createRateLimiter(options.rateLimitPerMinute, now);

  const counters = { requests: 0, failures: 0, retries: 0, rateLimited: 0 };
  const quota: Record<string, number> = {};

  const backoff = (attempt: number): number => {
    const exponential = options.retryBaseDelayMs * 2 ** attempt;
    const capped = Math.min(exponential, options.retryMaxDelayMs);
    // Full jitter: spreads concurrent retries instead of bunching them.
    return Math.round(capped / 2 + Math.random() * (capped / 2));
  };

  const attemptOnce = async (url: string, req: HttpRequest): Promise<HttpResponse<unknown> | AttemptFailure> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${req.label} timed out`)), options.timeoutMs);
    const started = now();
    counters.requests += 1;

    try {
      const response = await fetchImpl(url, {
        method: req.method ?? 'GET',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip',
          'user-agent': 'smartbet-oddsengine/1.0',
          ...(req.headers ?? {}),
        },
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal: controller.signal,
      });

      const durationMs = now() - started;
      const headerRecord: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        headerRecord[lower] = value;
        if (QUOTA_HEADERS.has(lower)) {
          const n = Number(value);
          if (Number.isFinite(n)) quota[lower] = n;
        }
      });

      if (response.ok) {
        const text = await response.text();
        let data: unknown = null;
        if (text.length > 0) {
          try {
            data = JSON.parse(text);
          } catch {
            return {
              kind: 'fatal',
              message: `${req.label} returned non-JSON: ${text.slice(0, 200).replace(/\s+/g, ' ')}`,
              waitMs: null,
              status: response.status,
            };
          }
        }
        log.trace('http ok', { label: req.label, status: response.status, durationMs, bytes: text.length });
        return { status: response.status, data, headers: headerRecord, durationMs };
      }

      const bodyText = await response.text().catch(() => '');
      const message = `${req.label} responded ${response.status}: ${bodyText.slice(0, 300).replace(/\s+/g, ' ')}`;

      if (response.status === 429) counters.rateLimited += 1;

      return {
        kind: RETRYABLE_STATUS.has(response.status) ? 'retryable' : 'fatal',
        message,
        waitMs: parseRetryAfterMs(headerRecord),
        status: response.status,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // A shutdown abort must not be retried; everything else transport-ish is.
      const shuttingDown = /aborted/i.test(text) && !/timed out/.test(text);
      return {
        kind: shuttingDown ? 'fatal' : 'retryable',
        message: /timed out/.test(text) ? `${req.label} timed out after ${options.timeoutMs} ms` : text,
        waitMs: null,
        status: null,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const request = async <T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> => {
    const url = buildUrl(req.url, req.query);
    let last: AttemptFailure | null = null;

    for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
      await limiter.acquire();

      const outcome = await attemptOnce(url, req);

      if (!('kind' in outcome)) {
        return outcome as HttpResponse<T>;
      }

      if (outcome.kind === 'fatal' || attempt === options.maxRetries) {
        counters.failures += 1;
        throw new Error(redact(outcome.message));
      }

      const waitMs = outcome.waitMs ?? backoff(attempt);
      counters.retries += 1;
      log.warn('http retry', {
        label: req.label,
        attempt: attempt + 1,
        of: options.maxRetries + 1,
        status: outcome.status,
        waitMs,
        reason: outcome.message.slice(0, 160),
      });
      last = outcome;
      await sleep(waitMs);
    }

    counters.failures += 1;
    throw new Error(redact(last?.message ?? `${req.label} failed after ${options.maxRetries + 1} attempts`));
  };

  return {
    request,
    limiter,
    stats: () => ({ ...counters }),
    quota: () => ({ ...quota }),
  };
}
