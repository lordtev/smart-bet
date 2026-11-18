-- =====================================================================
-- SMARTBET — ODDS ENGINE: SOURCES, MARKET RULES, HISTORY RETENTION
-- =====================================================================
-- Run AFTER 20260101000700_odds_engine.sql.
-- Safe to re-run: every statement is an insert with ON CONFLICT DO NOTHING
-- (or DO UPDATE for the sources, so re-running never resets something you
-- changed by hand into a different value — see the notes at the bottom).
--
-- Market keys below are the REAL keys published by The Odds API
-- (https://the-odds-api.com/sports-odds-data/betting-markets.html), not
-- invented ones. The engine strips an `_alternate` suffix and any period
-- suffix (`_h1`, `_h2`, `_q1`…`_q4`, `_p1`…`_p3`, `_s1`, `_s2`,
-- `_1st_N_innings`) BEFORE looking a key up here, so one rule covers every
-- period variant of a market.
--
-- `provider_key` may end with `*` to act as a prefix rule, and a `canonical_code`
-- containing `%` is expanded from the matched remainder. That template form is
-- NOT used below because `canonical_code` is a foreign key to `market_types`, so
-- a literal `PLAYER_%` is rejected. Enumerate the keys instead; anything left
-- over is auto-mapped for review rather than dropped.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CANONICAL MARKET TYPES ADDED BY THE ODDS ENGINE
-- ---------------------------------------------------------------------
-- The eight codes that already exist (MATCH_WINNER, OVER_UNDER, BTTS,
-- DOUBLE_CHANCE, DRAW_NO_BET, HALF_TIME, CORRECT_SCORE, WINNER) are reused
-- untouched. Only genuinely new market families are added.
insert into market_types (id, sport_id, code, name, description) values
  (gen_random_uuid(), null, 'SPREADS',              'Handicap / spread',        'Point or goal handicap. Outcomes are the two participants; the line lives on the market.'),
  (gen_random_uuid(), null, 'MATCH_WINNER_LAY',     'Match winner (lay)',       'Exchange LAY price. Opposite side of the book to MATCH_WINNER and never merged with it.'),
  (gen_random_uuid(), null, 'WINNER_LAY',           'Outright winner (lay)',    'Exchange LAY price for a futures/outright market.'),
  (gen_random_uuid(), null, 'HALF_TIME_FULL_TIME',  'Half time / full time',    'Combined half-time and full-time result.'),
  (gen_random_uuid(), null, 'TEAM_TOTAL',           'Team total',               'Goals/points scored by one team, as a total line.'),
  (gen_random_uuid(), null, 'CORNERS_1X2',          'Corners 1X2',              'Match result measured in corners.'),
  (gen_random_uuid(), null, 'TO_QUALIFY',           'To qualify',               'Two-legged tie qualification market.'),
  -- The most common player props. Each is its own market: "points" and
  -- "rebounds" have different settlement rules, so they must never merge.
  (gen_random_uuid(), null, 'PLAYER_POINTS',            'Player points',          'A named player''s points, as a total line.'),
  (gen_random_uuid(), null, 'PLAYER_REBOUNDS',          'Player rebounds',        'A named player''s rebounds, as a total line.'),
  (gen_random_uuid(), null, 'PLAYER_ASSISTS',           'Player assists',         'A named player''s assists, as a total line.'),
  (gen_random_uuid(), null, 'PLAYER_THREES',            'Player three-pointers',  'A named player''s three-pointers, as a total line.'),
  (gen_random_uuid(), null, 'PLAYER_ANYTIME_GOALSCORER','Anytime goalscorer',     'A named player scoring at any point in the match.'),
  (gen_random_uuid(), null, 'PLAYER_SHOTS_ON_TARGET',   'Player shots on target', 'A named player''s shots on target, as a total line.')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 2. SOURCES
-- ---------------------------------------------------------------------
-- Seeded DISABLED. `ENABLED_PROVIDERS` in the engine's .env is what turns a
-- source on, and the engine mirrors that into is_enabled on startup, so the
-- two never disagree. `is_pricing_source` marks the source whose quotes are
-- published into selections.odds (the price the website shows and bets are
-- settled at). A partial unique index allows only one enabled pricing source.
insert into odds_sources (key, name, kind, is_enabled, priority, is_pricing_source,
                          supports_live, supports_prematch, config, notes)
values
  ('mock', 'Mock provider (development)', 'provider', false, 10, false, true, true,
   '{"fixtureCount": 6, "marketsPerFixture": 4, "jitterPct": 2, "seedChangePct": 35}'::jsonb,
   'Deterministic offline provider used by tests and by ODDS_MOCK_MODE. No API cost.'),

  ('the-odds-api', 'The Odds API', 'provider', false, 20, false, true, true,
   '{"regions": ["uk"], "markets": ["h2h", "spreads", "totals"], "sports": ["soccer_epl"],
     "oddsFormat": "decimal", "includeAlternateLines": false}'::jsonb,
   'api.the-odds-api.com v4. Multi-bookmaker, so each bookmaker is registered as its own odds_source (see section 4).')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 3. MARKET RULES — the-odds-api
