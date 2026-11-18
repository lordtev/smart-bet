/**
 * Engine flow, against in-memory repositories.
 *
 * These tests pin the guarantees the requirements care most about:
 *
 *   • two providers quoting the same selection never overwrite each other;
 *   • a duplicate response changes nothing;
 *   • an unchanged price is not written;
 *   • an out-of-order response cannot roll a newer price back;
 *   • a provider outage deletes nothing and suspends nothing;
 *   • a market missing from a payload is not treated as removed;
 *   • only the pricing source reaches `selections.odds`.
 *
 * The fake repositories below model the semantics of the real SQL functions
 * (`odds_apply_quotes` / `odds_publish_prices`). The SQL itself is exercised by
 * the integration suite in tests/integration.
 */
import { describe, expect, it, vi } from 'vitest';
import { Engine, type EngineDeps } from '../../src/engine.ts';
import type { CatalogueRepository } from '../../src/db/catalogue.ts';
import type { HealthRepository, OddsSourceRow, QuoteRepository, SourceRepository } from '../../src/db/engine.ts';
import type { QuoteUpsert, ApplyQuotesResult } from '../../src/db/engine.ts';
import type { HttpClientHandle } from '../../src/http/client.ts';
import type { MarketRuleSource } from '../../src/map/market-mapper.ts';
import { createMockProvider } from '../../src/providers/mock.ts';
import type { ProviderAdapter } from '../../src/providers/types.ts';
import { loadConfig } from '../../src/config.ts';
import { silentLogger } from '../../src/logging/logger.ts';

/* ── A tiny in-memory world ─────────────────────────────────────────────── */

type QuoteRow = {
  sourceId: string;
  bookmakerKey: string;
  selectionId: string;
  odds: number;
  status: string;
  providerLine: number | null;
  providerUpdatedAt: string | null;
  lastSeenAt: string;
  lastChangedAt: string;
};

type SelectionRow = {
  id: string;
  marketId: string;
  outcomeKey: string;
  name: string;
  odds: number;
  status: string;
};

class FakeWorld {
  readonly quotes = new Map<string, QuoteRow>();
  readonly selections = new Map<string, SelectionRow>();
  readonly markets = new Map<string, { id: string; eventId: string; canonicalKey: string; status: string }>();
  readonly events = new Map<
    string,
    { id: string; name: string; startsAt: string; homeTeam: string | null; awayTeam: string | null }
  >();
  readonly links = new Map<string, string>();
  readonly history: Array<{ sourceId: string; selectionId: string; odds: number }> = [];
  readonly published: Array<{ selectionId: string; odds: number; status: string }> = [];
  readonly marketTypes = new Map<string, string>([['MATCH_WINNER', '1X2']]);

  applyCalls = 0;
  publishCalls = 0;

