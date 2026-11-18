/**
 * Engine - the provider-independent core
 * -----------------------------------------------------------------------------
 * One "cycle" is: fetch a window of fixtures from one provider, make sure the
 * catalogue rows exist, turn the provider's markets into canonical markets, and
 * hand the resulting quotes to the database. If the provider happens to be the
 * pricing source, publish at the end.
 *
 * The shape of a cycle is deliberate:
 *
 *   â”Œ- A - network --------------------------------------------------------â”
 *   - fetch fixtures (the only slow, fallible, provider-specific step)     -
 *   â”œ- B - pure -----------------------------------------------------------â”¤
 *   - map provider markets -> canonical markets (rules come from the DB)    -
 *   â”œ- C - database -------------------------------------------------------â”¤
 *   - market types -> fixture links/events -> markets -> selections, batched  -
 *   - ...and the selection ids come back, which is what makes quotes possible -
 *   â”œ- D - one statement --------------------------------------------------â”¤
 *   - odds_apply_quotes(): change detection, staleness guard, history      -
 *   â”œ- E - one statement --------------------------------------------------â”¤
 *   - odds_publish_prices(): only for the pricing source                   -
 *   â””----------------------------------------------------------------------â”˜
 *
 * Everything from B onwards is identical for every provider. A provider failure
 * at step A aborts only that provider's cycle and touches nothing else: no
 * deletes, no suspensions, no stale price overwritten by a fresher one lost.
 */

import type { Config } from './config.ts';
import type { EngineDb } from './db/client.ts';
import type { CatalogueRepository, MarketUpsert, SelectionUpsert } from './db/catalogue.ts';
import type {
  HealthRepository,
  OddsSourceRow,
  QuoteRepository,
  QuoteUpsert,
  SourceRepository,
} from './db/engine.ts';
import type { HttpClientHandle } from './http/client.ts';
import { mapWithConcurrency } from './http/rate-limiter.ts';
import type { Logger } from './logging/logger.ts';
import { mapFixture, type MappedFixture, type MarketRuleSource } from './map/market-mapper.ts';
import { fixtureDisplayName, resolveFixture, type FixtureLinkStore, type MatchMethod } from './match/matcher.ts';
import { normalizeEventStatus } from './normalize/odds.ts';
import type { FetchWindow, NormalizedFixture, ProviderAdapter } from './providers/types.ts';

export type CycleMode = 'live' | 'prematch';

export type CycleStats = {
  provider: string;
  mode: CycleMode;
  sourceKey: string;
  fixturesFetched: number;
  fixturesResolved: number;
  fixturesCreated: number;
  fixturesFailed: number;
  providerMarkets: number;
  canonicalMarkets: number;
  outcomesIn: number;
  outcomesOut: number;
  rejectedPrices: number;
  unknownMarkets: number;
  quotesPrepared: number;
  quotesAccepted: number;
  quotesChanged: number;
  quotesInserted: number;
  quotesSkipped: number;
  quotesStale: number;
  historyRows: number;
  invalidQuotes: number;
  pricesPublished: number;
  statusesPublished: number;
  eventStateUpdates: number;
  dryRun: boolean;
  ok: boolean;
  error: string | null;
  durationMs: number;
};

export type EngineDeps = {
  config: Config;
  log: Logger;
  db: EngineDb;
  catalogue: CatalogueRepository;
  sources: SourceRepository;
  quotes: QuoteRepository;
  health: HealthRepository;
  http: HttpClientHandle;
  ruleSourceFor: (sourceId: string, providerKey: string) => MarketRuleSource;
  now?: () => Date;
};

/** A fixture as fetched, paired with its canonical mapping. */
type FixtureWork = {
  fixture: NormalizedFixture;
  mapped: MappedFixture;
  eventId: string | null;
};

/** How often an already-known live event's score/minute is rewritten, at most. */
const EVENT_STATE_REFRESH_MS = 60_000;

export class Engine {
  private readonly deps: EngineDeps;
  private readonly log: Logger;
  private readonly now: () => Date;

