#!/usr/bin/env node
/**
 * Apply the odds-engine seed data over PostgREST.
 *
 * WHY THIS EXISTS
 * ---------------
 * `supabase/migrations/20260101000700_odds_engine.sql` is DDL and must be run in
 * the Supabase SQL Editor. `20260101000800_odds_market_rules.sql` is pure data —
 * inserts with ON CONFLICT DO NOTHING — so it can also be applied with nothing
 * but the service-role key, from a machine that has no psql and no dashboard
 * access. That is what this script does.
 *
 * The `.sql` file remains the canonical definition. This mirrors it row for row
 * and is idempotent, so running it and then running the `.sql` later is harmless.
 * If you edit one, edit both.
 *
 * WHAT IT WRITES
 *   7 rows into market_types          (the canonical market families the engine adds)
 *   2 rows into odds_sources          (mock, the-odds-api — both DISABLED)
 *  18+ rows into odds_market_rules    (provider market key → canonical code)
 *   7 rows into odds_history_rules     (per-market retention)
 *
 * It never updates or deletes anything, never touches an existing website table
 * outside market_types, and never sets a pricing source.
 *
 * Usage:
 *   node scripts/apply-seed.mjs            # apply
 *   node scripts/apply-seed.mjs --dry-run  # show what would be written
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ── Credentials: oddsengine/.env first, then the website's .env ─────────── */

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function credentials() {
  for (const env of [process.env, readEnvFile(resolve(ROOT, '.env')), readEnvFile(resolve(ROOT, '../.env'))]) {
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      return { url: env.SUPABASE_URL.replace(/\/+$/, ''), key: env.SUPABASE_SERVICE_ROLE_KEY };
    }
  }
  throw new Error('No Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in oddsengine/.env');
}

const { url, key } = credentials();
const dryRun = process.argv.includes('--dry-run');

const HEADERS = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'User-Agent': 'smartbet-oddsengine/1.0 (seed)',
  Prefer: 'return=representation,resolution=ignore-duplicates',
};

/** Fail on a missing table with the instruction, not a raw PostgREST error. */
const MIGRATION_HINT =
  'Run supabase/migrations/20260101000700_odds_engine.sql in the Supabase SQL Editor first.';

async function upsertIgnoringDuplicates(table, rows, onConflict) {
  if (rows.length === 0) return [];

  if (dryRun) {
    console.log(`  [dry-run] would insert up to ${rows.length} row(s) into ${table}`);
    return [];
  }

  const response = await fetch(`${url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}&select=*`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(rows),
  });

  const text = await response.text();

  if (!response.ok) {
    if (/PGRST205|does not exist|Could not find the table/i.test(text)) {
      throw new Error(`${table} does not exist. ${MIGRATION_HINT}\n${text.slice(0, 300)}`);
    }
    throw new Error(`insert into ${table} failed (${response.status}): ${text.slice(0, 500)}`);
  }

  return text ? JSON.parse(text) : [];
}

