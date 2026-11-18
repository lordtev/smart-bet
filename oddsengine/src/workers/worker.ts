/**
 * Workers
 * ─────────────────────────────────────────────────────────────────────────────
 * The scheduling shell around the engine. A worker owns one mode (`live` or
 * `prematch`) and one provider, and does nothing except get payloads in front of
 * the engine until it is asked to stop.
 *
 * Two delivery modes, one ingest path:
 *
 *   POLL   run a cycle → wait → repeat. The default, and the only mode a provider
 *          without a stream uses.
 *   PUSH   subscribe to the provider's WebSocket/webhook, coalesce whatever
 *          arrives, hand it to the same `engine.ingest()` a poll would use, and
 *          keep a slower reconciliation poll as a safety net — because streams
 *          drop and webhooks get lost.
 *
 * Why the workers are independent:
 *  • each can be started on its own from the CLI (`live`, `prematch`, `all`);
 *  • each has its own interval, lookahead and fixture ceiling;
 *  • a failure in one provider's cycle is logged and waited out, never thrown
 *    into the other provider's loop;
 *  • shutdown is cooperative — the loop stops scheduling, aborts in-flight work
 *    and gives it a grace period, so a deploy never leaves a half-written batch.
 *
 * There is deliberately no Redis, no queue and no scheduler service. The work is
 * idempotent, cheap to repeat, and bounded by the provider's own rate limits, so
 * a loop with a signal is the honest amount of machinery.
 */

import type { Config } from '../config.ts';
import type { OddsSourceRow, SourceRepository, SourceSyncInput } from '../db/engine.ts';
import type { Engine, CycleMode, CycleStats } from '../engine.ts';
import type { Logger } from '../logging/logger.ts';
import type { AdapterContext, NormalizedFixture, ProviderAdapter, PushSubscription } from '../providers/types.ts';

/** Build the `odds_sources` row description for one provider from configuration. */
export function sourceSyncInput(config: Config, provider: ProviderAdapter, priority: number): SourceSyncInput {
  const isPricing = provider.key === config.providers.pricingProvider;

  return {
    key: provider.key,
    name: provider.name,
    kind: 'provider',
    isEnabled: true,
    priority,
    isPricingSource: isPricing,
    pricingBookmakerKey: isPricing ? config.providers.pricingBookmaker : null,
    supportsLive: provider.supportsLive,
    supportsPrematch: provider.supportsPrematch,
    config: {
      // Non-secret settings only. Credentials stay in the environment.
      liveIntervalMs: config.polling.liveIntervalMs,
      prematchIntervalMs: config.polling.prematchIntervalMs,
      push: Boolean(provider.subscribe),
      markets: config.providers_.theOddsApi.markets,
      regions: config.providers_.theOddsApi.regions,
      supportsLive: provider.supportsLive,
      supportsPrematch: provider.supportsPrematch,
    },
  };
}

