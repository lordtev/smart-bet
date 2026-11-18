/**
 * Catalogue repository
 * ─────────────────────────────────────────────────────────────────────────────
 * Writes the provider-neutral catalogue: sports, leagues, teams, events,
 * markets and selections. Everything here is create-or-adopt, never
 * overwrite-existing:
 *
 *  • A sport/league/team is looked up by its natural unique key and only
 *    inserted when genuinely missing.
 *  • `events.external_id` is left NULL. It is globally UNIQUE and already
 *    occupied by the demo rows, so provider identity lives in
 *    `odds_source_links` instead — which also lets two providers own the same
 *    fixture.
 *  • New selections are inserted `suspended`. `selections.odds` drives betting,
 *    so a price only becomes bettable through `odds_publish_prices()` for the
 *    pricing source. A comparison provider can therefore add markets without
 *    ever making a price bettable.
 *  • Existing rows are never updated here. Prices and statuses belong to the
 *    publish step, which knows which source is allowed to set them.
 *
 * The in-memory cache matters: resolving a sport/league/team per fixture would
 * mean three round trips per fixture, which at thousands of fixtures is the
 * difference between a 3-second cycle and a minute-long one.
 */

import type { EngineDb } from './client.ts';
import { chunk, dbError, unwrap } from './client.ts';
import { slug } from '../normalize/canonical.ts';
import type { FixtureCandidate } from '../match/matcher.ts';

type SportRow = { id: string; name: string; slug: string };
type LeagueRow = { id: string; sport_id: string; name: string; slug: string };
type TeamRow = { id: string; sport_id: string; name: string };
type MarketTypeRow = { id: string; code: string; name: string };

export type CatalogueCacheOptions = {
  /** How long the sports/leagues/teams snapshot may be reused. */
  ttlMs?: number;
  writeBatchSize: number;
};

export type ResolvedMarketType = { id: string; code: string; name: string };

/** One canonical market to create if it does not exist yet. */
export type MarketUpsert = {
  eventId: string;
  marketTypeId: string;
  name: string;
  line: number | null;
  status: string;
  isLive: boolean;
  period: string;
  canonicalKey: string;
};

/** One selection (outcome) to create if it does not exist yet. */
export type SelectionUpsert = {
  marketId: string;
  outcomeKey: string;
  name: string;
  odds: number;
  sortOrder: number;
};

export class CatalogueRepository {
  private readonly db: EngineDb;
  private readonly ttlMs: number;
  private readonly writeBatchSize: number;

  private loadedAt = 0;
  private sports = new Map<string, SportRow>(); // key: slug
  private leagues = new Map<string, LeagueRow>(); // key: `${sport_id}:${slug}`
  private teams = new Map<string, TeamRow>(); // key: `${sport_id}:${name}`
  private marketTypes = new Map<string, MarketTypeRow>(); // key: code

  constructor(db: EngineDb, options: CatalogueCacheOptions) {
    this.db = db;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.writeBatchSize = options.writeBatchSize;
  }

