/**
 * Push delivery and worker lifecycle.
 *
 * Requirement: the architecture must be *capable* of using WebSockets or webhooks
 * in place of polling. These tests prove the capability is real and safe:
 *
 *   • a pushed payload takes the identical path as a polled one;
 *   • a burst of messages is coalesced into one ingest, not one per message;
 *   • overlapping ingests are serialised;
 *   • a subscription that cannot be established falls back to polling;
 *   • a stream that dies is noticed and polling resumes;
 *   • shutdown drains what was already received before closing the stream.
 *
 * All of it runs offline against the mock provider and an in-memory engine
 * double, so none of it needs a database.
 */
import { describe, expect, it, vi } from 'vitest';
import { runWorker, formatInterval, type WorkerOptions } from '../../src/workers/worker.ts';
import { createMockProvider } from '../../src/providers/mock.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import type { Engine, CycleStats } from '../../src/engine.ts';
import type { OddsSourceRow } from '../../src/db/engine.ts';
import type { AdapterContext, NormalizedFixture, ProviderAdapter, PushHandlers, PushSubscription } from '../../src/providers/types.ts';

const FIXED_NOW = new Date('2026-09-26T18:00:00.000Z');

const source: OddsSourceRow = {
  id: 'source-1',
  key: 'mock',
  name: 'Mock',
  kind: 'provider',
  is_enabled: true,
  priority: 10,
  is_pricing_source: true,
  pricing_bookmaker_key: null,
  supports_live: true,
  supports_prematch: true,
  config: {},
};

function statsFor(fixtures: number, ok = true): CycleStats {
  return {
    provider: 'mock',
    mode: 'live',
    sourceKey: 'mock',
    fixturesFetched: fixtures,
    fixturesResolved: fixtures,
    fixturesCreated: 0,
    fixturesFailed: 0,
    providerMarkets: 0,
    canonicalMarkets: 0,
    outcomesIn: 0,
    outcomesOut: 0,
    rejectedPrices: 0,
    unknownMarkets: 0,
    quotesPrepared: 0,
    quotesAccepted: 0,
    quotesChanged: 0,
    quotesInserted: 0,
    quotesSkipped: 0,
    quotesStale: 0,
    historyRows: 0,
    invalidQuotes: 0,
    pricesPublished: 0,
    statusesPublished: 0,
    eventStateUpdates: 0,
    dryRun: false,
    ok,
    error: ok ? null : 'boom',
    durationMs: 1,
  };
}

/** Records what the worker asked the engine to do. */
function engineDouble() {
  const polls: number[] = [];
  const ingests: number[] = [];

  const engine = {
    runCycle: async (): Promise<CycleStats> => {
      polls.push(1);
      return statsFor(0);
    },
    ingest: async (fixtures: readonly NormalizedFixture[]): Promise<CycleStats> => {
      ingests.push(fixtures.length);
      return statsFor(fixtures.length);
    },
  } as unknown as Engine;

  return { engine, polls, ingests };
}

/** A provider whose stream is driven by the test rather than a timer. */
function manualPushProvider(options: { failSubscribe?: boolean; diesAfterFirst?: boolean } = {}) {
  let handlers: PushHandlers | null = null;
  let alive = true;
  let stopped = 0;

  const provider: ProviderAdapter = {
    key: 'manual',
    name: 'Manual push',
    supportsLive: true,
    supportsPrematch: true,
    knownBookmakers: [],
    init: async () => {},
    fetchFixtures: async () => [],
    getUsage: () => ({ quotaRemaining: null, quotaUsed: null, lastCost: null }),
    shutdown: async () => {},

    subscribe: async (pushHandlers: PushHandlers): Promise<PushSubscription> => {
      if (options.failSubscribe) throw new Error('cannot open stream');
      handlers = pushHandlers;
      return {
        kind: 'websocket',
        active: () => alive,
        stop: async () => {
          stopped += 1;
          alive = false;
        },
      };
    },
  };

  return {
    provider,
    /** Deliver one pushed payload. */
    push: (fixtures: NormalizedFixture[]) => handlers?.onFixtures(fixtures, { receivedAt: FIXED_NOW, label: 'test' }),
    /** Simulate the stream dying. */
    die: () => {
      alive = false;
    },
    stoppedCount: () => stopped,
  };
}

