/**
 * Engine repositories
 * ─────────────────────────────────────────────────────────────────────────────
 * The parts of the database the engine owns: odds sources, market-mapping rules,
 * quote ingestion, publication and operational health.
 *
 * Two rules govern this file:
 *
 *  1. HOT PATHS LIVE IN SQL. Quote ingestion and publication are set-based
 *     database functions, not read-modify-write loops. That is what makes
 *     "only write when it changed", "an older response cannot win" and "never
 *     delete a quote that was merely missing from this payload" atomic
 *     guarantees instead of best-effort client logic.
 *
 *  2. OBSERVABILITY NEVER BREAKS THE PIPELINE. Health and run records are
 *     written on a best-effort basis; a failure there is logged and swallowed.
 */

import type { EngineDb } from './client.ts';
import { chunk, dbError, unwrap } from './client.ts';
import type { Logger } from '../logging/logger.ts';
import type { MarketRule, MarketRuleSource, RuleReviewStatus } from '../map/market-mapper.ts';

/* ── Sources ─────────────────────────────────────────────────────────────── */

export type OddsSourceRow = {
  id: string;
  key: string;
  name: string;
  kind: 'provider' | 'bookmaker' | 'aggregate';
  is_enabled: boolean;
  priority: number;
  is_pricing_source: boolean;
  pricing_bookmaker_key: string | null;
  supports_live: boolean;
  supports_prematch: boolean;
  config: Record<string, unknown>;
};

export type SourceSyncInput = {
  key: string;
  name: string;
  kind: OddsSourceRow['kind'];
  isEnabled: boolean;
  priority: number;
  isPricingSource: boolean;
  pricingBookmakerKey: string | null;
  supportsLive: boolean;
  supportsPrematch: boolean;
  config: Record<string, unknown>;
};

export class SourceRepository {
  private readonly db: EngineDb;
  private readonly log: Logger;

  constructor(db: EngineDb, log: Logger) {
    this.db = db;
    this.log = log;
  }

  /**
   * Bring `odds_sources` in line with the engine's configuration.
   *
   * The environment is the single source of truth for enablement: it is what an
   * operator edits. This mirrors the result into the database so that the
   * publish functions and any SQL an analyst runs see the same reality.
   *
   * The pricing flag is cleared on every other row first, so switching the
   * book's price feed can never leave two pricing sources enabled — which a
   * partial unique index would reject anyway, but failing here is clearer.
   */
  async sync(inputs: readonly SourceSyncInput[]): Promise<Map<string, OddsSourceRow>> {
    const pricing = inputs.filter((input) => input.isPricingSource && input.isEnabled);
    if (pricing.length > 1) {
      throw new Error(
        `more than one pricing source was requested (${pricing.map((p) => p.key).join(', ')}) — ` +
          'only one source may publish the book\'s prices',
      );
    }

    // Clear the flag everywhere first; re-set it below for the intended source.
    if (pricing.length === 1) {
      const { error } = await this.db
        .from('odds_sources')
        .update({ is_pricing_source: false })
        .eq('is_pricing_source', true);
      if (error) throw dbError('clear pricing source flags', error);
    }

    for (const input of inputs) {
      const { error } = await this.db.from('odds_sources').upsert(
        {
          key: input.key,
          name: input.name,
          kind: input.kind,
          is_enabled: input.isEnabled,
          priority: input.priority,
          is_pricing_source: input.isPricingSource,
          pricing_bookmaker_key: input.pricingBookmakerKey,
          supports_live: input.supportsLive,
          supports_prematch: input.supportsPrematch,
          config: input.config,
        },
        { onConflict: 'key' },
      );
      if (error) throw dbError(`sync odds source "${input.key}"`, error);
    }

    // Anything not mentioned by this run is disabled, so removing a provider
    // from ENABLED_PROVIDERS really does stop it being treated as live.
    const keep = inputs.map((input) => input.key);
    if (keep.length > 0) {
      const { error } = await this.db.from('odds_sources').update({ is_enabled: false }).not('key', 'in', `(${keep.map((k) => `"${k}"`).join(',')})`);
      if (error) {
        this.log.warn('could not disable unlisted sources', { error: error.message });
      }
    }

    return this.listAll();
  }

  async listAll(): Promise<Map<string, OddsSourceRow>> {
    const { data, error } = await this.db.from('odds_sources').select('*');
    if (error) throw dbError('read odds_sources', error);
    const rows = (data ?? []) as OddsSourceRow[];
    return new Map(rows.map((row) => [row.key, row]));
  }