  /** Last time we wrote live state for an event, and what we wrote. */
  private readonly eventStateCache = new Map<string, { at: number; fingerprint: string }>();

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
  }

  /* -- Window -------------------------------------------------------------- */

  /**
   * The time range a cycle covers.
   *
   * `live` looks backwards (in-play fixtures have already started) and stops at
   * "now"; `prematch` starts at "now". Keeping them disjoint means the two
   * workers never fetch the same fixture and never fight over its price.
   */
  windowFor(mode: CycleMode): FetchWindow {
    const { polling } = this.deps.config;
    const nowMs = this.now().getTime();

    if (mode === 'live') {
      return {
        mode,
        from: new Date(nowMs - polling.liveLookaheadMinutes * 60_000),
        to: new Date(nowMs),
        limit: polling.liveMaxFixtures,
      };
    }

    return {
      mode,
      from: new Date(nowMs),
      to: new Date(nowMs + polling.prematchLookaheadMinutes * 60_000),
      limit: polling.prematchMaxFixtures,
    };
  }

  /* -- One provider, one cycle --------------------------------------------- */

  /** A fresh, all-zero stats record for one provider/mode pair. */
  private newStats(provider: ProviderAdapter, mode: CycleMode, source: OddsSourceRow): CycleStats {
    return {
      provider: provider.key,
      mode,
      sourceKey: source.key,
      fixturesFetched: 0,
      fixturesResolved: 0,
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
      dryRun: this.deps.config.runtime.dryRun,
      ok: false,
      error: null,
      durationMs: 0,
    };
  }

  /**
   * A polled cycle: fetch a window, then ingest it.
   *
   * The only provider-specific step is the fetch. Everything after it is
   * `ingest()`, which is shared with push delivery.
   */
  async runCycle(
    provider: ProviderAdapter,
    mode: CycleMode,
    signal: AbortSignal,
    source: OddsSourceRow,
  ): Promise<CycleStats> {
    const startedAt = this.now().getTime();
    const stats = this.newStats(provider, mode, source);
    const cycleLog = this.log.child({ provider: provider.key, worker: mode });

    let fixtures: NormalizedFixture[];
    try {
      const window = this.windowFor(mode);
      const rawFixtures = await provider.fetchFixtures(window, {
        log: cycleLog,
        signal,
        http: this.deps.http,
        now: this.now,
      });

      fixtures = dedupeFixtures(rawFixtures);

      cycleLog.info('cycle fetched', {
        fixtures: fixtures.length,
        windowFrom: window.from.toISOString(),
        windowTo: window.to.toISOString(),
        quotaRemaining: provider.getUsage().quotaRemaining ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await this.finish(stats, provider, source, signal, cycleLog, startedAt, message, null);
    }

    return this.ingest(fixtures, provider, mode, signal, source, stats, startedAt);
  }

  /**
   * Ingest an already-received payload.
   *
   * Public because a push provider (WebSocket or webhook) delivers payloads on
   * its own schedule. Everything after the fetch is shared: the same mapping,
   * change detection, staleness guard and publication. That is the only way
   * "push" can be trusted not to become a second, subtly different write path.
   */
  async ingest(
    rawFixtures: readonly NormalizedFixture[],
    provider: ProviderAdapter,
    mode: CycleMode,
    signal: AbortSignal,
    source: OddsSourceRow,
    existingStats?: CycleStats,
    existingStartedAt?: number,
  ): Promise<CycleStats> {
    const startedAt = existingStartedAt ?? this.now().getTime();
    const stats = existingStats ?? this.newStats(provider, mode, source);
    const { config } = this.deps;
    const dryRun = config.runtime.dryRun;

    const fixtures = dedupeFixtures(rawFixtures);
    stats.fixturesFetched += fixtures.length;

    const cycleLog = this.log.child({ provider: provider.key, worker: mode });
    const runId = dryRun ? null : await this.deps.health.startRun({ sourceId: source.id, worker: mode });

    try {
      if (signal.aborted) throw new Error('aborted');

      if (fixtures.length === 0) {
        // A legitimate outcome: no live games, or the provider's quota guard
        // held us back. Nothing is written, so nothing can regress.
        return await this.finish(stats, provider, source, signal, cycleLog, startedAt, null, runId);
      }

      // -- B. Map ------------------------------------------------------------
      const ruleSource = this.deps.ruleSourceFor(source.id, provider.key);
      const work = await this.mapAll(fixtures, ruleSource, provider.key, stats, cycleLog);

      if (work.length === 0) {
        cycleLog.warn('no fixture produced a canonical market', { fixtures: fixtures.length });
        return await this.finish(stats, provider, source, signal, cycleLog, startedAt, null, runId);
      }

      // -- C. Catalogue + quote rows -----------------------------------------
      const quotes = dryRun
        ? this.dryRunQuotes(work)
        : await this.syncCatalogue(work, source, stats, cycleLog, signal);

      stats.quotesPrepared += quotes.length;

      // -- D. Apply ----------------------------------------------------------
      if (!dryRun && quotes.length > 0) {
        const applied = await this.deps.quotes.applyQuotes({
          sourceId: source.id,
          quotes,
          captureHistory: config.history.enabled,
          heartbeatSeconds: config.changeDetection.heartbeatSeconds,
          batchSize: config.http.writeBatchSize,
        });

        stats.quotesAccepted += applied.accepted;
        stats.quotesChanged += applied.changed;
        stats.quotesInserted += applied.inserted;
        stats.quotesSkipped += applied.skipped;
        stats.quotesStale += applied.stale;
        stats.historyRows += applied.history;
        stats.invalidQuotes += applied.invalid;
      }

      // -- E. Publish (pricing source only) ----------------------------------
      if (!dryRun && source.is_pricing_source) {
        const published = await this.deps.quotes.publishPrices({
          sourceId: source.id,
          maxStalenessSeconds: config.changeDetection.publishMaxStalenessSeconds,
        });
        stats.pricesPublished += published.prices_updated;
        stats.statusesPublished += published.statuses_updated;
      }

      return await this.finish(stats, provider, source, signal, cycleLog, startedAt, null, runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return await this.finish(stats, provider, source, signal, cycleLog, startedAt, message, runId);
    }
  }

  /** Close out a cycle: stats, logging, health and the run record. */
  private async finish(
    stats: CycleStats,
    provider: ProviderAdapter,
    source: OddsSourceRow,
    signal: AbortSignal,
    cycleLog: Logger,
    startedAt: number,
    error: string | null,
    runId: number | null,
  ): Promise<CycleStats> {
    stats.durationMs = this.now().getTime() - startedAt;
    stats.error = error;
    stats.ok = error === null && !signal.aborted;

    const summary = {
      fixtures: stats.fixturesFetched,
      resolved: stats.fixturesResolved,
      created: stats.fixturesCreated,
      failed: stats.fixturesFailed,
      markets: stats.canonicalMarkets,
      quotes: stats.quotesAccepted,
      prepared: stats.quotesPrepared,
      changed: stats.quotesChanged,
      inserted: stats.quotesInserted,
      skipped: stats.quotesSkipped,
      stale: stats.quotesStale,
      history: stats.historyRows,
      invalid: stats.invalidQuotes,
      published: stats.pricesPublished,
      statuses: stats.statusesPublished,
      unknownMarkets: stats.unknownMarkets,
      rejectedPrices: stats.rejectedPrices,
      durationMs: stats.durationMs,
    };

    if (error) {
      cycleLog.error('cycle failed', { error, durationMs: stats.durationMs });
    } else {
      cycleLog.info('cycle complete', summary);
    }

    if (!stats.dryRun) {
      const usage = provider.getUsage();
      const httpStats = this.deps.http.stats();

      await this.deps.health.recordCycle(
        {
          sourceId: source.id,
          worker: stats.mode,
          ok: stats.ok,
          error,
          fixturesSeen: stats.fixturesFetched,
          quotesSeen: stats.quotesAccepted,
          quotesChanged: stats.quotesChanged,
          requests: httpStats.requests,
          failures: httpStats.failures,
          rateLimited: httpStats.rateLimited,
          quotaRemaining: usage.quotaRemaining ?? null,
          quotaUsed: usage.quotaUsed ?? null,
        },
        this.now(),
      );

      await this.deps.health.finishRun({
        runId,
        status: signal.aborted ? 'aborted' : stats.ok ? 'succeeded' : 'failed',
        stats: { ...summary, provider: provider.key, mode: stats.mode },
        error,
      });
    }

    return stats;
  }

  /* -- Mapping (step B) ---------------------------------------------------- */

  private async mapAll(
    fixtures: readonly NormalizedFixture[],
    ruleSource: MarketRuleSource,
    providerKey: string,
    stats: CycleStats,
    log: Logger,
  ): Promise<FixtureWork[]> {
    const out: FixtureWork[] = [];

    for (const fixture of fixtures) {
      try {
        const mapped = await mapFixture({
          fixture,
          ruleSource,
          providerKey,
          options: {
            oddsFormat: 'decimal',
            autoMapUnknownMarkets: this.deps.config.mapping.autoMapUnknownMarkets,
          },
        });

        stats.providerMarkets += mapped.stats.providerMarkets;
        stats.canonicalMarkets += mapped.stats.canonicalMarkets;
        stats.outcomesIn += mapped.stats.outcomesIn;
        stats.outcomesOut += mapped.stats.outcomesOut;
        stats.rejectedPrices += mapped.stats.rejectedPrices;
        stats.unknownMarkets += mapped.stats.unknownMarkets.length;

        if (mapped.markets.length === 0) {
          log.debug('fixture produced no canonical markets', {
            fixture: fixture.sourceEventKey,
            unmapped: mapped.stats.unknownMarkets.slice(0, 5),
          });
          continue;
        }

        out.push({ fixture, mapped, eventId: null });
      } catch (error) {
        // One fixture failing to map must not cost every other fixture its cycle.
        log.warn('could not map fixture', {
          fixture: fixture.sourceEventKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return out;
  }

  /* -- Catalogue (step C) -------------------------------------------------- */

  private async syncCatalogue(
    work: FixtureWork[],
    source: OddsSourceRow,
    stats: CycleStats,
    log: Logger,
    signal: AbortSignal,
  ): Promise<QuoteUpsert[]> {
    const { catalogue, config } = this.deps;

    await catalogue.refresh();

    // 1. Market types the mapper asked for. Created once, in a single call,
    //    before any market row can reference them.
    const requiredTypes = new Map<string, string>();
    for (const item of work) {
      for (const [code, name] of item.mapped.requiredMarketTypes) requiredTypes.set(code, name);
    }
    const marketTypes = await catalogue.ensureMarketTypes(requiredTypes, {
      autoCreate: config.mapping.autoCreateMarketTypes,
    });

    // 2. Fixture identity: an existing link, a heuristic match, or a new event.
    //    Concurrent because each is an independent round trip; isolated because
    //    one bad fixture must not stop the rest.
    const store = this.linkStore(source);
    const resolved = await mapWithConcurrency(work, config.polling.concurrency, async (item) => {
      if (signal.aborted) throw new Error('aborted');
      return resolveFixture({
        subject: {
          externalKey: item.fixture.sourceEventKey,
          name: fixtureDisplayName(item.fixture.homeTeam, item.fixture.awayTeam, item.fixture.name),
          commenceTime: item.fixture.commenceTime,
          homeTeam: item.fixture.homeTeam,
          awayTeam: item.fixture.awayTeam,
          sportName: item.fixture.sportName,
          sportKey: item.fixture.sportKey,
          competitionTitle: item.fixture.competitionTitle,
          countryCode: item.fixture.countryCode,
          metadata: {
            sportKey: item.fixture.sportKey,
            competition: item.fixture.competitionTitle,
            homeTeam: item.fixture.homeTeam,
            awayTeam: item.fixture.awayTeam,
          },
        },
        store,
        windowHours: config.mapping.fixtureMatchWindowHours,
      });
    });

    for (const [index, result] of resolved.entries()) {
      const item = work[index];
      if (!item) continue;

      if (!result.ok) {
        stats.fixturesFailed += 1;
        log.warn('could not resolve fixture', {
          fixture: item.fixture.sourceEventKey,
          error: result.error instanceof Error ? result.error.message : String(result.error),
        });
        continue;
      }

      item.eventId = result.value.eventId;
      stats.fixturesResolved += 1;
      if (result.value.created) stats.fixturesCreated += 1;
    }

    const withEvent = work.filter((item): item is FixtureWork & { eventId: string } => item.eventId !== null);
    if (withEvent.length === 0) return [];

    // 3. Markets, in one batched pass.
    const marketRows: MarketUpsert[] = [];
    for (const item of withEvent) {
      for (const book of item.mapped.markets) {
        for (const market of book.markets) {
          const type = marketTypes.get(market.canonicalCode);
          if (!type) {
            log.debug('canonical market type unavailable, skipping market', {
              code: market.canonicalCode,
              fixture: item.fixture.sourceEventKey,
            });
            continue;
          }

          marketRows.push({
            eventId: item.eventId,
            marketTypeId: type.id,
            name: market.name,
            line: market.line,
            status: toDbMarketStatus(market.status),
            isLive: item.fixture.isLive,
            period: market.period,
            canonicalKey: market.canonicalKey,
          });
        }
      }
    }

    if (marketRows.length === 0) return [];

    const marketIds = await catalogue.ensureMarkets(marketRows);

    // 4. Selections, in one batched pass.
    const selectionRows: SelectionUpsert[] = [];
    for (const item of withEvent) {
      for (const book of item.mapped.markets) {
        for (const market of book.markets) {
          const marketId = marketIds.get(`${item.eventId}#${market.canonicalKey}`);
          if (!marketId) continue;

          market.outcomes.forEach((outcome, index) => {
            selectionRows.push({
              marketId,
              outcomeKey: outcome.outcomeKey,
              name: outcome.name,
              odds: outcome.price,
              sortOrder: index,
            });
          });
        }
      }
    }

    const selectionIds = selectionRows.length > 0 ? await catalogue.ensureSelections(selectionRows) : new Map<string, string>();

    // 5. Live event state, throttled: rewriting every live fixture's score and
    //    minute on every 3-second cycle is write amplification nobody asked for.
    if (source.is_pricing_source) {
      await this.refreshEventState(withEvent, stats, log);
    }

    // 6. Quote rows, now that every id is known.
    const quotes: QuoteUpsert[] = [];
    const seen = new Set<string>();

    for (const item of withEvent) {
      for (const book of item.mapped.markets) {
        for (const market of book.markets) {
          const marketId = marketIds.get(`${item.eventId}#${market.canonicalKey}`);
          if (!marketId) continue;

          for (const outcome of market.outcomes) {
            const selectionId = selectionIds.get(`${marketId}#${outcome.outcomeKey}`);
            if (!selectionId) continue;

            const dedupeKey = `${book.bookmakerKey}#${selectionId}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            quotes.push({
              selection_id: selectionId,
              odds: outcome.price,
              bookmaker_key: book.bookmakerKey,
              status: outcome.status,
              provider_line: market.line,
              provider_updated_at: market.providerUpdatedAt,
              source_event_key: item.fixture.sourceEventKey,
              source_market_key: market.sourceMarketKey,
              source_selection_key: outcome.sourceKey,
              payload: {
                canonical_market: market.canonicalKey,
                canonical_outcome: outcome.outcomeKey,
                period: market.period,
                market_status: market.status,
              },
            });
          }
        }
      }
    }

    return quotes;
  }

  private async refreshEventState(
    work: ReadonlyArray<FixtureWork & { eventId: string }>,
    stats: CycleStats,
    log: Logger,
  ): Promise<void> {
    for (const item of work) {
      const { fixture, eventId } = item;
      const status = normalizeEventStatus(undefined, fixture.isLive);
      if (status !== 'live') continue;

      const fingerprint = `${status}:${fixture.homeScore}:${fixture.awayScore}:${fixture.minute}`;
      const previous = this.eventStateCache.get(eventId);
      const at = this.now().getTime();

      if (previous && previous.fingerprint === fingerprint && at - previous.at < EVENT_STATE_REFRESH_MS) continue;

      try {
        await this.deps.catalogue.updateEventState({
          eventId,
          status,
          homeScore: fixture.homeScore,
          awayScore: fixture.awayScore,
          isLive: fixture.isLive,
          minute: fixture.minute,
        });
        this.eventStateCache.set(eventId, { at, fingerprint });
        stats.eventStateUpdates += 1;
      } catch (error) {
        log.debug('could not update event state', {
          eventId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Dry run: report what would be written, without touching the database. */
  private dryRunQuotes(work: readonly FixtureWork[]): QuoteUpsert[] {
    const quotes: QuoteUpsert[] = [];
    for (const item of work) {
      for (const book of item.mapped.markets) {
        for (const market of book.markets) {
          for (const outcome of market.outcomes) {
            quotes.push({
              // A dry run has no selection ids by definition; the placeholder is
              // never sent anywhere.
              selection_id: '00000000-0000-0000-0000-000000000000',
              odds: outcome.price,
              bookmaker_key: book.bookmakerKey,
              status: outcome.status,
              provider_line: market.line,
              provider_updated_at: market.providerUpdatedAt,
              source_event_key: item.fixture.sourceEventKey,
              source_market_key: market.sourceMarketKey,
              source_selection_key: outcome.sourceKey,
            });
          }
        }
      }
    }
    return quotes;
  }

  /* -- Provider fixture links ---------------------------------------------- */

  private linkStore(source: OddsSourceRow): FixtureLinkStore {
    const { catalogue } = this.deps;

    return {
      findLink: async (externalKey: string) => {
        const link = await catalogue.findLink(source.id, externalKey);
        if (!link) return null;
        return { eventId: link.eventId, matchMethod: link.matchMethod as MatchMethod };
      },

      findCandidates: async ({ from, to }) => catalogue.findFixtureCandidates({ from, to }),

      createEvent: async (input) => {
        const sportId = await catalogue.resolveSport(input.sportName);
        const leagueId = await catalogue.resolveLeague({
          sportId,
          name: input.competitionTitle ?? input.sportName,
          countryCode: input.countryCode,
        });

        const homeTeamId = input.homeTeam ? await catalogue.resolveTeam(sportId, input.homeTeam) : null;
        const awayTeamId = input.awayTeam ? await catalogue.resolveTeam(sportId, input.awayTeam) : null;

        return catalogue.createEvent({
          leagueId,
          homeTeamId,
          awayTeamId,
          name: input.name,
          startsAt: input.commenceTime,
          status: 'scheduled',
          isLive: false,
          homeScore: null,
          awayScore: null,
          minute: null,
        });
      },

      saveLink: async (input) =>
        catalogue.saveLink({
          sourceId: source.id,
          externalKey: input.externalKey,
          eventId: input.eventId,
          matchMethod: input.matchMethod,
          confidence: input.confidence,
          metadata: input.metadata,
        }),
    };
  }
}

/* -- Helpers --------------------------------------------------------------- */

function toDbMarketStatus(status: 'open' | 'suspended' | 'closed'): string {
  return status;
}

function dedupeFixtures(fixtures: readonly NormalizedFixture[]): NormalizedFixture[] {
  const byKey = new Map<string, NormalizedFixture>();

  for (const fixture of fixtures) {
    const existing = byKey.get(fixture.sourceEventKey);
    if (!existing) {
      byKey.set(fixture.sourceEventKey, fixture);
      continue;
    }
    // The same fixture twice in one payload: merge books, first wins, so a
    // duplicate cannot silently replace a price that arrived earlier.
    for (const book of fixture.books) {
      if (!existing.books.some((entry) => entry.bookmakerKey === book.bookmakerKey)) {
        existing.books.push(book);
      }
    }
  }

  return [...byKey.values()];
}