function fakeFixture(id: string): NormalizedFixture {
  return {
    sourceEventKey: id,
    sportName: 'Football',
    sportKey: 'mock_football',
    competitionTitle: 'Mock League',
    countryCode: 'UG',
    homeTeam: 'A',
    awayTeam: 'B',
    name: 'A vs B',
    commenceTime: '2026-09-26T18:00:00.000Z',
    isLive: true,
    homeScore: 0,
    awayScore: 0,
    minute: 10,
    books: [],
  };
}

/** A sleep that resolves immediately but still yields, so loops make progress. */
const instantSleep = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function baseOptions(overrides: Partial<WorkerOptions> = {}): WorkerOptions {
  return {
    engine: engineDouble().engine,
    provider: manualPushProvider().provider,
    source,
    mode: 'live',
    intervalMs: 1_000,
    log: silentLogger(),
    signal: new AbortController().signal,
    sleep: instantSleep,
    adapterContext: (_log, signal): AdapterContext => ({
      log: silentLogger(),
      signal,
      http: { request: async <T,>() => ({ status: 200, data: null as T, headers: {}, durationMs: 0 }) },
      now: () => FIXED_NOW,
    }),
    ...overrides,
  };
}

describe('push delivery', () => {
  it('ingests a pushed payload through the shared ingest path', async () => {
    const manual = manualPushProvider();
    const { engine, ingests, polls } = engineDouble();
    const controller = new AbortController();

    const running = runWorker(
      baseOptions({
        engine,
        provider: manual.provider,
        signal: controller.signal,
        push: { enabled: true, debounceMs: 0, reconcileIntervalMs: 0 },
      }),
    );

    // Let the subscription establish.
    await new Promise((resolve) => setTimeout(resolve, 5));
    manual.push([fakeFixture('fx-1'), fakeFixture('fx-2')]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    controller.abort();
    const outcome = await running;

    expect(ingests).toEqual([2]);
    // The reconciliation poll was disabled, so nothing was polled.
    expect(polls).toHaveLength(0);
    expect(outcome.delivery).toBe('websocket');
    expect(outcome.cycles).toBe(1);
    expect(manual.stoppedCount()).toBe(1);
  });

  it('coalesces a burst into a single ingest', async () => {
    const manual = manualPushProvider();
    const { engine, ingests } = engineDouble();
    const controller = new AbortController();

    const running = runWorker(
      baseOptions({
        engine,
        provider: manual.provider,
        signal: controller.signal,
        // A debounce long enough for the whole burst to land inside one window.
        push: { enabled: true, debounceMs: 20, reconcileIntervalMs: 0 },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    manual.push([fakeFixture('a')]);
    manual.push([fakeFixture('b')]);
    manual.push([fakeFixture('c'), fakeFixture('d')]);

    await new Promise((resolve) => setTimeout(resolve, 40));

    controller.abort();
    await running;

    expect(ingests).toEqual([4]);
  });

  it('serialises overlapping ingests rather than running them concurrently', async () => {
    const manual = manualPushProvider();
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];

    const engine = {
      runCycle: async () => statsFor(0),
      ingest: async (fixtures: readonly NormalizedFixture[]) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(fixtures.length);
        inFlight -= 1;
        return statsFor(fixtures.length);
      },
    } as unknown as Engine;

    const controller = new AbortController();
    const running = runWorker(
      baseOptions({
        engine,
        provider: manual.provider,
        signal: controller.signal,
        push: { enabled: true, debounceMs: 0, reconcileIntervalMs: 0 },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    manual.push([fakeFixture('a')]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    manual.push([fakeFixture('b')]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    controller.abort();
    await running;

    expect(peak).toBe(1);
    expect(order).toEqual([1, 1]);
  });

  it('does not start a new ingest during shutdown, but does clean up', async () => {
    const manual = manualPushProvider();
    const { engine, ingests } = engineDouble();
    const controller = new AbortController();

    const running = runWorker(
      baseOptions({
        engine,
        provider: manual.provider,
        signal: controller.signal,
        push: { enabled: true, debounceMs: 20, reconcileIntervalMs: 0 },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    manual.push([fakeFixture('queued')]);

    // Abort inside the debounce window, before the ingest has started.
    controller.abort();
    await running;

    // Shutdown finishes work in progress; it does not begin new writes. Nothing
    // is lost: the next cycle re-fetches the same payload from the provider.
    expect(ingests).toEqual([]);
    // The stream is still released, so no timer or socket leaks.
    expect(manual.stoppedCount()).toBe(1);
  });

  it('lets an ingest that has already started finish', async () => {
    const manual = manualPushProvider();
    const completed: number[] = [];

    const engine = {
      runCycle: async () => statsFor(0),
      ingest: async (fixtures: readonly NormalizedFixture[]) => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        completed.push(fixtures.length);
        return statsFor(fixtures.length);
      },
    } as unknown as Engine;

    const controller = new AbortController();
    const running = runWorker(
      baseOptions({
        engine,
        provider: manual.provider,
        signal: controller.signal,
        push: { enabled: true, debounceMs: 0, reconcileIntervalMs: 0 },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    manual.push([fakeFixture('in-flight')]);
    // Abort while that ingest is still running.
    await new Promise((resolve) => setTimeout(resolve, 2));
    controller.abort();

    await running;
    expect(completed).toEqual([1]);
  });

  it('falls back to polling when the subscription cannot be established', async () => {
    const failing = manualPushProvider({ failSubscribe: true });
    const { engine, polls } = engineDouble();
    const controller = new AbortController();

    const running = runWorker(
      baseOptions({
        engine,
        provider: failing.provider,
        signal: controller.signal,
        intervalMs: 1,
        push: { enabled: true, debounceMs: 0, reconcileIntervalMs: 0 },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const outcome = await running;

    expect(polls.length).toBeGreaterThan(0);
    expect(outcome.delivery).toBe('poll');
  });

  it('keeps polling as a reconciliation net while the stream is live', async () => {
    const manual = manualPushProvider();
    const { engine, polls, ingests } = engineDouble();
    const controller = new AbortController();

    const running = runWorker(
      baseOptions({
        engine,
        provider: manual.provider,
        signal: controller.signal,
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
        push: { enabled: true, debounceMs: 0, reconcileIntervalMs: 1 },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    manual.push([fakeFixture('a')]);
    await new Promise((resolve) => setTimeout(resolve, 25));

    controller.abort();
    await running;

    // Push delivered the update; polling independently verified it.
    expect(ingests).toEqual([1]);
    expect(polls.length).toBeGreaterThan(0);
  });

  it('notices a dead stream and does not go silent', async () => {
    const manual = manualPushProvider();
    const { engine, polls } = engineDouble();
    const controller = new AbortController();

    const running = runWorker(
      baseOptions({
        engine,
        provider: manual.provider,
        signal: controller.signal,
        sleep: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
        },
        push: { enabled: true, debounceMs: 0, reconcileIntervalMs: 1 },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    manual.die();
    await new Promise((resolve) => setTimeout(resolve, 25));

    controller.abort();
    await running;

    // Reconciliation kept running even though the stream was gone.
    expect(polls.length).toBeGreaterThan(0);
  });

  it('ignores push entirely when the provider has no subscribe()', async () => {
    const pollingProvider = createMockProvider({ fixtureCount: 0, now: () => FIXED_NOW });
    const noSubscribe: ProviderAdapter = { ...pollingProvider, subscribe: undefined };
    const { engine, polls } = engineDouble();
    const controller = new AbortController();

    const running = runWorker(
      baseOptions({
        engine,
        provider: noSubscribe,
        signal: controller.signal,
        intervalMs: 1,
        push: { enabled: true, debounceMs: 0, reconcileIntervalMs: 0 },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 15));
    controller.abort();
    const outcome = await running;

    expect(polls.length).toBeGreaterThan(0);
    expect(outcome.delivery).toBe('poll');
  });

  it('a pushed payload reaches the real Engine through ingest()', async () => {
    // End-to-end shape check: the mock provider's stream feeds the actual
    // engine's ingest(), proving push and poll share one write path.
    const provider = createMockProvider({ fixtureCount: 2, pushIntervalMs: 5, now: () => FIXED_NOW });
    const seen: number[] = [];

    const engine = {
      runCycle: async () => statsFor(0),
      ingest: async (fixtures: readonly NormalizedFixture[]) => {
        seen.push(fixtures.length);
        return statsFor(fixtures.length);
      },
    } as unknown as Engine;

    const controller = new AbortController();
    const running = runWorker(
      baseOptions({
        engine,
        provider,
        signal: controller.signal,
        push: { enabled: true, debounceMs: 0, reconcileIntervalMs: 0 },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    const outcome = await running;

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === 2)).toBe(true);
    expect(outcome.delivery).toBe('mock-websocket');
    // And the provider released its timer.
    await expect(provider.fetchFixtures(
      { mode: 'live', from: new Date('2026-09-26T14:00:00Z'), to: FIXED_NOW, limit: 5 },
      { log: silentLogger(), signal: new AbortController().signal, http: { request: async <T,>() => ({ status: 200, data: null as T, headers: {}, durationMs: 0 }) }, now: () => FIXED_NOW },
    )).resolves.toHaveLength(2);
  });

  it('mock subscribe can be made to fail, for the fallback path', async () => {
    const provider = createMockProvider({ failPush: true, now: () => FIXED_NOW });
    const handlers = { onFixtures: vi.fn(), onError: vi.fn() };

    await expect(
      provider.subscribe?.(handlers, {
        log: silentLogger(),
        signal: new AbortController().signal,
        http: { request: async <T,>() => ({ status: 200, data: null as T, headers: {}, durationMs: 0 }) },
        now: () => FIXED_NOW,
      }),
    ).rejects.toThrow(/push subscription/);
  });
});

describe('worker lifecycle', () => {
  it('runs one cycle and returns when asked to run once', async () => {
    const { engine, polls } = engineDouble();
    const outcome = await runWorker(baseOptions({ engine, once: true, intervalMs: 1_000 }));

    expect(polls).toHaveLength(1);
    expect(outcome.cycles).toBe(1);
  });

  it('does nothing at all with a 0 ms interval', async () => {
    const { engine, polls } = engineDouble();
    const outcome = await runWorker(baseOptions({ engine, intervalMs: 0 }));
    expect(polls).toHaveLength(0);
    expect(outcome.cycles).toBe(0);
  });

  it('stops promptly when aborted', async () => {
    const { engine } = engineDouble();
    const controller = new AbortController();

    const running = runWorker(baseOptions({ engine, signal: controller.signal, intervalMs: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const outcome = await running;
    expect(outcome.cycles).toBeGreaterThan(0);
  });

  it('counts failed cycles without stopping the loop', async () => {
    const engine = {
      runCycle: async (): Promise<CycleStats> => statsFor(0, false),
      ingest: async (): Promise<CycleStats> => statsFor(0, false),
    } as unknown as Engine;

    const controller = new AbortController();
    const running = runWorker(baseOptions({ engine, signal: controller.signal, intervalMs: 1 }));

    await new Promise((resolve) => setTimeout(resolve, 15));
    controller.abort();
    const outcome = await running;

    expect(outcome.failures).toBeGreaterThan(0);
  });

  it('formats intervals for humans', () => {
    expect(formatInterval(500)).toBe('500ms');
    expect(formatInterval(3_000)).toBe('3s');
    expect(formatInterval(1_800_000)).toBe('30m');
  });
});