async function selectOne(table, query) {
  const response = await fetch(`${url}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'User-Agent': HEADERS['User-Agent'] },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`read ${table} failed (${response.status}): ${text.slice(0, 300)}`);
  const rows = JSON.parse(text);
  if (rows.length === 0) throw new Error(`expected a row in ${table} for ${query}`);
  return rows[0];
}

/* ── 1. Canonical market types the engine adds ───────────────────────────── */

const MARKET_TYPES = [
  ['SPREADS', 'Handicap / spread', 'Point or goal handicap. Outcomes are the two participants; the line lives on the market.'],
  ['MATCH_WINNER_LAY', 'Match winner (lay)', 'Exchange LAY price. Opposite side of the book to MATCH_WINNER and never merged with it.'],
  ['WINNER_LAY', 'Outright winner (lay)', 'Exchange LAY price for a futures/outright market.'],
  ['HALF_TIME_FULL_TIME', 'Half time / full time', 'Combined half-time and full-time result.'],
  ['TEAM_TOTAL', 'Team total', 'Goals/points scored by one team, as a total line.'],
  ['CORNERS_1X2', 'Corners 1X2', 'Match result measured in corners.'],
  ['TO_QUALIFY', 'To qualify', 'Two-legged tie qualification market.'],
  // The most common player props. Each is its own market: "points" and
  // "rebounds" settle differently, so they must never merge.
  ['PLAYER_POINTS', 'Player points', "A named player's points, as a total line."],
  ['PLAYER_REBOUNDS', 'Player rebounds', "A named player's rebounds, as a total line."],
  ['PLAYER_ASSISTS', 'Player assists', "A named player's assists, as a total line."],
  ['PLAYER_THREES', 'Player three-pointers', "A named player's three-pointers, as a total line."],
  ['PLAYER_ANYTIME_GOALSCORER', 'Anytime goalscorer', 'A named player scoring at any point in the match.'],
  ['PLAYER_SHOTS_ON_TARGET', 'Player shots on target', "A named player's shots on target, as a total line."],
];

/* ── 2. Sources (both seeded DISABLED; env decides what runs) ────────────── */

const SOURCES = [
  {
    key: 'mock',
    name: 'Mock provider (development)',
    kind: 'provider',
    is_enabled: false,
    priority: 10,
    is_pricing_source: false,
    supports_live: true,
    supports_prematch: true,
    config: { fixtureCount: 6, marketsPerFixture: 4, jitterPct: 2, seedChangePct: 35 },
    notes: 'Deterministic offline provider used by tests and by ODDS_MOCK_MODE. No API cost.',
  },
  {
    key: 'the-odds-api',
    name: 'The Odds API',
    kind: 'provider',
    is_enabled: false,
    priority: 20,
    is_pricing_source: false,
    supports_live: true,
    supports_prematch: true,
    config: {
      regions: ['uk'],
      markets: ['h2h', 'spreads', 'totals'],
      sports: ['soccer_epl'],
      oddsFormat: 'decimal',
      includeAlternateLines: false,
    },
    notes: 'api.the-odds-api.com v4. Multi-bookmaker, so each bookmaker is a bookmaker_key on odds_quotes.',
  },
];

/* ── 3. The Odds API market rules — real keys from their published list ──── */

const THE_ODDS_API_RULES = [
  ['h2h', 'MATCH_WINNER', 'FT', 'none', 'Moneyline. Three outcomes for 3-way sports (HOME/DRAW/AWAY), two otherwise.'],
  ['h2h_3_way', 'MATCH_WINNER', 'FT', 'none', 'Explicit 3-way moneyline; same canonical market as h2h.'],
  ['h2h_lay', 'MATCH_WINNER_LAY', 'FT', 'none', 'Exchange lay side — deliberately a different canonical market.'],
  ['spreads', 'SPREADS', 'FT', 'spread', 'Point/goal handicap; one canonical market per line.'],
  ['totals', 'OVER_UNDER', 'FT', 'total', 'Over/Under; one canonical market per line.'],
  ['team_totals', 'TEAM_TOTAL', 'FT', 'total', 'Team total; one canonical market per team and line.'],
  ['btts', 'BTTS', 'FT', 'none', 'Both teams to score.'],
  ['draw_no_bet', 'DRAW_NO_BET', 'FT', 'none', 'Draw no bet / draw voids.'],
  ['double_chance', 'DOUBLE_CHANCE', 'FT', 'none', 'Two-outcome coverage.'],
  ['correct_score', 'CORRECT_SCORE', 'FT', 'none', 'One selection per scoreline.'],
  ['halftime_fulltime', 'HALF_TIME_FULL_TIME', 'FT', 'none', 'HT/FT combination.'],
  ['corners_1x2', 'CORNERS_1X2', 'FT', 'none', 'Result in corners.'],
  ['to_qualify', 'TO_QUALIFY', 'FT', 'none', 'Qualification over two legs.'],
  ['outrights', 'WINNER', 'FT', 'none', 'Futures/outright winner; the event has no home/away team.'],
  ['outrights_lay', 'WINNER_LAY', 'FT', 'none', 'Exchange lay side of a futures market.'],
  // Player props: enumerated because canonical_code is a foreign key to
  // market_types, so a `%` template would be rejected. Anything not listed is
  // still ingested — the engine records it with review_status 'auto' under an
  // EXT_… code so it shows up in the review queue and can be promoted.
  ['player_points', 'PLAYER_POINTS', 'FT', 'total', 'Points prop; one canonical market per player and line.'],
  ['player_rebounds', 'PLAYER_REBOUNDS', 'FT', 'total', 'Rebounds prop.'],
  ['player_assists', 'PLAYER_ASSISTS', 'FT', 'total', 'Assists prop.'],
  ['player_threes', 'PLAYER_THREES', 'FT', 'total', 'Three-pointers prop.'],
  ['player_goal_scorer_anytime', 'PLAYER_ANYTIME_GOALSCORER', 'FT', 'none', 'Anytime goalscorer.'],
  ['player_shots_on_target', 'PLAYER_SHOTS_ON_TARGET', 'FT', 'total', 'Shots on target prop.'],
];

/* ── 4. Mock provider market rules ──────────────────────────────────────── */

const MOCK_RULES = [
  ['1X2', 'MATCH_WINNER', 'FT', 'none', 'Three outcomes: HOME / DRAW / AWAY.'],
  ['OVER_UNDER_2_5', 'OVER_UNDER', 'FT', 'total', 'Two outcomes: OVER / UNDER.'],
  ['BTTS', 'BTTS', 'FT', 'none', 'Two outcomes: YES / NO.'],
  ['DOUBLE_CHANCE', 'DOUBLE_CHANCE', 'FT', 'none', 'HOME_OR_DRAW / HOME_OR_AWAY / DRAW_OR_AWAY.'],
  ['OVER_UNDER_1_5', 'OVER_UNDER', 'FT', 'total', 'Second total line for the same fixture.'],
  ['1X2_1H', 'MATCH_WINNER', 'H1', 'none', 'First-half 1X2 — a different canonical market from full time.'],
];

/* ── 5. History retention per market type ───────────────────────────────── */

const HISTORY_RULES = [
  ['MATCH_WINNER', true, true, 'Primary football market — full movement history retained.'],
  ['OVER_UNDER', true, true, 'Totals lines — full movement history retained.'],
  ['BTTS', true, true, 'BTTS — full movement history retained.'],
  ['SPREADS', true, false, 'Published price history only; provider-level history not retained.'],
  ['DOUBLE_CHANCE', true, false, 'Published price only.'],
  ['DRAW_NO_BET', true, false, 'Published price only.'],
  ['CORRECT_SCORE', true, false, 'Published price only.'],
  ['PLAYER_POINTS', true, false, 'Published price only — props move too often to retain every tick.'],
];

/* ── Apply ──────────────────────────────────────────────────────────────── */

async function main() {
  console.log(`Seed target: ${url}${dryRun ? '  [DRY RUN]' : ''}\n`);

  // 1. market_types — the engine's canonical families.
  const existingTypes = await fetch(
    `${url}/rest/v1/market_types?select=code&code=in.(${MARKET_TYPES.map((row) => row[0]).join(',')})`,
    { headers: { apikey: key, Authorization: `Bearer ${key}`, 'User-Agent': HEADERS['User-Agent'] } },
  ).then((response) => response.json());

  const typeCodes = new Set(existingTypes.map((row) => row.code));
  const missingTypes = MARKET_TYPES.filter(([code]) => !typeCodes.has(code));

  console.log(`market_types: ${MARKET_TYPES.length - missingTypes.length} present, ${missingTypes.length} to add`);
  if (missingTypes.length > 0) {
    await upsertIgnoringDuplicates(
      'market_types',
      missingTypes.map(([code, name, description]) => ({ code, name, description })),
      'code',
    );
  }

  // 2. sources.
  console.log(`odds_sources: ${SOURCES.length} row(s)`);
  await upsertIgnoringDuplicates('odds_sources', SOURCES, 'key');

  // 3. market rules, resolved against the source rows.
  if (dryRun) {
    // In a dry run nothing was inserted, so the source rows cannot be resolved.
    // Report the shape of what would be written and stop.
    console.log(`odds_market_rules: ${THE_ODDS_API_RULES.length + MOCK_RULES.length} row(s)`);
    console.log(`odds_history_rules: ${HISTORY_RULES.length} row(s)`);
    console.log('\n[dry-run] nothing was written.');
    return;
  }

  const oddsSource = await selectOne('odds_sources', 'select=id,key&key=eq.the-odds-api');
  const mockSource = await selectOne('odds_sources', 'select=id,key&key=eq.mock');

  const rules = [
    ...THE_ODDS_API_RULES.map(([providerKey, canonicalCode, period, lineType, notes]) => ({
      source_id: oddsSource.id,
      provider_key: providerKey,
      canonical_code: canonicalCode,
      period,
      line_type: lineType,
      review_status: 'mapped',
      notes,
    })),
    ...MOCK_RULES.map(([providerKey, canonicalCode, period, lineType, notes]) => ({
      source_id: mockSource.id,
      provider_key: providerKey,
      canonical_code: canonicalCode,
      period,
      line_type: lineType,
      review_status: 'mapped',
      notes,
    })),
  ];

  console.log(`odds_market_rules: ${rules.length} row(s)`);
  await upsertIgnoringDuplicates('odds_market_rules', rules, 'source_id,provider_key');

  // 4. history retention, resolved against market types.
  const typeRows = await Promise.all(
    HISTORY_RULES.map(([code]) =>
      selectOne('market_types', `select=id,code&code=eq.${encodeURIComponent(code)}`),
    ),
  );

  const historyRows = HISTORY_RULES.map(([, published, provider, notes], index) => ({
    market_type_id: typeRows[index].id,
    capture_published_history: published,
    capture_source_history: provider,
    notes,
  }));

  console.log(`odds_history_rules: ${historyRows.length} row(s)`);
  await upsertIgnoringDuplicates('odds_history_rules', historyRows, 'market_type_id');

  console.log('\nDone. Verify with scripts/verify-schema.sql, or: node src/cli/main.ts doctor');
}

try {
  await main();
} catch (error) {
  console.error(`\nSeed failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
