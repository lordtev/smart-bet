/**
 * Bootstrap
 * ─────────────────────────────────────────────────────────────────────────────
 * Assembles the object graph from configuration. One place, so a test can build
 * the same engine against an in-memory rule source or a stub HTTP client without
 * the CLI being involved.
 */

import type { Config } from './config.ts';
import { describeConfig } from './config.ts';
import { createSupabaseClient, type EngineDb } from './db/client.ts';
import { CatalogueRepository } from './db/catalogue.ts';
import { DatabaseRuleSource, HealthRepository, QuoteRepository, SourceRepository } from './db/engine.ts';
import { Engine } from './engine.ts';
import { createHttpClient, type HttpClientHandle } from './http/client.ts';
import { createLogger, registerSecret, type Logger } from './logging/logger.ts';
import type { MarketRuleSource } from './map/market-mapper.ts';
import type { AdapterContext } from './providers/types.ts';
import { createEnabledProviders } from './providers/index.ts';
import type { ProviderAdapter } from './providers/types.ts';

export type Runtime = {
  config: Config;
  log: Logger;
  db: EngineDb;
  http: HttpClientHandle;
  engine: Engine;
  catalogue: CatalogueRepository;
  sources: SourceRepository;
  quotes: QuoteRepository;
  health: HealthRepository;
  providers: ProviderAdapter[];
  /** Resolve one provider by its registry key. */
  providerFor: (key: string) => ProviderAdapter;
  /** Dependencies for tests that want to build their own Engine. */
  deps: ConstructorParameters<typeof Engine>[0];
};

export function createRuntime(
  config: Config,
  options: { providers?: ProviderAdapter[]; sink?: (line: string) => void } = {},
): Runtime {
  const log = createLogger({
    level: config.logging.level,
    format: config.logging.format,
    ...(options.sink ? { sink: options.sink } : {}),
  });

  // Register every secret so a key that leaks into an error message is
  // redacted before it reaches a log line.
  registerSecret(config.supabase.serviceRoleKey);
  registerSecret(config.providers_.theOddsApi.apiKey);

  log.debug('configuration resolved', describeConfig(config));

  const db = createSupabaseClient(config.supabase.url, config.supabase.serviceRoleKey);

  const http = createHttpClient({
    log: log.child({ component: 'http' }),
    timeoutMs: config.http.timeoutMs,
    maxRetries: config.http.maxRetries,
    retryBaseDelayMs: config.http.retryBaseDelayMs,
    retryMaxDelayMs: config.http.retryMaxDelayMs,
    rateLimitPerMinute: config.http.rateLimitPerMinute,
  });

  const catalogue = new CatalogueRepository(db, { writeBatchSize: config.http.writeBatchSize });
  const sources = new SourceRepository(db, log);
  const quotes = new QuoteRepository(db);
  const health = new HealthRepository(db, log);

  const ruleSources = new Map<string, DatabaseRuleSource>();
  const ruleSourceFor = (sourceId: string, providerKey: string): MarketRuleSource => {
    const key = `${sourceId}:${providerKey}`;
    const existing = ruleSources.get(key);
    if (existing) return existing;

    const created = new DatabaseRuleSource({
      db,
      sourceId,
      log: log.child({ component: 'rules', provider: providerKey }),
    });
    ruleSources.set(key, created);
    return created;
  };

  const providers = options.providers ?? createEnabledProviders(config);

  const deps = {
    config,
    log,
    db,
    catalogue,
    sources,
    quotes,
    health,
    http,
    ruleSourceFor,
  };

  const engine = new Engine(deps);

  return {
    config,
    log,
    db,
    http,
    engine,
    catalogue,
    sources,
    quotes,
    health,
    providers,
    deps,
    providerFor: (key: string) => {
      const found = providers.find((provider) => provider.key === key);
      if (!found) throw new Error(`provider "${key}" is not enabled`);
      return found;
    },
  };
}

/* ── Adapter initialisation ──────────────────────────────────────────────── */

/**
 * Build the context an adapter needs (logger, signal, HTTP client, clock).
 *
 * The worker never constructs this itself: keeping the HTTP client and clock out
 * of the worker is what lets the worker be driven by a test with no transport.
 */
export function adapterContextFor(runtime: Runtime, log: Logger, signal: AbortSignal): AdapterContext {
  return { log, signal, http: runtime.http, now: () => new Date() };
}

export type InitProvidersResult = {
  /** Providers that initialised and may be used this run. */
  ready: ProviderAdapter[];
  /** Providers that failed, with the reason. They must not be run. */
  failed: Array<{ key: string; error: string }>;
};

/**
 * Initialise every provider once, before any cycle.
 *
 * `init()` is where an adapter validates credentials and warms caches; the
 * contract in `providers/types.ts` says a cycle must not start without it. A
 * provider that fails here is excluded from the run rather than being retried on
 * every cycle, and the failure is reported with the adapter's own message —
 * "THE_ODDS_API_KEY is empty" rather than "adapter used before init()".
 *
 * One failing provider never stops the others.
 */
export async function initProviders(input: {
  providers: readonly ProviderAdapter[];
  contextFor: (provider: ProviderAdapter) => AdapterContext;
  log: Logger;
}): Promise<InitProvidersResult> {
  const ready: ProviderAdapter[] = [];
  const failed: Array<{ key: string; error: string }> = [];

  for (const provider of input.providers) {
    try {
      await provider.init(input.contextFor(provider));
      ready.push(provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ key: provider.key, error: message });
      input.log.error('provider failed to initialise — it will not run this time', {
        provider: provider.key,
        error: message,
      });
    }
  }

  return { ready, failed };
}