  async getByKey(key: string): Promise<OddsSourceRow | null> {
    const { data, error } = await this.db.from('odds_sources').select('*').eq('key', key).maybeSingle();
    if (error) throw dbError('read odds source', error);
    return (data as OddsSourceRow | null) ?? null;
  }
}

/* ── Market-mapping rules ────────────────────────────────────────────────── */

type RuleRow = {
  provider_key: string;
  canonical_code: string | null;
  period: string;
  line_type: MarketRule['lineType'];
  outcome_map: Record<string, string> | null;
  review_status: RuleReviewStatus;
  market_types: { name: string | null } | null;
};

export type DatabaseRuleSourceOptions = {
  db: EngineDb;
  sourceId: string;
  /** Display label used when a derived rule is recorded. */
  log: Logger;
  /** How long a rule snapshot may be reused before re-reading. */
  ttlMs?: number;
};

/**
 * Database-backed `MarketRuleSource`.
 *
 * Rules are cached in memory for a short TTL because the mapper asks for them
 * once per fixture: at a thousand fixtures that is a thousand identical reads
 * otherwise. The cache is invalidated as soon as a new rule is written, so a
 * mapping added by an operator is picked up within one cycle.
 */
export class DatabaseRuleSource implements MarketRuleSource {
  private readonly db: EngineDb;
  private readonly sourceId: string;
  private readonly log: Logger;
  private readonly ttlMs: number;

  private cache: MarketRule[] | null = null;
  private loadedAt = 0;
  /** Guards the "no rules at all" warning so it is logged once, not per fixture. */
  private warnedEmpty = false;

  constructor(options: DatabaseRuleSourceOptions) {
    this.db = options.db;
    this.sourceId = options.sourceId;
    this.log = options.log;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  async listRules(): Promise<MarketRule[]> {
    if (this.cache && Date.now() - this.loadedAt < this.ttlMs) return this.cache;

    const { data, error } = await this.db
      .from('odds_market_rules')
      .select('provider_key, canonical_code, period, line_type, outcome_map, review_status, market_types(name)')
      .eq('source_id', this.sourceId);

    if (error) throw dbError('read odds_market_rules', error);

    const rows = (data ?? []) as unknown as RuleRow[];
    this.cache = rows.map((row) => ({
      providerKey: row.provider_key,
      canonicalCode: row.canonical_code,
      canonicalName: row.market_types?.name ?? null,
      period: row.period,
      lineType: row.line_type,
      outcomeMap: row.outcome_map,
      reviewStatus: row.review_status,
    }));
    this.loadedAt = Date.now();

    if (this.cache.length === 0 && !this.warnedEmpty) {
      this.warnedEmpty = true;
      // Nearly always this means the seed migration was never run, not that the
      // provider has no markets. Without it every market would be auto-mapped to
      // an EXT_… code and published under a made-up name, so say so plainly.
      this.log.error(
        'no market rules exist for this source — every market will be auto-mapped. ' +
          'Run supabase/migrations/20260101000800_odds_market_rules.sql.',
        { sourceId: this.sourceId },
      );
    }

    return this.cache;
  }

  /** Force the next read to hit the database. */
  invalidate(): void {
    this.cache = null;
    this.loadedAt = 0;
  }

  async recordUnknownMarket(input: {
    providerKey: string;
    providerMarketKey: string;
    derivedCanonicalCode: string | null;
    autoMapped: boolean;
    sample: unknown;
  }): Promise<void> {
    const { error } = await this.db.from('odds_market_rules').upsert(
      {
        source_id: this.sourceId,
        provider_key: input.providerMarketKey,
        canonical_code: input.derivedCanonicalCode,
        period: 'FT',
        line_type: 'none',
        review_status: input.autoMapped ? 'auto' : 'pending',
        notes: `Unmapped provider market first seen ${new Date().toISOString()}. Sample: ${JSON.stringify(input.sample).slice(0, 500)}`,
      },
      // Never overwrite a rule a human already curated.
      { onConflict: 'source_id,provider_key', ignoreDuplicates: true },
    );

    if (error) {
      this.log.warn('could not record unmapped market', {
        provider: input.providerKey,
        market: input.providerMarketKey,
        error: error.message,
      });
      return;
    }

    this.invalidate();
    this.log.info('unmapped provider market recorded for review', {
      provider: input.providerKey,
      market: input.providerMarketKey,
      derivedCode: input.derivedCanonicalCode,
      autoMapped: input.autoMapped,
    });
  }
}

/* ── Quote ingestion and publication ─────────────────────────────────────── */

export type QuoteUpsert = {
  selection_id: string;
  odds: number;
  bookmaker_key?: string;
  status?: 'open' | 'suspended' | 'closed';
  provider_line?: number | null;
  provider_updated_at?: string | null;
  source_event_key?: string | null;
  source_market_key?: string | null;
  source_selection_key?: string | null;
  payload?: Record<string, unknown> | null;
};

export type ApplyQuotesResult = {
  received: number;
  accepted: number;
  invalid: number;
  touched: number;
  changed: number;
  inserted: number;
  heartbeat: number;
  skipped: number;
  stale: number;
  history: number;
  applied_at: string;
};

export type PublishResult = {
  prices_updated: number;
  statuses_updated: number;
  published_at: string;
};

export class QuoteRepository {
  private readonly db: EngineDb;