  /** Models odds_apply_quotes(). */
  applyQuotes(input: {
    sourceId: string;
    quotes: readonly QuoteUpsert[];
    captureHistory: boolean;
    heartbeatSeconds: number;
  }): ApplyQuotesResult {
    this.applyCalls += 1;
    const now = new Date().toISOString();
    const result: ApplyQuotesResult = {
      received: input.quotes.length,
      accepted: 0,
      invalid: 0,
      touched: 0,
      changed: 0,
      inserted: 0,
      heartbeat: 0,
      skipped: 0,
      stale: 0,
      history: 0,
      applied_at: now,
    };

    for (const quote of input.quotes) {
      const bookmaker = quote.bookmaker_key ?? 'default';
      const key = `${input.sourceId}#${bookmaker}#${quote.selection_id}`;
      const existing = this.quotes.get(key);

      if (!existing) {
        result.accepted += 1;
        result.touched += 1;
        result.changed += 1;
        result.inserted += 1;
        this.quotes.set(key, {
          sourceId: input.sourceId,
          bookmakerKey: bookmaker,
          selectionId: quote.selection_id,
          odds: quote.odds,
          status: quote.status ?? 'open',
          providerLine: quote.provider_line ?? null,
          providerUpdatedAt: quote.provider_updated_at ?? null,
          lastSeenAt: now,
          lastChangedAt: now,
        });
        if (input.captureHistory) {
          this.history.push({ sourceId: input.sourceId, selectionId: quote.selection_id, odds: quote.odds });
          result.history += 1;
        }
        continue;
      }

      // Staleness guard: an older provider timestamp never wins.
      if (
        existing.providerUpdatedAt !== null &&
        quote.provider_updated_at != null &&
        Date.parse(quote.provider_updated_at) < Date.parse(existing.providerUpdatedAt)
      ) {
        result.accepted += 1;
        result.stale += 1;
        result.skipped += 1;
        continue;
      }

      const changed =
        existing.odds !== quote.odds ||
        existing.status !== (quote.status ?? 'open') ||
        existing.providerLine !== (quote.provider_line ?? null);

      result.accepted += 1;

      if (!changed) {
        result.skipped += 1;
        continue;
      }

      result.touched += 1;
      result.changed += 1;
      existing.odds = quote.odds;
      existing.status = quote.status ?? 'open';
      existing.providerLine = quote.provider_line ?? null;
      existing.providerUpdatedAt = quote.provider_updated_at ?? existing.providerUpdatedAt;
      existing.lastChangedAt = now;
      existing.lastSeenAt = now;

      if (input.captureHistory) {
        this.history.push({ sourceId: input.sourceId, selectionId: quote.selection_id, odds: quote.odds });
        result.history += 1;
      }
    }

    return result;
  }

  /** Models odds_publish_prices(). */
  publish(sourceId: string, isPricing: boolean): { prices_updated: number; statuses_updated: number } {
    this.publishCalls += 1;
    if (!isPricing) throw new Error(`source ${sourceId} is not the pricing source`);

    let prices = 0;
    let statuses = 0;

    for (const quote of this.quotes.values()) {
      if (quote.sourceId !== sourceId) continue;
      const selection = this.selections.get(quote.selectionId);
      if (!selection) continue;

      if (quote.status === 'open' && selection.odds !== quote.odds) {
        selection.odds = quote.odds;
        prices += 1;
      }

      const target = quote.status === 'open' ? 'active' : 'suspended';
      if (selection.status !== target) {
        selection.status = target;
        statuses += 1;
      }

      this.published.push({ selectionId: quote.selectionId, odds: selection.odds, status: selection.status });
    }

    return { prices_updated: prices, statuses_updated: statuses };
  }
}

/* ── Wiring ─────────────────────────────────────────────────────────────── */

function buildRules(): MarketRuleSource {
  return {
    listRules: async () => [
      { providerKey: '1X2', canonicalCode: 'MATCH_WINNER', canonicalName: '1X2', period: 'FT', lineType: 'none', outcomeMap: null, reviewStatus: 'mapped' },
      { providerKey: 'OVER_UNDER_2_5', canonicalCode: 'OVER_UNDER', canonicalName: 'Over / Under', period: 'FT', lineType: 'total', outcomeMap: null, reviewStatus: 'mapped' },
      { providerKey: 'OVER_UNDER_1_5', canonicalCode: 'OVER_UNDER', canonicalName: 'Over / Under', period: 'FT', lineType: 'total', outcomeMap: null, reviewStatus: 'mapped' },
      { providerKey: 'BTTS', canonicalCode: 'BTTS', canonicalName: 'Both teams to score', period: 'FT', lineType: 'none', outcomeMap: null, reviewStatus: 'mapped' },
      { providerKey: '1X2_1H', canonicalCode: 'MATCH_WINNER', canonicalName: '1X2', period: 'H1', lineType: 'none', outcomeMap: null, reviewStatus: 'mapped' },
      { providerKey: 'DOUBLE_CHANCE', canonicalCode: 'DOUBLE_CHANCE', canonicalName: 'Double chance', period: 'FT', lineType: 'none', outcomeMap: null, reviewStatus: 'mapped' },
    ],
    recordUnknownMarket: vi.fn(async () => {}),
  };
}

