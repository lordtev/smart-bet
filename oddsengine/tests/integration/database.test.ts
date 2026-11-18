/**
 * Integration suite: the real database
 * ─────────────────────────────────────────────────────────────────────────────
 * These tests exercise the actual SQL — `odds_apply_quotes`,
 * `odds_publish_prices`, the unique keys and the history rules — because those
 * guarantees live in the database and cannot be proven by fakes.
 *
 * They SKIP (and say why) unless:
 *   1. SUPABASE_URL and a service-role key are available — read from
 *      oddsengine/.env first, then from the website's .env; and
 *   2. supabase/migrations/20260101000700_odds_engine.sql has been applied.
 *
 * SAFETY: everything they create is namespaced `__oe_test` and removed again in
 * `afterAll`. They never read or write a row they did not create, and they use
 * their own `odds_sources` rows, so a publishing test can never touch the book's
 * real prices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseClient, tableExists } from '../../src/db/client.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = resolve(HERE, '../..');

/* ── Credentials ─────────────────────────────────────────────────────────── */

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) out[match[1] as string] = (match[2] as string).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function findCredentials(): { url: string; key: string } | null {
  for (const env of [
    process.env,
    readEnvFile(resolve(ENGINE_ROOT, '.env')),
    readEnvFile(resolve(ENGINE_ROOT, '../.env')),
  ]) {
    const url = env['SUPABASE_URL'];
    const key = env['SUPABASE_SERVICE_ROLE_KEY'];
    if (url && key) return { url, key };
  }
  return null;
}

const creds = findCredentials();

/* ── Availability gate, evaluated before any suite is registered ──────────── */

const requiredTables = [
  'odds_sources',
  'odds_source_links',
  'odds_market_rules',
  'odds_quotes',
  'odds_history_rules',
  'odds_source_health',
  'odds_worker_runs',
];

const probe = creds ? createSupabaseClient(creds.url, creds.key) : null;
const missingTables: string[] = [];

if (probe) {
  for (const table of requiredTables) {
    if (!(await tableExists(probe, table))) missingTables.push(table);
  }
}

const available = Boolean(creds) && missingTables.length === 0;

const skipReason = !creds
  ? 'no Supabase credentials found — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in oddsengine/.env'
  : `the odds-engine migration is not applied — missing: ${missingTables.join(', ')}. ` +
    'Run supabase/migrations/20260101000700_odds_engine.sql and then 20260101000800_odds_market_rules.sql.';

if (!available) {
  // Say it out loud, so a skipped run is never mistaken for a passing one.
  console.warn(`\n[integration tests skipped] ${skipReason}\n`);
}

/* ── Fixtures owned by this file ─────────────────────────────────────────── */

const TAG = '__oe_test';
const SOURCE_A = `${TAG}_source_a`;
const SOURCE_B = `${TAG}_source_b`;

type Fixture = {
  sportId: string;
  leagueId: string;
  teamHomeId: string;
  teamAwayId: string;
  eventId: string;
  marketId: string;
  selectionIds: string[];
};

let db: SupabaseClient;
let fixture: Fixture;
let sourceAId: string;
let sourceBId: string;
/**
 * Whoever was publishing before the suite started. The publish tests must take
 * the pricing flag (only one source may hold it), so this is restored in
 * `afterAll` — a test run must not leave the book with no pricing source.
 */
let previousPricingSourceId: string | null = null;

