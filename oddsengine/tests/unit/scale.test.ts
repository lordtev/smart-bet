/**
 * Scale.
 *
 * Requirement: "designed for thousands of fixtures and potentially many markets
 * per fixture", with batched writes and concurrent processing. These tests assert
 * the mechanics that make that true, against in-memory repositories so the
 * timings are the engine's rather than the network's:
 *
 *   • a large payload completes, with no duplicate catalogue writes;
 *   • quote writes are batched, not issued once per quote;
 *   • fixture resolution is concurrent but bounded by MAX_CONCURRENCY;
 *   • one broken fixture does not cost the whole cycle.
 */
import { describe, expect, it } from 'vitest';
import { Engine, type EngineDeps } from '../../src/engine.ts';
import type { CatalogueRepository } from '../../src/db/catalogue.ts';
import type { ApplyQuotesResult, HealthRepository, OddsSourceRow, QuoteRepository, QuoteUpsert, SourceRepository } from '../../src/db/engine.ts';
import type { HttpClientHandle } from '../../src/http/client.ts';
import type { MarketRuleSource } from '../../src/map/market-mapper.ts';
import type { NormalizedFixture, ProviderAdapter } from '../../src/providers/types.ts';
import { loadConfig } from '../../src/config.ts';
import { silentLogger } from '../../src/logging/logger.ts';

const FIXED_NOW = new Date('2026-09-26T18:00:00.000Z');

function rules(): MarketRuleSource {
  return {
    listRules: async () => [
      {
        providerKey: '1x2',
        canonicalCode: 'MATCH_WINNER',
        canonicalName: '1X2',
        period: 'FT',
        lineType: 'none',
        outcomeMap: null,
        reviewStatus: 'mapped',
      },
      {
        providerKey: 'ou',
        canonicalCode: 'OVER_UNDER',
        canonicalName: 'Over / Under',
        period: 'FT',
        lineType: 'total',
        outcomeMap: null,
        reviewStatus: 'mapped',
      },
    ],
    recordUnknownMarket: async () => {},
  };
}

function fixture(index: number): NormalizedFixture {
  return {
    sourceEventKey: `fx-${index}`,
    sportName: 'Football',
    sportKey: 'soccer_epl',
    competitionTitle: 'Premier League',
    countryCode: 'GB',
    homeTeam: `Home ${index}`,
    awayTeam: `Away ${index}`,
    name: `Home ${index} vs Away ${index}`,
    commenceTime: '2026-09-27T15:00:00.000Z',
    isLive: false,
    homeScore: null,
    awayScore: null,
    minute: null,
    books: [
      {
        bookmakerKey: 'book-a',
        bookmakerTitle: 'Book A',
        markets: [
          {
            sourceKey: '1X2',
            status: 'open',
            updatedAt: '2026-09-26T17:00:00.000Z',
            outcomes: [
              { sourceKey: 'h', name: `Home ${index}`, price: 2.1 },
              { sourceKey: 'd', name: 'Draw', price: 3.4 },
              { sourceKey: 'a', name: `Away ${index}`, price: 3.3 },
            ],
          },
          {
            sourceKey: 'OU_2_5',
            status: 'open',
            updatedAt: '2026-09-26T17:00:00.000Z',
            outcomes: [
              { sourceKey: 'o', name: 'Over', price: 1.95, point: 2.5 },
              { sourceKey: 'u', name: 'Under', price: 1.88, point: 2.5 },
            ],
          },
        ],
      },
    ],
  };
}

type Harness = {
  engine: Engine;
  source: OddsSourceRow;
  counters: {
    marketBatches: number;
    selectionBatches: number;
    rowsWritten: number;
    quoteBatches: number;
    cataloguedEvents: Set<string>;
    peakConcurrency: number;
  };
};