function buildEngine(options: {
  world: FakeWorld;
  pricingSourceKey: string;
  liveInterval?: number;
  provider?: ProviderAdapter;
  dryRun?: boolean;
}): { engine: Engine; source: OddsSourceRow; now: () => Date } {
  const world = options.world;

  const config = loadConfig(
    {
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key_value_1234567890',
      ENABLED_PROVIDERS: 'mock',
      PRICING_PROVIDER: 'mock',
      LIVE_POLL_INTERVAL_MS: '3000',
      PREMECH_INTERVAL_MS: String(options.liveInterval ?? 1_800_000),
      LOG_LEVEL: 'error',
      ODDS_ENV_FALLBACK_FILES: '',
    } as Record<string, string>,
    { dryRun: options.dryRun ?? false },
  );

  const fixedNow = FIXED_NOW;

  const catalogue = {
    refresh: async () => {},
    ensureMarketTypes: async (required: Map<string, string> | Iterable<[string, string]>) => {
      const out = new Map<string, { id: string; code: string; name: string }>();
      for (const [code, name] of required as Iterable<[string, string]>) {
        if (!world.marketTypes.has(code)) world.marketTypes.set(code, name);
        out.set(code, { id: `mt-${code}`, code, name });
      }
      return out;
    },
    findLink: async (sourceId: string, externalKey: string) => {
      const eventId = world.links.get(`${sourceId}#${externalKey}`);
      return eventId ? { eventId, matchMethod: 'linked' } : null;
    },
    findFixtureCandidates: async (input: { from: string; to: string }) => {
      const from = Date.parse(input.from);
      const to = Date.parse(input.to);
      return [...world.events.values()]
        .filter((event) => {
          const start = Date.parse(event.startsAt);
          return start >= from && start <= to;
        })
        .map((event) => ({
          eventId: event.id,
          name: event.name,
          homeTeam: event.homeTeam,
          awayTeam: event.awayTeam,
          startsAt: event.startsAt,
          leagueName: 'Mock League',
          sportName: 'Football',
        }));
    },
    resolveSport: async () => 'sport-1',
    resolveLeague: async () => 'league-1',
    resolveTeam: async (_sportId: string, name: string) => `team-${name}`,
    createEvent: async (input: {
      name: string;
      startsAt: string;
      homeTeamId: string | null;
      awayTeamId: string | null;
    }) => {
      // The real repository resolves teams to ids; the fake turns them back into
      // names so candidate matching can find the event on the next cycle.
      const teamName = (id: string | null): string | null => (id ? id.replace(/^team-/, '') : null);

      const eventId = `event-${world.events.size + 1}`;
      world.events.set(eventId, {
        id: eventId,
        name: input.name,
        startsAt: input.startsAt,
        homeTeam: teamName(input.homeTeamId),
        awayTeam: teamName(input.awayTeamId),
      });
      return eventId;
    },
    updateEventState: async () => {},
    saveLink: async (input: { sourceId: string; externalKey: string; eventId: string }) => {
      world.links.set(`${input.sourceId}#${input.externalKey}`, input.eventId);
    },
    ensureMarkets: async (rows: Array<{ eventId: string; canonicalKey: string; status: string }>) => {
      const out = new Map<string, string>();
      for (const row of rows) {
        const key = `${row.eventId}#${row.canonicalKey}`;
        let market = world.markets.get(key);
        if (!market) {
          market = { id: `market-${world.markets.size + 1}`, eventId: row.eventId, canonicalKey: row.canonicalKey, status: row.status };
          world.markets.set(key, market);
        }
        out.set(key, market.id);
      }
      return out;
    },
    ensureSelections: async (rows: Array<{ marketId: string; outcomeKey: string; name: string; odds: number }>) => {
      const out = new Map<string, string>();
      for (const row of rows) {
        const key = `${row.marketId}#${row.outcomeKey}`;
        let selection = [...world.selections.values()].find((entry) => entry.marketId === row.marketId && entry.outcomeKey === row.outcomeKey);
        if (!selection) {
          selection = {
            id: `selection-${world.selections.size + 1}`,
            marketId: row.marketId,
            outcomeKey: row.outcomeKey,
            name: row.name,
            odds: row.odds,
            status: 'suspended',
          };
          world.selections.set(selection.id, selection);
        }
        out.set(key, selection.id);
      }
      return out;
    },
  } as unknown as CatalogueRepository;

  const currentSource = options.pricingSourceKey;
  const source: OddsSourceRow = {
    id: `source-${currentSource}`,
    key: currentSource,
    name: 'Mock provider',
    kind: 'provider',
    is_enabled: true,
    priority: 10,
    is_pricing_source: currentSource === config.providers.pricingProvider,
    pricing_bookmaker_key: null,
    supports_live: true,
    supports_prematch: true,
    config: {},
  };

  const quotes = {
    applyQuotes: async (input: never) => world.applyQuotes(input),
    publishPrices: async (input: { sourceId: string }) => world.publish(input.sourceId, currentSource === config.providers.pricingProvider),
  } as unknown as QuoteRepository;

  const health = {
    startRun: async () => null,
    recordCycle: async () => {},
    finishRun: async () => {},
  } as unknown as HealthRepository;

  const http = { stats: () => ({ requests: 0, failures: 0, retries: 0, rateLimited: 0 }) } as unknown as HttpClientHandle;

  const rules = buildRules();

  const deps: EngineDeps = {
    config,
    log: silentLogger(),
    db: {} as EngineDeps['db'],
    catalogue,
    sources: {} as SourceRepository,
    quotes,
    health,
    http,
    ruleSourceFor: () => rules,
    now: () => fixedNow,
  };

  return { engine: new Engine(deps), source, now: () => fixedNow };
}