  constructor(db: EngineDb) {
    this.db = db;
  }

  /**
   * Ingest one source's quotes atomically.
   *
   * Everything the requirements ask of a write happens inside one statement:
   * out-of-order protection, change detection, heartbeat suppression, history
   * capture rules and per-source isolation. Errors are counted, not thrown, so a
   * single malformed provider field cannot abort a batch.
   */
  async applyQuotes(input: {
    sourceId: string;
    quotes: readonly QuoteUpsert[];
    captureHistory: boolean;
    heartbeatSeconds: number;
    batchSize: number;
  }): Promise<ApplyQuotesResult> {
    const totals: ApplyQuotesResult = {
      received: 0,
      accepted: 0,
      invalid: 0,
      touched: 0,
      changed: 0,
      inserted: 0,
      heartbeat: 0,
      skipped: 0,
      stale: 0,
      history: 0,
      applied_at: new Date().toISOString(),
    };

    for (const batch of chunk(input.quotes, input.batchSize)) {
      const { data, error } = await this.db.rpc('odds_apply_quotes', {
        p_source_id: input.sourceId,
        p_quotes: batch,
        p_capture_history: input.captureHistory,
        p_heartbeat_seconds: input.heartbeatSeconds,
      });

      if (error) throw dbError('odds_apply_quotes', error);

      const result = data as ApplyQuotesResult | null;
      if (!result) continue;

      totals.received += result.received ?? 0;
      totals.accepted += result.accepted ?? 0;
      totals.invalid += result.invalid ?? 0;
      totals.touched += result.touched ?? 0;
      totals.changed += result.changed ?? 0;
      totals.inserted += result.inserted ?? 0;
      totals.heartbeat += result.heartbeat ?? 0;
      totals.skipped += result.skipped ?? 0;
      totals.stale += result.stale ?? 0;
      totals.history += result.history ?? 0;
      totals.applied_at = result.applied_at ?? totals.applied_at;
    }

    return totals;
  }

  /**
   * Publish the pricing source's latest quotes into `selections.odds`.
   *
   * This is the only write in the engine that changes a price a bet can be
   * placed at, which is why it is a separate, explicitly-posted source.
   */
  async publishPrices(input: {
    sourceId: string;
    maxStalenessSeconds: number;
  }): Promise<PublishResult> {
    const { data, error } = await this.db.rpc('odds_publish_prices', {
      p_source_id: input.sourceId,
      p_max_staleness_seconds: input.maxStalenessSeconds,
    });

    if (error) throw dbError('odds_publish_prices', error);
    return (data as PublishResult | null) ?? { prices_updated: 0, statuses_updated: 0, published_at: '' };
  }

  /** Current quotes for one source, for diagnostics. */
  async snapshot(sourceId: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.db
      .from('odds_quotes')
      .select('bookmaker_key, selection_id, odds, status, provider_updated_at, last_seen_at, last_changed_at')
      .eq('source_id', sourceId)
      .order('last_changed_at', { ascending: false })
      .limit(limit);
    if (error) throw dbError('read odds_quotes', error);
    return (data ?? []) as Array<Record<string, unknown>>;
  }
}

/* ── Health and run records (best effort) ────────────────────────────────── */

export type CycleHealth = {
  sourceId: string;
  worker: string;
  ok: boolean;
  error?: string | null;
  fixturesSeen: number;
  quotesSeen: number;
  quotesChanged: number;
  requests: number;
  failures: number;
  rateLimited: number;
  quotaRemaining: number | null;
  quotaUsed: number | null;
};

export class HealthRepository {
  private readonly db: EngineDb;
  private readonly log: Logger;