function harness(options: { concurrency?: number; fixtureDelayMs?: number; breakAt?: number } = {}): Harness {
  const config = loadConfig(
    {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_value_123456789',
      ENABLED_PROVIDERS: 'mock',
      PRICING_PROVIDER: 'mock',
      MAX_CONCURRENCY: String(options.concurrency ?? 8),
      LOG_LEVEL: 'error',
      ODDS_ENV_FALLBACK_FILES: '',
    } as Record<string, string>,
    { dryRun: false },
  );

  const counters = {
    marketBatches: 0,
    selectionBatches: 0,
    rowsWritten: 0,
    quoteBatches: 0,
    cataloguedEvents: new Set<string>(),
    peakConcurrency: 0,
  };

  let inFlight = 0;
  let eventSeq = 0;
  const delay = options.fixtureDelayMs ?? 0;

  const catalogue = {
    refresh: async () => {},
    ensureMarketTypes: async (required: Iterable<[string, string]>) => {
      const out = new Map<string, { id: string; code: string; name: string }>();
      for (const [code, name] of required) out.set(code, { id: `mt-${code}`, code, name });
      return out;
    },
    findLink: async () => null,
    findFixtureCandidates: async () => [],
    resolveSport: async () => 'sport-1',
    resolveLeague: async () => 'league-1',
    resolveTeam: async (_sport: string, name: string) => `team-${name}`,
    createEvent: async () => {
      eventSeq += 1;
      return `event-${eventSeq}`;
    },
    updateEventState: async () => {},
    saveLink: async (input: { externalKey: string; eventId: string }) => {
      counters.cataloguedEvents.add(input.externalKey);
    },
    ensureMarkets: async (rows: Array<{ eventId: string; canonicalKey: string }>) => {
      counters.marketBatches += 1;
      counters.rowsWritten += rows.length;
      const out = new Map<string, string>();
      for (const row of rows) out.set(`${row.eventId}#${row.canonicalKey}`, `m-${out.size + 1}`);
      return out;
    },
    ensureSelections: async (rows: Array<{ marketId: string; outcomeKey: string }>) => {
      counters.selectionBatches += 1;
      counters.rowsWritten += rows.length;
      const out = new Map<string, string>();
      for (const row of rows) out.set(`${row.marketId}#${row.outcomeKey}`, `s-${out.size + 1}`);
      return out;
    },
  } as unknown as CatalogueRepository;

  const quotes = {
    applyQuotes: async (input: { quotes: readonly QuoteUpsert[] }): Promise<ApplyQuotesResult> => {
      counters.quoteBatches += 1;
      return {
        received: input.quotes.length,
        accepted: input.quotes.length,
        invalid: 0,
        touched: input.quotes.length,
        changed: input.quotes.length,
        inserted: input.quotes.length,
        heartbeat: 0,
        skipped: 0,
        stale: 0,
        history: 0,
        applied_at: FIXED_NOW.toISOString(),
      };
    },
    publishPrices: async () => ({ prices_updated: 0, statuses_updated: 0, published_at: '' }),
  } as unknown as QuoteRepository;

  const health = {
    startRun: async () => null,
    recordCycle: async () => {},
    finishRun: async () => {},
  } as unknown as HealthRepository;

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


  // Wrap createEvent to observe in-flight fixture resolution.
  const originalCreate = catalogue.createEvent as unknown as () => Promise<string>;
  (catalogue as unknown as { createEvent: () => Promise<string> }).createEvent = async () => {
    inFlight += 1;
    counters.peakConcurrency = Math.max(counters.peakConcurrency, inFlight);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const id = await originalCreate();
    inFlight -= 1;
    return id;
  };

  const deps: EngineDeps = {
    config,
    log: silentLogger(),
    db: {} as EngineDeps['db'],
    catalogue,
    sources: {} as SourceRepository,
    quotes,
    health,
    http: { stats: () => ({ requests: 0, failures: 0, retries: 0, rateLimited: 0 }) } as unknown as HttpClientHandle,
    ruleSourceFor: rules,
    now: () => FIXED_NOW,
  };

  return { engine: new Engine(deps), source, counters };
}