-- ---------------------------------------------------------------------
-- Featured markets plus the well-understood soccer/US families. Anything the
-- provider exposes that has no rule here is handled by the engine's
-- unknown-market path: recorded in this table with review_status 'auto'
-- (canonical code derived from the provider key) or 'pending' (skipped), then
-- listed by the review query at the bottom of this file. Nothing is silently
-- dropped.
insert into odds_market_rules (source_id, provider_key, canonical_code, period, line_type, review_status, notes)
select s.id, v.provider_key, v.canonical_code, v.period, v.line_type, 'mapped', v.notes
from odds_sources s
cross join (values
  ('h2h',              'MATCH_WINNER',      'FT', 'none',   'Moneyline. Three outcomes for 3-way sports (HOME/DRAW/AWAY), two otherwise.'),
  ('h2h_3_way',        'MATCH_WINNER',      'FT', 'none',   'Explicit 3-way moneyline; same canonical market as h2h.'),
  ('h2h_lay',          'MATCH_WINNER_LAY',  'FT', 'none',   'Exchange lay side — deliberately a different canonical market.'),
  ('spreads',          'SPREADS',           'FT', 'spread', 'Point/goal handicap; one canonical market per line.'),
  ('totals',           'OVER_UNDER',        'FT', 'total',  'Over/Under; one canonical market per line.'),
  ('team_totals',      'TEAM_TOTAL',        'FT', 'total',  'Team total; one canonical market per team and line.'),
  ('btts',             'BTTS',              'FT', 'none',   'Both teams to score.'),
  ('draw_no_bet',      'DRAW_NO_BET',       'FT', 'none',   'Draw no bet / draw voids.'),
  ('double_chance',    'DOUBLE_CHANCE',     'FT', 'none',   'Two-outcome coverage.'),
  ('correct_score',    'CORRECT_SCORE',     'FT', 'none',   'One selection per scoreline.'),
  ('halftime_fulltime','HALF_TIME_FULL_TIME','FT','none',   'HT/FT combination.'),
  ('corners_1x2',      'CORNERS_1X2',       'FT', 'none',   'Result in corners.'),
  ('to_qualify',       'TO_QUALIFY',        'FT', 'none',   'Qualification over two legs.'),
  ('outrights',        'WINNER',             'FT', 'none',   'Futures/outright winner; the event has no home/away team.'),
  ('outrights_lay',    'WINNER_LAY',         'FT', 'none',   'Exchange lay side of a futures market.'),
  -- Player props. Only the common ones are enumerated, because each needs a real
  -- `market_types` row: `canonical_code` is a foreign key, so a `%` template such
  -- as `PLAYER_%` is rejected by the database. Anything not listed here is still
  -- ingested — the engine records it in this table with review_status 'auto' under
  -- an `EXT_…` code (its market type created on demand), so it appears in the
  -- review query at the bottom of this file and can be promoted with one INSERT.
  ('player_points',            'PLAYER_POINTS',            'FT', 'total', 'Points prop; one canonical market per player and line.'),
  ('player_rebounds',          'PLAYER_REBOUNDS',          'FT', 'total', 'Rebounds prop.'),
  ('player_assists',           'PLAYER_ASSISTS',           'FT', 'total', 'Assists prop.'),
  ('player_threes',            'PLAYER_THREES',            'FT', 'total', 'Three-pointers prop.'),
  ('player_goal_scorer_anytime','PLAYER_ANYTIME_GOALSCORER','FT', 'none', 'Anytime goalscorer.'),
  ('player_shots_on_target',   'PLAYER_SHOTS_ON_TARGET',   'FT', 'total', 'Shots on target prop.')
) as v(provider_key, canonical_code, period, line_type, notes)
where s.key = 'the-odds-api'
on conflict (source_id, provider_key) do nothing;