const FIXED_NOW = new Date('2026-09-26T18:00:00.000Z');

function mockProvider(overrides: Parameters<typeof createMockProvider>[0] = {}): ProviderAdapter {
  // Same clock as the engine, so the mock's kickoffs land inside the window.
  return createMockProvider({ fixtureCount: 2, marketsPerFixture: 4, seed: 7, now: () => FIXED_NOW, ...overrides });
}

/* ── Tests ──────────────────────────────────────────────────────────────── */

describe('engine cycle', () => {
  it('creates the catalogue, writes quotes and publishes for the pricing source', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    const stats = await engine.runCycle(mockProvider(), 'prematch', new AbortController().signal, source);

    expect(stats.ok).toBe(true);
    expect(stats.fixturesFetched).toBe(2);
    expect(stats.fixturesCreated).toBe(2);
    expect(stats.quotesPrepared).toBeGreaterThan(0);
    expect(stats.quotesInserted).toBe(stats.quotesPrepared);
    // The selection rows were created suspended and activated by publish: the
    // prices themselves were already correct, so only statuses moved.
    expect(stats.statusesPublished).toBeGreaterThan(0);

    // Every selection the engine created is now bettable, because this source
    // is the pricing source.
    expect([...world.selections.values()].every((selection) => selection.status === 'active')).toBe(true);
  });

  it('writes nothing at all on a dry run', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock', dryRun: true });

    const stats = await engine.runCycle(mockProvider(), 'prematch', new AbortController().signal, source);

    expect(stats.ok).toBe(true);
    expect(stats.dryRun).toBe(true);
    expect(stats.quotesPrepared).toBeGreaterThan(0);
    expect(world.applyCalls).toBe(0);
    expect(world.quotes.size).toBe(0);
    expect(world.events.size).toBe(0);
  });

  it('writes nothing when the same payload arrives twice', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    // Same cycle number → byte-identical payload, exactly like a duplicate poll.
    const provider = mockProvider({ cycle: 3 });
    const first = await engine.runCycle(provider, 'prematch', new AbortController().signal, source);
    expect(first.quotesInserted).toBeGreaterThan(0);

    const afterFirst = world.quotes.size;
    const historyAfterFirst = world.history.length;

    const duplicate = mockProvider({ cycle: 3 });
    const second = await engine.runCycle(duplicate, 'prematch', new AbortController().signal, source);

    expect(second.ok).toBe(true);
    expect(second.quotesChanged).toBe(0);
    expect(second.quotesInserted).toBe(0);
    expect(second.historyRows).toBe(0);
    expect(world.quotes.size).toBe(afterFirst);
    expect(world.history.length).toBe(historyAfterFirst);
  });

  it('writes only the quotes that actually moved', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    await engine.runCycle(mockProvider({ cycle: 1 }), 'prematch', new AbortController().signal, source);
    const second = await engine.runCycle(mockProvider({ cycle: 2 }), 'prematch', new AbortController().signal, source);

    expect(second.ok).toBe(true);
    expect(second.quotesChanged).toBeGreaterThan(0);
    expect(second.quotesChanged).toBeLessThan(second.quotesAccepted);
    expect(second.quotesChanged + second.quotesSkipped).toBe(second.quotesAccepted);
  });

  it('cannot be rolled back by an older provider timestamp', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    const newer = mockProvider({ cycle: 10 });
    await engine.runCycle(newer, 'prematch', new AbortController().signal, source);

    // Replay an older snapshot over the top of it.
    const stale = createMockProvider({
      fixtureCount: 2,
      marketsPerFixture: 4,
      seed: 7,
      cycle: 1,
      now: () => new Date('2026-09-26T17:50:00.000Z'),
    });
    const replay = await engine.runCycle(stale, 'prematch', new AbortController().signal, source);

    expect(replay.ok).toBe(true);
    expect(replay.quotesStale).toBeGreaterThan(0);
    expect(replay.quotesChanged).toBe(0);
  });

  it('keeps two providers’ quotes on the same selection apart', async () => {
    const world = new FakeWorld();
    const first = buildEngine({ world, pricingSourceKey: 'mock' });

    const providerA = mockProvider({ cycle: 5, jitterPct: 0, bookmakers: ['default'] });
    await first.engine.runCycle(providerA, 'prematch', new AbortController().signal, first.source);

    // A second provider, with a different source id, quoting the same fixtures.
    const secondSource: OddsSourceRow = {
      ...first.source,
      id: 'source-second',
      key: 'mock-second',
      is_pricing_source: false,
      priority: 20,
    };

    const providerB = mockProvider({ cycle: 9 });
    const cycleB = await first.engine.runCycle(providerB, 'prematch', new AbortController().signal, secondSource);

    expect(cycleB.ok).toBe(true);
    expect(cycleB.quotesInserted).toBeGreaterThan(0);

    const bySelection = new Map<string, QuoteRow[]>();
    for (const quote of world.quotes.values()) {
      const list = bySelection.get(quote.selectionId) ?? [];
      list.push(quote);
      bySelection.set(quote.selectionId, list);
    }

    // Every selection now carries one row per provider, and neither replaced
    // the other: the two rows are independent keys in the store.
    for (const [, rows] of bySelection) {
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.sourceId)).size).toBe(2);
    }
  });

  it('keeps two bookmakers of the same provider apart', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    const provider = mockProvider({ bookmakers: ['book-a', 'book-b'] });
    await engine.runCycle(provider, 'prematch', new AbortController().signal, source);

    const bookmakers = new Set([...world.quotes.values()].map((quote) => quote.bookmakerKey));
    expect(bookmakers).toEqual(new Set(['book-a', 'book-b']));

    // Same selection, two bookmakers, two rows.
    const firstSelection = world.quotes.values().next().value as QuoteRow;
    const forSelection = [...world.quotes.values()].filter(
      (quote) => quote.selectionId === firstSelection.selectionId,
    );
    expect(forSelection).toHaveLength(2);
  });

  it('does not publish when it is not the pricing source', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    const comparisonSource: OddsSourceRow = { ...source, id: 'source-comparison', key: 'comparison', is_pricing_source: false };
    const stats = await engine.runCycle(mockProvider(), 'prematch', new AbortController().signal, comparisonSource);

    expect(stats.ok).toBe(true);
    expect(stats.pricesPublished).toBe(0);
    expect(world.publishCalls).toBe(0);
    // Quotes are stored for comparison, but nothing became bettable.
    expect(world.quotes.size).toBeGreaterThan(0);
    expect([...world.selections.values()].every((selection) => selection.status === 'suspended')).toBe(true);
  });

  it('survives a provider outage without touching a single quote or status', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    await engine.runCycle(mockProvider({ cycle: 4 }), 'prematch', new AbortController().signal, source);

    const quoteSnapshot = [...world.quotes.values()].map((quote) => ({ ...quote }));
    const selectionSnapshot = [...world.selections.values()].map((selection) => ({ ...selection }));
    const historyCount = world.history.length;

    const failing = mockProvider({ failAlways: 'network' });
    const failed = await engine.runCycle(failing, 'prematch', new AbortController().signal, source);

    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/fail: network/);

    // Nothing deleted, nothing suspended, no history written.
    expect([...world.quotes.values()]).toEqual(quoteSnapshot);
    expect([...world.selections.values()]).toEqual(selectionSnapshot);
    expect(world.history.length).toBe(historyCount);
    expect([...world.selections.values()].every((selection) => selection.status === 'active')).toBe(true);
  });

  it('does not treat a market missing from a payload as removed', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    await engine.runCycle(mockProvider({ cycle: 1, omitMarketsPct: 0 }), 'prematch', new AbortController().signal, source);
    const quoteCount = world.quotes.size;
    const selectionCount = world.selections.size;

    // Now half the markets vanish from the payload.
    const sparse = await engine.runCycle(
      mockProvider({ cycle: 2, omitMarketsPct: 90 }),
      'prematch',
      new AbortController().signal,
      source,
    );

    expect(sparse.ok).toBe(true);
    // Existing quotes are untouched: nothing was deleted, nothing suspended.
    expect(world.quotes.size).toBe(quoteCount);
    expect(world.selections.size).toBe(selectionCount);
    expect([...world.selections.values()].some((selection) => selection.status === 'active')).toBe(true);
  });

  it('mirrors a provider suspension and reopens it afterwards', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    await engine.runCycle(mockProvider({ cycle: 1 }), 'prematch', new AbortController().signal, source);

    // Every market suspended this cycle.
    await engine.runCycle(
      mockProvider({ cycle: 2, seedChangePct: 100 }),
      'prematch',
      new AbortController().signal,
      source,
    );

    expect([...world.selections.values()].some((selection) => selection.status === 'suspended')).toBe(true);

    // And trading reopens.
    await engine.runCycle(mockProvider({ cycle: 3 }), 'prematch', new AbortController().signal, source);

    expect([...world.selections.values()].some((selection) => selection.status === 'active')).toBe(true);
  });

  it('excludes in-play fixtures from the prematch window and vice versa', async () => {
    const world = new FakeWorld();
    const { engine } = buildEngine({ world, pricingSourceKey: 'mock' });

    const liveWindow = engine.windowFor('live');
    const prematchWindow = engine.windowFor('prematch');

    expect(liveWindow.to.getTime()).toBeLessThanOrEqual(prematchWindow.from.getTime());
  });

  it('records no state when a provider returns nothing at all', async () => {
    const world = new FakeWorld();
    const { engine, source } = buildEngine({ world, pricingSourceKey: 'mock' });

    const empty = mockProvider({ fixtureCount: 0 });
    const stats = await engine.runCycle(empty, 'prematch', new AbortController().signal, source);

    expect(stats.ok).toBe(true);
    expect(stats.fixturesFetched).toBe(0);
    expect(world.applyCalls).toBe(0);
    expect(world.publishCalls).toBe(0);
  });
});