  constructor(db: EngineDb, log: Logger) {
    this.db = db;
    this.log = log;
  }

  /**
   * Upsert one (source, worker) health row.
   * Counters are accumulated with a read-modify-write: a lost increment in a
   * metric is acceptable, a broken pipeline is not.
   */
  async recordCycle(health: CycleHealth, now: Date = new Date()): Promise<void> {
    try {
      const { data } = await this.db
        .from('odds_source_health')
        .select('*')
        .eq('source_id', health.sourceId)
        .eq('worker', health.worker)
        .maybeSingle();

      const previous = (data ?? null) as
        | {
            consecutive_failures: number;
            total_requests: number;
            total_failures: number;
            fixtures_seen: number;
            quotes_seen: number;
            quotes_changed: number;
            last_success_at: string | null;
            stale_since: string | null;
          }
        | null;

      const iso = now.toISOString();
      const consecutiveFailures = health.ok ? 0 : (previous?.consecutive_failures ?? 0) + 1;

      const { error } = await this.db.from('odds_source_health').upsert(
        {
          source_id: health.sourceId,
          worker: health.worker,
          last_attempt_at: iso,
          last_success_at: health.ok ? iso : (previous?.last_success_at ?? null),
          last_error_at: health.ok ? undefined : iso,
          last_error: health.ok ? null : (health.error ?? 'unknown error').slice(0, 2000),
          consecutive_failures: consecutiveFailures,
          total_requests: (previous?.total_requests ?? 0) + health.requests,
          total_failures: (previous?.total_failures ?? 0) + health.failures,
          fixtures_seen: (previous?.fixtures_seen ?? 0) + health.fixturesSeen,
          quotes_seen: (previous?.quotes_seen ?? 0) + health.quotesSeen,
          quotes_changed: (previous?.quotes_changed ?? 0) + health.quotesChanged,
          stale_since: health.ok ? null : (previous?.stale_since ?? iso),
          rate_limited_until: health.rateLimited > 0 ? iso : undefined,
          quota_remaining: health.quotaRemaining,
          quota_used: health.quotaUsed,
          updated_at: iso,
        },
        { onConflict: 'source_id,worker' },
      );

      if (error) this.log.warn('could not record health', { error: error.message });
    } catch (error) {
      this.log.warn('could not record health', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async startRun(input: { sourceId: string | null; worker: string }): Promise<number | null> {
    try {
      const { data, error } = await this.db
        .from('odds_worker_runs')
        .insert({ source_id: input.sourceId, worker: input.worker, status: 'running' })
        .select('id')
        .single();
      if (error) {
        this.log.debug('could not open run record', { error: error.message });
        return null;
      }
      return (data as { id: number }).id;
    } catch {
      return null;
    }
  }

  async finishRun(input: {
    runId: number | null;
    status: 'succeeded' | 'failed' | 'aborted';
    stats: Record<string, unknown>;
    error?: string | null;
  }): Promise<void> {
    if (input.runId === null) return;
    try {
      const { error } = await this.db
        .from('odds_worker_runs')
        .update({
          finished_at: new Date().toISOString(),
          status: input.status,
          stats: input.stats,
          error: input.error ? input.error.slice(0, 2000) : null,
        })
        .eq('id', input.runId);
      if (error) this.log.debug('could not close run record', { error: error.message });
    } catch {
      /* observability only */
    }
  }

  /** Everything an operator needs for a health check. */
  async snapshot(): Promise<{
    sources: unknown[];
    health: unknown[];
    staleQuotes: number;
    unmappedMarkets: number;
  }> {
    const [sources, health, unmapped] = await Promise.all([
      this.db.from('odds_sources').select('key, kind, is_enabled, is_pricing_source, pricing_bookmaker_key, priority'),
      this.db.from('odds_source_health').select('*').order('updated_at', { ascending: false }).limit(50),
      this.db
        .from('odds_market_rules')
        .select('provider_key', { count: 'exact', head: true })
        .in('review_status', ['pending', 'auto']),
    ]);

    const staleThreshold = new Date(Date.now() - 5 * 60_000).toISOString();
    const stale = await this.db
      .from('odds_quotes')
      .select('id', { count: 'exact', head: true })
      .lt('last_seen_at', staleThreshold);

    return {
      sources: unwrap('read sources', sources),
      health: unwrap('read health', health),
      staleQuotes: stale.count ?? 0,
      unmappedMarkets: unmapped.count ?? 0,
    };
  }
}
