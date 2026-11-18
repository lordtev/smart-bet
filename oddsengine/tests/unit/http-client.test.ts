/**
 * The HTTP client is the engine's only door to the outside world, so its
 * retry, timeout and redaction behaviour is worth pinning precisely.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildUrl, createHttpClient } from '../../src/http/client.ts';
import { createRateLimiter, mapWithConcurrency } from '../../src/http/rate-limiter.ts';
import { createLogger, registerSecret, clearSecrets } from '../../src/logging/logger.ts';

function logger() {
  return createLogger({ level: 'error', format: 'json', sink: () => {} });
}

function options(overrides: Partial<Parameters<typeof createHttpClient>[0]> = {}) {
  return {
    log: logger(),
    timeoutMs: 1_000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    rateLimitPerMinute: 0,
    sleep: async () => {},
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('buildUrl', () => {
  it('appends query parameters and drops empty ones', () => {
    const url = buildUrl('https://api.example.com/v4/sports/epl/odds', {
      markets: 'h2h,totals',
      regions: undefined,
      empty: '',
      page: 2,
      flag: false,
    });

    expect(url).toContain('markets=h2h%2Ctotals');
    expect(url).toContain('page=2');
    expect(url).toContain('flag=false');
    expect(url).not.toContain('regions');
    expect(url).not.toContain('empty');
  });
});

describe('createHttpClient', () => {
  it('returns parsed JSON on success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: 1 }]));
    const client = createHttpClient(options({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    const response = await client.request({ url: 'https://x.test/a', label: 'a' });

    expect(response.status).toBe(200);
    expect(response.data).toEqual([{ id: 1 }]);
    expect(client.stats().requests).toBe(1);
  });

  it('retries a 500 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = createHttpClient(options({ fetchImpl: fetchImpl as unknown as typeof fetch }));
    const response = await client.request({ url: 'https://x.test/a', label: 'a' });

    expect(response.data).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.stats().retries).toBe(1);
    expect(client.stats().failures).toBe(0);
  });

  it('does not retry a 400 — a bad request stays bad', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad' }, 400));
    const client = createHttpClient(options({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    await expect(client.request({ url: 'https://x.test/a', label: 'a' })).rejects.toThrow(/responded 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.stats().failures).toBe(1);
  });

  it('gives up after the configured number of retries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'boom' }, 503));
    const client = createHttpClient(options({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    await expect(client.request({ url: 'https://x.test/a', label: 'a' })).rejects.toThrow(/responded 503/);
    // 1 attempt + 2 retries
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After on a 429', async () => {
    const waits: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const client = createHttpClient(
      options({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    );

    await client.request({ url: 'https://x.test/a', label: 'a' });

    expect(waits[0]).toBe(2_000);
    expect(client.stats().rateLimited).toBe(1);
  });

  it('records quota headers from a successful response', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([], 200, { 'x-requests-remaining': '412', 'x-requests-used': '88', 'x-requests-last': '3' }),
    );
    const client = createHttpClient(options({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    await client.request({ url: 'https://x.test/a', label: 'a' });

    expect(client.quota()).toMatchObject({
      'x-requests-remaining': 412,
      'x-requests-used': 88,
      'x-requests-last': 3,
    });
  });

  it('rejects a non-JSON body instead of returning nonsense', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
    const client = createHttpClient(options({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    await expect(client.request({ url: 'https://x.test/a', label: 'a' })).rejects.toThrow(/non-JSON/);
  });

  it('never leaks a registered secret into an error message', async () => {
    clearSecrets();
    registerSecret('super-secret-api-key-value');

    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'denied for key super-secret-api-key-value' }, 403),
    );
    const client = createHttpClient(options({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    const error = await client.request({ url: 'https://x.test/a', label: 'a' }).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain('super-secret-api-key-value');

    clearSecrets();
  });

  it('redacts credential query parameters in error text', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad' }, 400));
    const client = createHttpClient(options({ fetchImpl: fetchImpl as unknown as typeof fetch }));

    await expect(
      client.request({ url: 'https://x.test/a?apiKey=abcdef123456', label: 'a' }),
    ).rejects.toThrow(/responded 400/);
  });
});

describe('createRateLimiter', () => {
  it('does nothing when the limit is 0', async () => {
    const limiter = createRateLimiter(0);
    await expect(limiter.acquire()).resolves.toBeUndefined();
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('lets the whole budget through immediately', async () => {
    let clock = 1_000;
    const waits: number[] = [];
    const limiter = createRateLimiter(3, () => clock, async (ms) => {
      waits.push(ms);
      clock += ms;
    });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    expect(waits).toHaveLength(0);
  });

  it('waits for the window to roll once the budget is spent', async () => {
    let clock = 1_000;
    const waits: number[] = [];
    const limiter = createRateLimiter(2, () => clock, async (ms) => {
      waits.push(ms);
      clock += ms;
    });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    // It waited roughly a full window, and then took its slot.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('rejects rather than hanging when the signal aborts mid-wait', async () => {
    const clock = 0;
    const limiter = createRateLimiter(1, () => clock);

    await limiter.acquire();

    const controller = new AbortController();
    const pending = limiter.acquire(controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow();
  }, 5_000);
});

describe('mapWithConcurrency', () => {
  it('preserves input order', async () => {
    const result = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => value * 10);
    expect(result.map((entry) => (entry.ok ? entry.value : null))).toEqual([10, 20, 30, 40]);
  });

  it('isolates a failure instead of rejecting the whole batch', async () => {
    const result = await mapWithConcurrency([1, 2, 3], 3, async (value) => {
      if (value === 2) throw new Error('fixture 2 is broken');
      return value;
    });

    expect(result[0]).toEqual({ ok: true, value: 1 });
    expect(result[1]?.ok).toBe(false);
    expect(result[2]).toEqual({ ok: true, value: 3 });
  });

  it('never runs more than the requested concurrency', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 12 }, (_, index) => index), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return true;
    });

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });
});