  /* ── Cache ─────────────────────────────────────────────────────────────── */

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.loadedAt < this.ttlMs && this.sports.size > 0) return;

    const [sports, leagues, teams, types] = await Promise.all([
      this.db.from('sports').select('id, name, slug'),
      this.db.from('leagues').select('id, sport_id, name, slug'),
      this.db.from('teams').select('id, sport_id, name'),
      this.db.from('market_types').select('id, code, name'),
    ]);

    this.sports = new Map((unwrap('read sports', sports) as SportRow[]).map((row) => [row.slug, row]));
    this.leagues = new Map(
      (unwrap('read leagues', leagues) as LeagueRow[]).map((row) => [`${row.sport_id}:${row.slug}`, row]),
    );
    this.teams = new Map((unwrap('read teams', teams) as TeamRow[]).map((row) => [`${row.sport_id}:${row.name}`, row]));
    this.marketTypes = new Map((unwrap('read market_types', types) as MarketTypeRow[]).map((row) => [row.code, row]));

    this.loadedAt = Date.now();
  }

  /** Forget the snapshot so the next cycle re-reads it. */
  invalidate(): void {
    this.loadedAt = 0;
  }

  /* ── Sports / leagues / teams ──────────────────────────────────────────── */

  async resolveSport(sportName: string): Promise<string> {
    const sportSlug = slug(sportName);
    const cached = this.sports.get(sportSlug);
    if (cached) return cached.id;

    const inserted = await this.db
      .from('sports')
      .upsert(
        { name: sportName, slug: sportSlug, is_active: true, sort_order: 0 },
        { onConflict: 'slug', ignoreDuplicates: true },
      )
      .select('id, name, slug');

    const rows = unwrap('insert sport', inserted) as SportRow[];
    const row =
      rows[0] ??
      ((await this.db.from('sports').select('id, name, slug').eq('slug', sportSlug).single()).data as SportRow | null);

    if (!row) throw new Error(`could not resolve sport "${sportName}"`);
    this.sports.set(sportSlug, row);
    return row.id;
  }

  async resolveLeague(input: {
    sportId: string;
    name: string;
    countryCode: string | null;
  }): Promise<string> {
    const leagueSlug = slug(input.name) || slug(input.sportId);
    const cacheKey = `${input.sportId}:${leagueSlug}`;
    const cached = this.leagues.get(cacheKey);
    if (cached) return cached.id;

    const inserted = await this.db
      .from('leagues')
      .upsert(
        {
          sport_id: input.sportId,
          name: input.name,
          slug: leagueSlug,
          country_code: input.countryCode,
          is_active: true,
          sort_order: 0,
        },
        { onConflict: 'sport_id,slug', ignoreDuplicates: true },
      )
      .select('id, sport_id, name, slug');

    const rows = unwrap('insert league', inserted) as LeagueRow[];
    let row: LeagueRow | null = rows.length > 0 ? (rows[0] as LeagueRow) : null;

    if (!row) {
      const existing = await this.db
        .from('leagues')
        .select('id, sport_id, name, slug')
        .eq('sport_id', input.sportId)
        .eq('slug', leagueSlug)
        .maybeSingle();
      row = (existing.data as LeagueRow | null) ?? null;
    }

    if (!row) throw new Error(`could not resolve league "${input.name}"`);
    this.leagues.set(cacheKey, row);
    return row.id;
  }

  async resolveTeam(sportId: string, teamName: string): Promise<string> {
    const cacheKey = `${sportId}:${teamName}`;
    const cached = this.teams.get(cacheKey);
    if (cached) return cached.id;

    const inserted = await this.db
      .from('teams')
      .upsert({ sport_id: sportId, name: teamName }, { onConflict: 'sport_id,name', ignoreDuplicates: true })
      .select('id, sport_id, name');

    const rows = unwrap('insert team', inserted) as TeamRow[];
    let row: TeamRow | null = rows.length > 0 ? (rows[0] as TeamRow) : null;

    if (!row) {
      const existing = await this.db
        .from('teams')
        .select('id, sport_id, name')
        .eq('sport_id', sportId)
        .eq('name', teamName)
        .maybeSingle();
      row = (existing.data as TeamRow | null) ?? null;
    }

    if (!row) throw new Error(`could not resolve team "${teamName}"`);
    this.teams.set(cacheKey, row);
    return row.id;
  }

  /* ── Market types ──────────────────────────────────────────────────────── */

  /**
   * Make sure every canonical market code the mapper produced exists in
   * `market_types`. Codes that are already seeded are returned as-is; codes the
   * engine derived for an unmapped provider market are created here and are
   * visible in the review query, so they can later be replaced by a curated
   * mapping without losing data.
   */
  async ensureMarketTypes(
    required: Iterable<[code: string, name: string]>,
    options: { autoCreate: boolean },
  ): Promise<Map<string, ResolvedMarketType>> {
    const wanted = new Map<string, string>();
    for (const [code, name] of required) wanted.set(code, name);

    const missing: Array<{ code: string; name: string }> = [];
    for (const [code, name] of wanted) {
      if (!this.marketTypes.has(code)) missing.push({ code, name });
    }

    if (missing.length > 0 && options.autoCreate) {
      for (const batch of chunk(missing, this.writeBatchSize)) {
        const { error } = await this.db
          .from('market_types')
          .upsert(
            batch.map((row) => ({
              code: row.code,
              name: row.name,
              description: 'Auto-derived by the odds engine from an unmapped provider market.',
            })),
            { onConflict: 'code', ignoreDuplicates: true },
          );
        if (error) throw dbError('insert market_types', error);
      }

      const codes = missing.map((row) => row.code);
      const inserted = await this.db.from('market_types').select('id, code, name').in('code', codes);
      for (const row of unwrap('re-read market_types', inserted) as MarketTypeRow[]) {
        this.marketTypes.set(row.code, row);
      }
    }

    const resolved = new Map<string, ResolvedMarketType>();
    for (const code of wanted.keys()) {
      const row = this.marketTypes.get(code);
      if (row) resolved.set(code, row);
    }
    return resolved;
  }

  getMarketType(code: string): ResolvedMarketType | null {
    return this.marketTypes.get(code) ?? null;
  }

  /* ── Events ────────────────────────────────────────────────────────────── */

  async createEvent(input: {
    leagueId: string;
    homeTeamId: string | null;
    awayTeamId: string | null;
    name: string;
    startsAt: string;
    status: string;
    isLive: boolean;
    homeScore: number | null;
    awayScore: number | null;
    minute: number | null;
  }): Promise<string> {
    const { data, error } = await this.db
      .from('events')
      .insert({
        league_id: input.leagueId,
        home_team_id: input.homeTeamId,
        away_team_id: input.awayTeamId,
        name: input.name,
        starts_at: input.startsAt,
        status: input.status,
        home_score: input.homeScore,
        away_score: input.awayScore,
        result_data: input.isLive ? { minute: input.minute ?? 0 } : {},
        is_featured: false,
        // external_id deliberately left NULL — see the class comment.
      })
      .select('id')
      .single();

    if (error) throw dbError('insert event', error);
    return (data as { id: string }).id;
  }

  /**
   * Candidate events around a kickoff time, with team labels resolved.
   * Used by the fixture matcher; deliberately narrow (a few hours) so this
   * never becomes a full-table scan.
   */
  async findFixtureCandidates(input: { from: string; to: string; limit?: number }): Promise<FixtureCandidate[]> {
    const { data, error } = await this.db
      .from('events')
      .select('id, name, starts_at, home_team_id, away_team_id, leagues(name, sports(name))')
      .gte('starts_at', input.from)
      .lte('starts_at', input.to)
      .limit(input.limit ?? 400);

    if (error) throw dbError('read candidate events', error);

    type Row = {
      id: string;
      name: string;
      starts_at: string;
      home_team_id: string | null;
      away_team_id: string | null;
      leagues: { name: string | null; sports: { name: string | null } | null } | null;
    };

    const rows = (data ?? []) as unknown as Row[];
    const teamIds = [...new Set(rows.flatMap((row) => [row.home_team_id, row.away_team_id]).filter(Boolean))] as string[];

    const teamNames = new Map<string, string>();
    if (teamIds.length > 0) {
      const teams = await this.db.from('teams').select('id, name').in('id', teamIds);
      for (const team of unwrap('read candidate teams', teams) as Array<{ id: string; name: string }>) {
        teamNames.set(team.id, team.name);
      }
    }

    return rows.map((row) => ({
      eventId: row.id,
      name: row.name,
      homeTeam: row.home_team_id ? (teamNames.get(row.home_team_id) ?? null) : null,
      awayTeam: row.away_team_id ? (teamNames.get(row.away_team_id) ?? null) : null,
      startsAt: row.starts_at,
      leagueName: row.leagues?.name ?? null,
      sportName: row.leagues?.sports?.name ?? null,
    }));
  }

  /** Live score / minute / status update for an already-linked event. */
  async updateEventState(input: {
    eventId: string;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    isLive: boolean;
    minute: number | null;
  }): Promise<void> {
    const { error } = await this.db
      .from('events')
      .update({
        status: input.status,
        home_score: input.homeScore,
        away_score: input.awayScore,
        result_data: input.isLive ? { minute: input.minute ?? 0 } : undefined,
      })
      .eq('id', input.eventId);

    // A score update failing must never abort an odds cycle.
    if (error) throw dbError('update event state', error);
  }

  /* ── Markets ───────────────────────────────────────────────────────────── */

  /**
   * Create any missing markets and return the id for every canonical key.
   * Existing rows are left untouched: their price and status belong to the
   * publish step.
   */
  async ensureMarkets(rows: readonly MarketUpsert[]): Promise<Map<string, string>> {
    if (rows.length === 0) return new Map();

    for (const batch of chunk(rows, this.writeBatchSize)) {
      const { error } = await this.db.from('markets').upsert(
        batch.map((row) => ({
          event_id: row.eventId,
          market_type_id: row.marketTypeId,
          name: row.name,
          line: row.line,
          status: row.status,
          is_live: row.isLive,
          period: row.period,
          canonical_key: row.canonicalKey,
        })),
        { onConflict: 'event_id,canonical_key', ignoreDuplicates: true },
      );
      if (error) throw dbError('insert markets', error);
    }

    const eventIds = [...new Set(rows.map((row) => row.eventId))];
    const byKey = new Map<string, string>();

    // Read back by event, not by key list: a single event can own dozens of
    // markets and an `in (...)` list of hundreds of composite keys is slow.
    for (const batch of chunk(eventIds, 100)) {
      const { data, error } = await this.db
        .from('markets')
        .select('id, event_id, canonical_key')
        .in('event_id', batch);

      if (error) throw dbError('read market ids', error);
      for (const row of (data ?? []) as Array<{ id: string; event_id: string; canonical_key: string | null }>) {
        if (!row.canonical_key) continue;
        byKey.set(`${row.event_id}#${row.canonical_key}`, row.id);
      }
    }

    return byKey;
  }

  /* ── Selections ────────────────────────────────────────────────────────── */

  /**
   * Create any missing selections and return the id for every
   * (market, outcome key) pair. New rows are inserted `suspended` on purpose:
   * `selections.odds` is what `place_bet()` charges, so a price becomes
   * bettable only through the publish step of the pricing source.
   */
  async ensureSelections(rows: readonly SelectionUpsert[]): Promise<Map<string, string>> {
    if (rows.length === 0) return new Map();

    for (const batch of chunk(rows, this.writeBatchSize)) {
      const { error } = await this.db.from('selections').upsert(
        batch.map((row) => ({
          market_id: row.marketId,
          name: row.name,
          odds: row.odds,
          status: 'suspended',
          sort_order: row.sortOrder,
          outcome_key: row.outcomeKey,
        })),
        { onConflict: 'market_id,outcome_key', ignoreDuplicates: true },
      );
      if (error) throw dbError('insert selections', error);
    }

    const marketIds = [...new Set(rows.map((row) => row.marketId))];
    const byKey = new Map<string, string>();
    /** `selections.id` → the sort_order currently stored. */
    const currentOrder = new Map<string, number>();

    for (const batch of chunk(marketIds, 100)) {
      const { data, error } = await this.db
        .from('selections')
        .select('id, market_id, outcome_key, sort_order')
        .in('market_id', batch);

      if (error) throw dbError('read selection ids', error);
      for (const row of (data ?? []) as Array<{
        id: string;
        market_id: string;
        outcome_key: string | null;
        sort_order: number | null;
      }>) {
        currentOrder.set(row.id, row.sort_order ?? 0);
        if (!row.outcome_key) continue;
        byKey.set(`${row.market_id}#${row.outcome_key}`, row.id);
      }
    }

    await this.repairSelectionOrder(rows, byKey, currentOrder);

    return byKey;
  }

  /**
   * Correct `sort_order` on selections that already exist.
   *
   * Insert is create-only (`ignoreDuplicates`), which is deliberate: a re-poll
   * must never overwrite a price or a status. But that also froze the display
   * order of every selection at the moment it was first created, so a wrong order
   * could never self-correct.
   *
   * This repairs only `sort_order`, only where it differs, and only for rows the
   * engine owns (they have an `outcome_key`). It touches no price and no status,
   * so it cannot interfere with publication. In the steady state it writes
   * nothing at all, and costs one extra column on a read that already happened.
   */
  private async repairSelectionOrder(
    rows: readonly SelectionUpsert[],
    idByKey: Map<string, string>,
    currentOrder: Map<string, number>,
  ): Promise<void> {
    // Group the ids that need the same new value, so this is a handful of
    // statements rather than one per selection.
    const idsByDesiredOrder = new Map<number, string[]>();

    for (const row of rows) {
      const id = idByKey.get(`${row.marketId}#${row.outcomeKey}`);
      if (!id) continue;
      if (currentOrder.get(id) === row.sortOrder) continue;

      const list = idsByDesiredOrder.get(row.sortOrder) ?? [];
      list.push(id);
      idsByDesiredOrder.set(row.sortOrder, list);
    }

    if (idsByDesiredOrder.size === 0) return;

    for (const [sortOrder, ids] of idsByDesiredOrder) {
      for (const batch of chunk(ids, this.writeBatchSize)) {
        const { error } = await this.db.from('selections').update({ sort_order: sortOrder }).in('id', batch);
        if (error) throw dbError('repair selection sort_order', error);
      }
    }
  }

  /* ── Provider fixture links ────────────────────────────────────────────── */

  async findLink(sourceId: string, externalKey: string): Promise<{ eventId: string; matchMethod: string } | null> {
    const { data, error } = await this.db
      .from('odds_source_links')
      .select('event_id, match_method')
      .eq('source_id', sourceId)
      .eq('external_key', externalKey)
      .maybeSingle();

    if (error) throw dbError('read odds_source_links', error);
    if (!data) return null;
    const row = data as { event_id: string; match_method: string };

    // Cheap freshness bump, ignored on failure: the link having been read is
    // already enough for this cycle.
    void this.db
      .from('odds_source_links')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('source_id', sourceId)
      .eq('external_key', externalKey);

    return { eventId: row.event_id, matchMethod: row.match_method };
  }

  async saveLink(input: {
    sourceId: string;
    externalKey: string;
    eventId: string;
    matchMethod: string;
    confidence: number;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.db.from('odds_source_links').upsert(
      {
        source_id: input.sourceId,
        external_key: input.externalKey,
        event_id: input.eventId,
        match_method: input.matchMethod,
        confidence: input.confidence,
        metadata: input.metadata,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'source_id,external_key', ignoreDuplicates: true },
    );
    if (error) throw dbError('insert odds_source_links', error);
  }
}