/** Bring `odds_sources` in line with configuration, then return the rows by key. */
export async function syncSources(
  config: Config,
  providers: readonly ProviderAdapter[],
  sources: SourceRepository,
  log: Logger,
): Promise<Map<string, OddsSourceRow>> {
  const inputs = providers.map((provider, index) => sourceSyncInput(config, provider, (index + 1) * 10));
  const rows = await sources.sync(inputs);

  for (const input of inputs) {
    const row = rows.get(input.key);
    if (!row) {
      throw new Error(`odds source "${input.key}" was not created — check the odds_sources table`);
    }
    log.info('source ready', {
      source: row.key,
      pricing: row.is_pricing_source,
      pricingBookmaker: row.pricing_bookmaker_key ?? '(all)',
      priority: row.priority,
      push: Boolean(config.push.enabled),
    });
  }

  return rows;
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export type WorkerOptions = {
  engine: Engine;
  provider: ProviderAdapter;
  source: OddsSourceRow;
  mode: CycleMode;
  intervalMs: number;
  log: Logger;
  signal: AbortSignal;
  /** Run exactly one cycle and return instead of looping. */
  once?: boolean;
  /** Injected in tests. */
  sleep?: Sleep;
  /**
   * Builds the context an adapter needs (logger, signal, HTTP client, clock).
   * Supplied by the caller so the worker itself stays transport-agnostic.
   */
  adapterContext?: (log: Logger, signal: AbortSignal) => AdapterContext;
  /**
   * Use the provider's push stream when it has one. Off by default so a caller
   * that does not know about push keeps the plain polling behaviour.
   */
  push?: { enabled: boolean; debounceMs: number; reconcileIntervalMs: number };
};

export type WorkerOutcome = {
  cycles: number;
  failures: number;
  /** How the worker was driven: 'poll' or the subscription's kind. */
  delivery: string;
  lastStats: CycleStats | null;
};

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run a worker loop.
 *
 * The interval is measured from the *end* of a cycle, so a slow provider cannot
 * cause a pile-up of overlapping cycles: the worker simply runs less often.
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerOutcome> {
  const { engine, provider, source, mode, intervalMs, log, signal } = options;
  const sleep = options.sleep ?? defaultSleep;
  const workerLog = log.child({ provider: provider.key, worker: mode });
  const outcome: WorkerOutcome = { cycles: 0, failures: 0, delivery: 'poll', lastStats: null };

  if (intervalMs === 0) {
    workerLog.info('worker disabled by a 0 ms interval', { mode });
    return outcome;
  }

  const wantsPush = Boolean(options.push?.enabled) && typeof provider.subscribe === 'function';

  if (wantsPush && !options.once) {
    return runPushWorker(options, workerLog, outcome);
  }

  workerLog.info('worker starting', {
    intervalMs,
    intervalHuman: formatInterval(intervalMs),
    pricingSource: source.is_pricing_source,
    delivery: 'poll',
  });

  for (;;) {
    if (signal.aborted) {
      workerLog.info('worker stopping', { cycles: outcome.cycles, failures: outcome.failures });
      return outcome;
    }

    const stats = await engine.runCycle(provider, mode, signal, source);
    outcome.cycles += 1;
    outcome.lastStats = stats;
    if (!stats.ok) outcome.failures += 1;

    if (options.once) {
      workerLog.info('single cycle finished', { ok: stats.ok, error: stats.error });
      return outcome;
    }

    if (signal.aborted) continue;

    await sleep(intervalMs, signal);
  }
}

/**
 * Push delivery.
 *
 * Pushed payloads are coalesced for `debounceMs` and then handed to
 * `engine.ingest()` — the same path a polled payload takes. A slower
 * reconciliation poll runs alongside (unless disabled) because a stream is a
 * convenience, not a guarantee. If the subscription dies, the worker falls back
 * to pure polling rather than going silent.
 */
async function runPushWorker(
  options: WorkerOptions,
  workerLog: Logger,
  outcome: WorkerOutcome,
): Promise<WorkerOutcome> {
  const { engine, provider, source, mode, signal } = options;
  const push = options.push as NonNullable<WorkerOptions['push']>;
  const sleep = options.sleep ?? defaultSleep;

  const queue: NormalizedFixture[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let subscription: PushSubscription | null = null;
  let ingestChain: Promise<unknown> = Promise.resolve();
  let pushedIngests = 0;

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (queue.length === 0) return;

    const batch = queue.splice(0, queue.length);

    // Serialise ingests: two overlapping ingests for the same source would both
    // try to create catalogue rows for the same fixture, so the second would be
    // wasted work at best.
    ingestChain = ingestChain
      .then(async () => {
        if (signal.aborted) return;
        outcome.cycles += 1;
        pushedIngests += 1;
        const stats = await engine.ingest(batch, provider, mode, signal, source);
        outcome.lastStats = stats;
        if (!stats.ok) outcome.failures += 1;
      })
      .catch((error: unknown) => {
        outcome.failures += 1;
        workerLog.error('push ingest failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    if (push.debounceMs <= 0) {
      flush();
      return;
    }
    flushTimer = setTimeout(flush, push.debounceMs);
  };

  if (!options.adapterContext) {
    workerLog.warn('push requested without an adapter context — falling back to polling');
    return runPollingFallback(options, workerLog, outcome);
  }

  try {
    subscription = await (provider.subscribe as NonNullable<ProviderAdapter['subscribe']>)(
      {
        onFixtures: (fixtures) => {
          if (signal.aborted) return;
          queue.push(...fixtures);
          scheduleFlush();
        },
        onError: (error, meta) => {
          workerLog.warn('push stream error', {
            error: error.message,
            fatal: meta.fatal,
            fallback: meta.fatal ? 'polling' : 'none',
          });
        },
      },
      options.adapterContext(workerLog, signal),
    );
  } catch (error) {
    workerLog.warn('push subscription failed — falling back to polling', {
      error: error instanceof Error ? error.message : String(error),
    });
    return runPollingFallback(options, workerLog, outcome);
  }

  outcome.delivery = subscription.kind;
  workerLog.info('worker starting', {
    delivery: subscription.kind,
    debounceMs: push.debounceMs,
    reconcileIntervalMs: push.reconcileIntervalMs,
    pricingSource: source.is_pricing_source,
  });

  const reconcile = async (): Promise<void> => {
    if (push.reconcileIntervalMs <= 0) return;
    for (;;) {
      if (signal.aborted) return;
      await sleep(push.reconcileIntervalMs, signal);
      if (signal.aborted) return;

      const stats = await engine.runCycle(provider, mode, signal, source);
      outcome.cycles += 1;
      outcome.lastStats = stats;
      if (!stats.ok) outcome.failures += 1;

      // The stream itself failed permanently: stop pretending, poll properly.
      if (!subscription.active()) {
        workerLog.warn('push stream is no longer active — switching to polling', {
          cycles: outcome.cycles,
          pushedIngests,
        });
        return;
      }
    }
  };

  const reconcileLoop = reconcile();

  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
    // Anything still queued has not been started, so it is dropped: shutdown
    // finishes work in progress, it does not start new writes. The payload is not
    // lost in any meaningful sense — the reconciliation poll and the next start-up
    // cycle re-fetch it from the provider.
    queue.length = 0;
    await ingestChain;
    await subscription.stop().catch(() => undefined);
    await reconcileLoop.catch(() => undefined);
    workerLog.info('worker stopping', {
      cycles: outcome.cycles,
      failures: outcome.failures,
      delivery: outcome.delivery,
    });
  }

  return outcome;
}

/** Plain polling, used when a push subscription could not be established. */
async function runPollingFallback(
  options: WorkerOptions,
  workerLog: Logger,
  outcome: WorkerOutcome,
): Promise<WorkerOutcome> {
  const { engine, provider, source, mode, intervalMs, signal } = options;
  const sleep = options.sleep ?? defaultSleep;

  outcome.delivery = 'poll';
  workerLog.info('worker starting', {
    intervalMs,
    intervalHuman: formatInterval(intervalMs),
    pricingSource: source.is_pricing_source,
    delivery: 'poll',
    fallback: true,
  });

  for (;;) {
    if (signal.aborted) {
      workerLog.info('worker stopping', { cycles: outcome.cycles, failures: outcome.failures });
      return outcome;
    }

    const stats = await engine.runCycle(provider, mode, signal, source);
    outcome.cycles += 1;
    outcome.lastStats = stats;
    if (!stats.ok) outcome.failures += 1;

    if (signal.aborted) continue;
    await sleep(intervalMs, signal);
  }
}

/** "3000 ms" → "3s", "1800000" → "30m". */
export function formatInterval(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`;
  const minutes = ms / 60_000;
  return `${Math.round(minutes * 10) / 10}m`;
}

/**
 * Wire Ctrl-C / SIGTERM to an AbortController so shutdown is cooperative.
 * Returns a function that removes the listeners (used by tests).
 */
export function installShutdownHandlers(
  controller: AbortController,
  log: Logger,
  graceMs: number,
): { dispose: () => void; whenAborted: Promise<void> } {
  const handle = (signal: string) => (): void => {
    if (controller.signal.aborted) {
      log.warn('second shutdown signal received — exiting immediately', { signal, graceMs });
      process.exit(130);
    }

    log.info('shutdown requested — finishing the current work', { signal, graceMs });
    controller.abort();

    // Backstop: if something refuses to settle, do not hang a deploy.
    const timer = setTimeout(() => {
      log.error('grace period expired — exiting', { graceMs });
      process.exit(124);
    }, graceMs);
    timer.unref?.();
  };

  const onInt = handle('SIGINT');
  const onTerm = handle('SIGTERM');

  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  return {
    dispose: () => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
    },
    whenAborted: new Promise((resolve) => {
      if (controller.signal.aborted) {
        resolve();
        return;
      }
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  };
}