/** A provider that always serves exactly count fixtures. */
function providerServing(count: number): ProviderAdapter {
  return {
    key: 'mock',
    name: 'Mock',
    supportsLive: true,
    supportsPrematch: true,
    knownBookmakers: [],
    init: async () => {},
    fetchFixtures: async () => Array.from({ length: count }, (_, index) => fixture(index)),
    getUsage: () => ({ quotaRemaining: null, quotaUsed: null, lastCost: null }),
    shutdown: async () => {},
  };
}

describe('scale', () => {
  it('handles 1000 fixtures in one cycle', async () => {
    const { engine, source, counters } = harness();
    const signal = new AbortController().signal;

    const started = Date.now();
    const stats = await engine.runCycle(providerServing(1000), 'prematch', signal, source);
    const elapsed = Date.now() - started;

    expect(stats.ok).toBe(true);
    expect(stats.fixturesFetched).toBe(1000);
    // 2 markets per fixture, 5 outcomes each.
    expect(stats.canonicalMarkets).toBe(2000);
    expect(stats.outcomesOut).toBe(5000);
    expect(stats.quotesPrepared).toBe(5000);

    // Every fixture got exactly one catalogue entry.
    expect(counters.cataloguedEvents.size).toBe(1000);
    // One batched write per phase, not one per row.
    expect(counters.marketBatches).toBe(1);
    expect(counters.selectionBatches).toBe(1);
    expect(counters.quoteBatches).toBe(1);

    // Generous bound: this is in-memory, so it should be quick; the assertion is
    // here to catch an accidental per-row round trip rather than to benchmark.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('bounds fixture resolution concurrency', async () => {
    const { engine, source, counters } = harness({ concurrency: 4, fixtureDelayMs: 2 });
    const signal = new AbortController().signal;

    const stats = await engine.ingest(
      Array.from({ length: 60 }, (_, index) => fixture(index)),
      providerServing(0),

      'prematch',
      signal,
      source,
    );

    expect(stats.ok).toBe(true);
    expect(counters.peakConcurrency).toBeLessThanOrEqual(4);
    expect(counters.peakConcurrency).toBeGreaterThan(1);
  }, 30_000);

  it('lets one unusable fixture fail without losing the rest', async () => {
    const { engine, source } = harness();
    const signal = new AbortController().signal;

    const fixtures = Array.from({ length: 10 }, (_, index) => fixture(index));
    // A fixture whose prices are all unusable maps to nothing at all.
    const broken: NormalizedFixture = {
      ...fixture(999),
      books: [
        {
          bookmakerKey: 'book-a',
          bookmakerTitle: 'Book A',
          markets: [
            {
              sourceKey: '1X2',
              status: 'open',
              updatedAt: null,
              outcomes: [{ sourceKey: 'h', name: 'Home 999', price: 0.5 }],
            },
          ],
        },
      ],
    };

    const stats = await engine.ingest([...fixtures, broken], providerServing(0), 'prematch', signal, source);

    expect(stats.ok).toBe(true);
    expect(stats.fixturesFetched).toBe(11);
    // The broken one was counted and skipped, not fatal.
    expect(stats.rejectedPrices).toBe(1);
    expect(stats.quotesPrepared).toBe(10 * 5);
  }, 30_000);

  it('deduplicates a fixture that appears twice in one payload', async () => {
    const { engine, source } = harness();
    const signal = new AbortController().signal;

    const duplicated = [fixture(1), fixture(2), fixture(1)];

    const stats = await engine.ingest(duplicated, providerServing(0), 'prematch', signal, source);

    expect(stats.fixturesFetched).toBe(2);
    expect(stats.quotesPrepared).toBe(2 * 5);
  }, 30_000);
});