describe.skipIf(!available)('odds engine <-> Supabase', () => {
  beforeAll(async () => {
    db = probe as SupabaseClient;

    const single = <T>(result: { data: unknown; error: unknown }, what: string): T => {
      if (result.error) throw new Error(`${what}: ${JSON.stringify(result.error)}`);
      if (!result.data) throw new Error(`${what}: no row returned`);
      return result.data as T;
    };

    // Remember who publishes today, so `afterAll` can put it back.
    const { data: currentPricing } = await db
      .from('odds_sources')
      .select('id')
      .eq('is_pricing_source', true)
      .maybeSingle();
    previousPricingSourceId = (currentPricing as { id: string } | null)?.id ?? null;

    const sport = single<{ id: string }>(
      await db
        .from('sports')
        .upsert({ name: `${TAG} Sport`, slug: TAG, is_active: false }, { onConflict: 'slug' })
        .select('id')
        .single(),
      'create test sport',
    );

    const league = single<{ id: string }>(
      await db
        .from('leagues')
        .upsert(
          { sport_id: sport.id, name: `${TAG} League`, slug: TAG, is_active: false },
          { onConflict: 'sport_id,slug' },
        )
        .select('id')
        .single(),
      'create test league',
    );

    const home = single<{ id: string }>(
      await db
        .from('teams')
        .upsert({ sport_id: sport.id, name: `${TAG} Home` }, { onConflict: 'sport_id,name' })
        .select('id')
        .single(),
      'create test home team',
    );

    const away = single<{ id: string }>(
      await db
        .from('teams')
        .upsert({ sport_id: sport.id, name: `${TAG} Away` }, { onConflict: 'sport_id,name' })
        .select('id')
        .single(),
      'create test away team',
    );

    const marketType = single<{ id: string }>(
      await db.from('market_types').select('id').eq('code', 'MATCH_WINNER').single(),
      'read MATCH_WINNER market type',
    );

    const event = single<{ id: string }>(
      await db
        .from('events')
        .insert({
          league_id: league.id,
          home_team_id: home.id,
          away_team_id: away.id,
          name: `${TAG} Home vs ${TAG} Away`,
          starts_at: new Date(Date.now() + 86_400_000).toISOString(),
          status: 'scheduled',
        })
        .select('id')
        .single(),
      'create test event',
    );

    const market = single<{ id: string }>(
      await db
        .from('markets')
        .insert({
          event_id: event.id,
          market_type_id: marketType.id,
          name: `${TAG} 1X2`,
          status: 'open',
          period: 'FT',
          canonical_key: 'MATCH_WINNER|FT||',
        })
        .select('id')
        .single(),
      'create test market',
    );

    const selections = await db
      .from('selections')
      .insert([
        { market_id: market.id, name: 'Home', odds: 2, status: 'suspended', sort_order: 0, outcome_key: 'HOME' },
        { market_id: market.id, name: 'Draw', odds: 3.4, status: 'suspended', sort_order: 1, outcome_key: 'DRAW' },
        { market_id: market.id, name: 'Away', odds: 3.2, status: 'suspended', sort_order: 2, outcome_key: 'AWAY' },
      ])
      .select('id');

    if (selections.error) throw new Error(`create test selections: ${selections.error.message}`);

    const sources = await db
      .from('odds_sources')
      .upsert(
        [
          {
            key: SOURCE_A,
            name: `${TAG} source A`,
            kind: 'provider',
            is_enabled: true,
            is_pricing_source: false,
            priority: 900,
          },
          {
            key: SOURCE_B,
            name: `${TAG} source B`,
            kind: 'provider',
            is_enabled: true,
            is_pricing_source: false,
            priority: 901,
          },
        ],
        { onConflict: 'key' },
      )
      .select('id, key');

    if (sources.error) throw new Error(`create test sources: ${sources.error.message}`);

    for (const row of sources.data as Array<{ id: string; key: string }>) {
      if (row.key === SOURCE_A) sourceAId = row.id;
      if (row.key === SOURCE_B) sourceBId = row.id;
    }

    fixture = {
      sportId: sport.id,
      leagueId: league.id,
      teamHomeId: home.id,
      teamAwayId: away.id,
      eventId: event.id,
      marketId: market.id,
      selectionIds: (selections.data as Array<{ id: string }>).map((row) => row.id),
    };

    await db.from('odds_quotes').delete().in('source_id', [sourceAId, sourceBId]);
    await db.from('odds_history').delete().in('selection_id', fixture.selectionIds);
  });

  afterAll(async () => {
    if (!fixture) return;

    await db.from('odds_quotes').delete().in('source_id', [sourceAId, sourceBId]);
    await db.from('odds_history').delete().in('selection_id', fixture.selectionIds);
    await db.from('odds_source_links').delete().in('source_id', [sourceAId, sourceBId]);
    await db.from('odds_market_rules').delete().in('source_id', [sourceAId, sourceBId]);
    await db.from('odds_source_health').delete().in('source_id', [sourceAId, sourceBId]);
    await db.from('odds_worker_runs').delete().in('source_id', [sourceAId, sourceBId]);

    // Hand the pricing flag back to whoever held it. The publish tests have to
    // take it, because only one source may publish at a time; without this the
    // book would be left with no pricing source until the next engine run
    // restored it from PRICING_PROVIDER.
    await db.from('odds_sources').update({ is_pricing_source: false }).eq('id', sourceAId);
    if (previousPricingSourceId) {
      await db
        .from('odds_sources')
        .update({ is_pricing_source: true })
        .eq('id', previousPricingSourceId);
    }

    // Deleting the event cascades to its markets and selections.
    await db.from('events').delete().eq('id', fixture.eventId);
    await db.from('teams').delete().in('id', [fixture.teamHomeId, fixture.teamAwayId]);
    await db.from('leagues').delete().eq('id', fixture.leagueId);
    await db.from('sports').delete().eq('id', fixture.sportId);
    // The two odds_sources rows stay behind: odds_history holds an ON DELETE
    // RESTRICT foreign key to them, and history is never destroyed by a cleanup
    // step. They are namespaced and inert.
  });

  /* ── Schema ────────────────────────────────────────────────────────────── */

  describe('schema', () => {
    it('hydrated canonical keys across the existing catalogue', async () => {
      const [markets, selections] = await Promise.all([
        db.from('markets').select('id', { count: 'exact', head: true }).is('canonical_key', null),
        db.from('selections').select('id', { count: 'exact', head: true }).is('outcome_key', null),
      ]);

      expect(markets.count ?? 0).toBe(0);
      expect(selections.count ?? 0).toBe(0);
    });

    it('has the seed migration applied, not just the schema migration', async () => {
      // 0710 creates the objects; 0800 populates the market rules and the
      // canonical market types. Running only the first leaves every provider
      // market "unknown", which the engine would auto-map to EXT_… codes.
      const [rules, types, history] = await Promise.all([
        db.from('odds_market_rules').select('id', { count: 'exact', head: true }),
        db
          .from('market_types')
          .select('code', { count: 'exact', head: true })
          .in('code', [
            'SPREADS', 'MATCH_WINNER_LAY', 'WINNER_LAY', 'HALF_TIME_FULL_TIME', 'TEAM_TOTAL',
            'CORNERS_1X2', 'TO_QUALIFY', 'PLAYER_POINTS', 'PLAYER_REBOUNDS', 'PLAYER_ASSISTS',
            'PLAYER_THREES', 'PLAYER_ANYTIME_GOALSCORER', 'PLAYER_SHOTS_ON_TARGET',
          ]),
        db.from('odds_history_rules').select('market_type_id', { count: 'exact', head: true }),
      ]);

      expect(rules.count ?? 0, 'no odds_market_rules rows — run 20260101000800_odds_market_rules.sql').toBeGreaterThan(0);
      expect(types.count ?? 0, 'engine market types missing — run 20260101000800_odds_market_rules.sql').toBe(13);
      expect(history.count ?? 0, 'no history rules — run 20260101000800_odds_market_rules.sql').toBeGreaterThan(0);
    });

    it('allows only one enabled pricing source', async () => {
      await db.from('odds_sources').update({ is_pricing_source: false }).eq('is_pricing_source', true);
      await db.from('odds_sources').update({ is_pricing_source: true, is_enabled: true }).eq('id', sourceAId);

      const second = await db
        .from('odds_sources')
        .update({ is_pricing_source: true, is_enabled: true })
        .eq('id', sourceBId);

      expect(second.error?.code).toBe('23505');
      await db.from('odds_sources').update({ is_pricing_source: false }).eq('id', sourceAId);
    });

    it('refuses a quote below the storable range', async () => {
      const { error } = await db.from('odds_quotes').insert({
        source_id: sourceAId,
        selection_id: fixture.selectionIds[0],
        odds: 1.0,
      });
      expect(error).not.toBeNull();
    });
  });

  /* ── Ingestion ─────────────────────────────────────────────────────────── */

  describe('odds_apply_quotes', () => {
    it('inserts a first quote', async () => {
      const { data, error } = await db.rpc('odds_apply_quotes', {
        p_source_id: sourceAId,
        p_quotes: [
          {
            selection_id: fixture.selectionIds[0],
            odds: 2.05,
            bookmaker_key: 'book-a',
            provider_updated_at: '2026-09-26T12:00:00Z',
          },
        ],
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({ received: 1, accepted: 1, inserted: 1, changed: 1, invalid: 0 });
    });

    it('writes nothing when the identical quote arrives again', async () => {
      const { data } = await db.rpc('odds_apply_quotes', {
        p_source_id: sourceAId,
        p_quotes: [
          {
            selection_id: fixture.selectionIds[0],
            odds: 2.05,
            bookmaker_key: 'book-a',
            provider_updated_at: '2026-09-26T12:00:00Z',
          },
        ],
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      expect(data).toMatchObject({ accepted: 1, changed: 0, inserted: 0, touched: 0, skipped: 1 });
    });

    it('writes exactly one row when the price moves', async () => {
      const { data } = await db.rpc('odds_apply_quotes', {
        p_source_id: sourceAId,
        p_quotes: [
          {
            selection_id: fixture.selectionIds[0],
            odds: 2.2,
            bookmaker_key: 'book-a',
            provider_updated_at: '2026-09-26T12:05:00Z',
          },
        ],
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      expect(data).toMatchObject({ changed: 1, inserted: 0 });

      const { data: rows } = await db
        .from('odds_quotes')
        .select('odds')
        .eq('source_id', sourceAId)
        .eq('selection_id', fixture.selectionIds[0]);

      expect(rows).toHaveLength(1);
      expect(Number((rows as Array<{ odds: number }>)[0]?.odds)).toBe(2.2);
    });

    it('cannot be rolled back by an older provider timestamp', async () => {
      const { data } = await db.rpc('odds_apply_quotes', {
        p_source_id: sourceAId,
        p_quotes: [
          {
            selection_id: fixture.selectionIds[0],
            odds: 1.5,
            bookmaker_key: 'book-a',
            provider_updated_at: '2026-09-26T11:00:00Z',
          },
        ],
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      expect(data).toMatchObject({ changed: 0, stale: 1 });

      const { data: rows } = await db
        .from('odds_quotes')
        .select('odds')
        .eq('source_id', sourceAId)
        .eq('selection_id', fixture.selectionIds[0]);

      expect(Number((rows as Array<{ odds: number }>)[0]?.odds)).toBe(2.2);
    });

    it('keeps two sources quoting the same selection apart', async () => {
      await db.rpc('odds_apply_quotes', {
        p_source_id: sourceBId,
        p_quotes: [
          {
            selection_id: fixture.selectionIds[0],
            odds: 2.9,
            bookmaker_key: 'book-a',
            provider_updated_at: '2026-09-26T12:10:00Z',
          },
        ],
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      const { data } = await db
        .from('odds_quotes')
        .select('source_id, odds')
        .eq('selection_id', fixture.selectionIds[0]);

      const rows = data as Array<{ source_id: string; odds: number }>;
      expect(rows).toHaveLength(2);

      const bySource = new Map(rows.map((row) => [row.source_id, Number(row.odds)]));
      expect(bySource.get(sourceAId)).toBe(2.2);
      expect(bySource.get(sourceBId)).toBe(2.9);
    });

    it('keeps two bookmakers in one source apart', async () => {
      await db.rpc('odds_apply_quotes', {
        p_source_id: sourceAId,
        p_quotes: [
          {
            selection_id: fixture.selectionIds[0],
            odds: 2.15,
            bookmaker_key: 'book-b',
            provider_updated_at: '2026-09-26T12:11:00Z',
          },
        ],
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      const { data } = await db
        .from('odds_quotes')
        .select('bookmaker_key, odds')
        .eq('source_id', sourceAId)
        .eq('selection_id', fixture.selectionIds[0]);

      const rows = data as Array<{ bookmaker_key: string; odds: number }>;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.bookmaker_key))).toEqual(new Set(['book-a', 'book-b']));
    });

    it('counts a malformed row instead of failing the whole batch', async () => {
      const { data, error } = await db.rpc('odds_apply_quotes', {
        p_source_id: sourceAId,
        p_quotes: [
          { selection_id: 'not-a-uuid', odds: 2 },
          { selection_id: fixture.selectionIds[1], odds: 'not-a-number' },
          { selection_id: fixture.selectionIds[1], odds: 3.5, bookmaker_key: 'book-a' },
        ],
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      expect(error).toBeNull();
      expect(data).toMatchObject({ received: 3, accepted: 1 });
      expect((data as { invalid: number }).invalid).toBeGreaterThanOrEqual(2);
    });

    it('honours the history master switch and the per-market rule', async () => {
      // Read the configured rule rather than assuming it: the seed decides whether
      // provider-level history is captured for MATCH_WINNER, and the test should
      // be right either way.
      const { data: marketRow } = await db
        .from('markets')
        .select('market_type_id')
        .eq('id', fixture.marketId)
        .single();

      const { data: ruleRow } = await db
        .from('odds_history_rules')
        .select('capture_source_history')
        .eq('market_type_id', (marketRow as { market_type_id: string }).market_type_id)
        .maybeSingle();

      const ruleAllows = Boolean((ruleRow as { capture_source_history: boolean } | null)?.capture_source_history);

      // Timestamps must be newer than anything this selection already carries.
      // Other tests in this file have written to it, some without a provider
      // timestamp (which the engine coalesces to "now"), so a fixed past date
      // here would be correctly rejected by the staleness guard.
      const base = Date.now();

      const { data: off } = await db.rpc('odds_apply_quotes', {
        p_source_id: sourceAId,
        p_quotes: [
          {
            selection_id: fixture.selectionIds[1],
            odds: 3.9,
            bookmaker_key: 'book-a',
            provider_updated_at: new Date(base + 60_000).toISOString(),
          },
        ],
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      // The master switch alone always wins.
      expect((off as { history: number }).history).toBe(0);

      const { data: on } = await db.rpc('odds_apply_quotes', {
        p_source_id: sourceAId,
        p_quotes: [
          {
            selection_id: fixture.selectionIds[1],
            odds: 4.1,
            bookmaker_key: 'book-a',
            provider_updated_at: new Date(base + 120_000).toISOString(),
          },
        ],
        p_capture_history: true,
        p_heartbeat_seconds: 0,
      });

      // With the master switch on, the per-market rule decides.
      expect((on as { history: number }).history).toBe(ruleAllows ? 1 : 0);

      const { count } = await db
        .from('odds_history')
        .select('id', { count: 'exact', head: true })
        .eq('selection_id', fixture.selectionIds[1])
        .eq('source_id', sourceAId);

      if (ruleAllows) expect(count ?? 0).toBeGreaterThan(0);
      else expect(count ?? 0).toBe(0);
    });

    it('rejects an unknown source', async () => {
      const { error } = await db.rpc('odds_apply_quotes', {
        p_source_id: '00000000-0000-4000-8000-000000000000',
        p_quotes: [],
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      expect(error?.message).toMatch(/unknown odds source/);
    });

    it('rejects a payload that is not an array', async () => {
      const { error } = await db.rpc('odds_apply_quotes', {
        p_source_id: sourceAId,
        p_quotes: { nope: true },
        p_capture_history: false,
        p_heartbeat_seconds: 0,
      });

      expect(error?.message).toMatch(/must be a JSON array/);
    });
  });

  /* ── Publication ───────────────────────────────────────────────────────── */

  describe('odds_publish_prices', () => {
    it('refuses a source that is not the pricing source', async () => {
      const { error } = await db.rpc('odds_publish_prices', { p_source_id: sourceBId, p_max_staleness_seconds: 0 });
      expect(error?.message).toMatch(/not the pricing source/);
    });

    it('publishes the pricing source and ignores the other one', async () => {
      await db.from('odds_sources').update({ is_pricing_source: false }).eq('is_pricing_source', true);
      await db.from('odds_sources').update({ is_pricing_source: true }).eq('id', sourceAId);

      const { error } = await db.rpc('odds_publish_prices', { p_source_id: sourceAId, p_max_staleness_seconds: 0 });
      expect(error).toBeNull();

      const { data } = await db.from('selections').select('id, odds, status').in('id', fixture.selectionIds);
      const published = data as Array<{ id: string; odds: number; status: string }>;

      const home = published.find((row) => row.id === fixture.selectionIds[0]);
      // A's price won, not B's.
      expect(Number(home?.odds)).toBe(2.2);
      expect(home?.status).toBe('active');

      await db.from('odds_sources').update({ is_pricing_source: false }).eq('id', sourceAId);
    });

    it('changes nothing for a source with no quotes at all', async () => {
      const before = await db.from('selections').select('id, status, odds').in('id', fixture.selectionIds);

      await db.from('odds_sources').update({ is_pricing_source: true }).eq('id', sourceAId);
      await db.from('odds_quotes').delete().eq('source_id', sourceAId);
      await db.rpc('odds_publish_prices', { p_source_id: sourceAId, p_max_staleness_seconds: 0 });

      const after = await db.from('selections').select('id, status, odds').in('id', fixture.selectionIds);
      expect(after.data).toEqual(before.data);

      await db.from('odds_sources').update({ is_pricing_source: false }).eq('id', sourceAId);
    });
  });

  /* ── Published-price history ───────────────────────────────────────────── */

  describe('published price history', () => {
    it('logs a change made through the existing trigger', async () => {
      const before = await db
        .from('odds_history')
        .select('id', { count: 'exact', head: true })
        .eq('selection_id', fixture.selectionIds[2])
        .is('source_id', null);

      await db.from('selections').update({ odds: 3.45 }).eq('id', fixture.selectionIds[2]);

      const after = await db
        .from('odds_history')
        .select('id', { count: 'exact', head: true })
        .eq('selection_id', fixture.selectionIds[2])
        .is('source_id', null);

      expect(after.count ?? 0).toBeGreaterThan(before.count ?? 0);
    });
  });
});

if (!available) {
  describe('odds engine <-> Supabase', () => {
    it.skip(`skipped: ${skipReason}`, () => {});
  });
}