-- ---------------------------------------------------------------------
-- 4. MARKET RULES — mock (development only)
-- ---------------------------------------------------------------------
insert into odds_market_rules (source_id, provider_key, canonical_code, period, line_type, review_status, notes)
select s.id, v.provider_key, v.canonical_code, v.period, v.line_type, 'mapped', v.notes
from odds_sources s
cross join (values
  ('1X2',            'MATCH_WINNER', 'FT', 'none',  'Three outcomes: HOME / DRAW / AWAY.'),
  ('OVER_UNDER_2_5', 'OVER_UNDER',   'FT', 'total', 'Two outcomes: OVER / UNDER.'),
  ('BTTS',           'BTTS',         'FT', 'none',  'Two outcomes: YES / NO.'),
  ('DOUBLE_CHANCE',  'DOUBLE_CHANCE','FT', 'none',  'HOME_OR_DRAW / HOME_OR_AWAY / DRAW_OR_AWAY.'),
  ('OVER_UNDER_1_5', 'OVER_UNDER',   'FT', 'total', 'Second total line for the same fixture.'),
  ('1X2_1H',         'MATCH_WINNER', 'H1', 'none',  'First-half 1X2 — a different canonical market from full time.')
) as v(provider_key, canonical_code, period, line_type, notes)
where s.key = 'mock'
on conflict (source_id, provider_key) do nothing;

-- ---------------------------------------------------------------------
-- 5. HISTORY RETENTION, PER MARKET TYPE
-- ---------------------------------------------------------------------
-- capture_published_history: keep the movement of the price the website shows.
--   Default is TRUE when a row is absent (today's behaviour), so this only
--   exists to be able to turn a noisy market OFF.
-- capture_source_history: keep every provider's own movement. OFF by default
--   because a 3-second live poll on thousands of fixtures would otherwise
--   write millions of rows. Turn it on for the markets whose movement matters.
insert into odds_history_rules (market_type_id, capture_published_history, capture_source_history, notes)
select mt.id, true, true, 'Primary football market — full movement history retained.'
from market_types mt where mt.code = 'MATCH_WINNER'
on conflict (market_type_id) do nothing;

insert into odds_history_rules (market_type_id, capture_published_history, capture_source_history, notes)
select mt.id, true, true, 'Totals lines — full movement history retained.'
from market_types mt where mt.code = 'OVER_UNDER'
on conflict (market_type_id) do nothing;

insert into odds_history_rules (market_type_id, capture_published_history, capture_source_history, notes)
select mt.id, true, true, 'BTTS — full movement history retained.'
from market_types mt where mt.code = 'BTTS'
on conflict (market_type_id) do nothing;

insert into odds_history_rules (market_type_id, capture_published_history, capture_source_history, notes)
select mt.id, true, false, 'Published price history only; provider-level history not retained.'
from market_types mt where mt.code in ('SPREADS', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'CORRECT_SCORE')
on conflict (market_type_id) do nothing;

-- ---------------------------------------------------------------------
-- 6. SANITY CHECKS (read-only; uncomment to run)
-- ---------------------------------------------------------------------
-- Canonical identity coverage — both must be 0 after the backfill:
--   select count(*) from markets    where canonical_key is null;
--   select count(*) from selections where outcome_key  is null;
--
-- Review queue (markets the engine had to guess or could not map):
--   select os.key, r.provider_key, r.canonical_code, r.review_status
--   from odds_market_rules r join odds_sources os on os.id = r.source_id
--   where r.review_status in ('pending', 'auto')
--   order by os.key, r.provider_key;
--
-- To promote a guessed market to a proper canonical one, update the row:
--   update odds_market_rules set canonical_code = 'BTTS', review_status = 'mapped'
--   where source_id = (select id from odds_sources where key = 'the-odds-api')
--     and provider_key = 'btts';
--   -- then re-run the engine's catalogue sync so existing rows adopt the code.
--
-- History retention overview:
--   select mt.code, r.capture_published_history, r.capture_source_history
--   from odds_history_rules r join market_types mt on mt.id = r.market_type_id
--   order by mt.code;
-- ---------------------------------------------------------------------
