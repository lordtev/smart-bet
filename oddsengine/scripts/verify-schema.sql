-- =====================================================================
-- SMARTBET ODDS ENGINE — ACCEPTANCE CHECK
-- =====================================================================
-- Read-only. Paste this into the Supabase SQL Editor AFTER running:
--   1. supabase/migrations/20260101000700_odds_engine.sql
--   2. supabase/migrations/20260101000800_odds_market_rules.sql
--
-- It returns ONE result set. Every row must say PASS. Any FAIL row names the
-- object that is missing or wrong, so there is no guesswork.
--
-- It changes nothing: no DDL, no DML, no locks beyond a catalogue read.
-- =====================================================================

with checks as (

  -- ── 1. Tables ────────────────────────────────────────────────────────
  select 'table' as area, 'odds_sources' as object, 'exists' as expected,
         case when to_regclass('public.odds_sources') is not null then 'exists' else 'MISSING' end as actual
  union all select 'table', 'odds_source_links', 'exists',
         case when to_regclass('public.odds_source_links') is not null then 'exists' else 'MISSING' end
  union all select 'table', 'odds_market_rules', 'exists',
         case when to_regclass('public.odds_market_rules') is not null then 'exists' else 'MISSING' end
  union all select 'table', 'odds_quotes', 'exists',
         case when to_regclass('public.odds_quotes') is not null then 'exists' else 'MISSING' end
  union all select 'table', 'odds_history_rules', 'exists',
         case when to_regclass('public.odds_history_rules') is not null then 'exists' else 'MISSING' end
  union all select 'table', 'odds_source_health', 'exists',
         case when to_regclass('public.odds_source_health') is not null then 'exists' else 'MISSING' end
  union all select 'table', 'odds_worker_runs', 'exists',
         case when to_regclass('public.odds_worker_runs') is not null then 'exists' else 'MISSING' end

  -- ── 2. Columns added to the existing catalogue ───────────────────────
  union all select 'column', 'markets.period', 'present',
         case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'markets' and column_name = 'period')
              then 'present' else 'MISSING' end
  union all select 'column', 'markets.canonical_key', 'present',
         case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'markets' and column_name = 'canonical_key')
              then 'present' else 'MISSING' end
  union all select 'column', 'selections.outcome_key', 'present',
         case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'selections' and column_name = 'outcome_key')
              then 'present' else 'MISSING' end
  union all select 'column', 'odds_history.source_id', 'present',
         case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'odds_history' and column_name = 'source_id')
              then 'present' else 'MISSING' end
  union all select 'column', 'odds_history.provider_updated_at', 'present',
         case when exists (select 1 from information_schema.columns
                           where table_schema = 'public' and table_name = 'odds_history' and column_name = 'provider_updated_at')
              then 'present' else 'MISSING' end

  -- ── 3. Identity indexes (the engine's upserts depend on these) ───────
  union all select 'index', 'uq_markets_event_canonical_key', 'exists',
         case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_markets_event_canonical_key')
              then 'exists' else 'MISSING' end
  union all select 'index', 'uq_selections_market_outcome_key', 'exists',
         case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_selections_market_outcome_key')
              then 'exists' else 'MISSING' end
  union all select 'index', 'uq_odds_sources_single_pricing_source', 'exists',
         case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_odds_sources_single_pricing_source')
              then 'exists' else 'MISSING' end
  union all select 'index', 'odds_quotes (source, bookmaker, selection) unique', 'exists',
         case when exists (
                select 1 from pg_indexes
                where schemaname = 'public' and tablename = 'odds_quotes' and indexdef ilike '%unique%'
                  and indexdef ilike '%bookmaker_key%')
              then 'exists' else 'MISSING' end

  -- ── 4. Functions ─────────────────────────────────────────────────────
  union all select 'function', 'odds_apply_quotes(uuid, jsonb, boolean, integer)', 'exists',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.proname = 'odds_apply_quotes' and p.pronargs = 4)
              then 'exists' else 'MISSING' end
  union all select 'function', 'odds_publish_prices(uuid, integer)', 'exists',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.proname = 'odds_publish_prices' and p.pronargs = 2)
              then 'exists' else 'MISSING' end
  union all select 'function', 'odds_line_key(numeric)', 'exists',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.proname = 'odds_line_key')
              then 'exists' else 'MISSING' end
  union all select 'function', 'log_odds_change() is rules-aware', 'exists',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'public' and p.proname = 'log_odds_change'
                             and pg_get_functiondef(p.oid) ilike '%capture_published_history%')
              then 'exists' else 'MISSING' end

  -- ── 5. Backfill: canonical identity coverage ─────────────────────────────────
  union all select 'backfill', 'markets without canonical_key', '0',
         case when to_regclass('public.markets') is null then 'n/a'
              else (select count(*)::text from public.markets where canonical_key is null) end
  union all select 'backfill', 'selections without outcome_key', '0',
         case when to_regclass('public.selections') is null then 'n/a'
              else (select count(*)::text from public.selections where outcome_key is null) end

  -- ── 6. Critical constraints still in place ──────────────────────────
  union all select 'constraint', 'odds_quotes.odds >= 1.001', 'exists',
         case when exists (select 1 from pg_constraint
                           where conrelid = to_regclass('public.odds_quotes') and contype = 'c'
                             and pg_get_constraintdef(oid) ilike '%1.001%')
              then 'exists' else 'MISSING' end
  union all select 'constraint', 'odds_history.source_id FK (restrict)', 'exists',
         case when exists (select 1 from pg_constraint
                           where conrelid = to_regclass('public.odds_history') and contype = 'f'
                             and pg_get_constraintdef(oid) ilike '%odds_sources%')
              then 'exists' else 'MISSING' end

  -- ── 7. RLS enabled on every new table ───────────────────────────────
  union all select 'rls', 'all 7 odds_* tables have RLS', 'enabled',
         case when (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relrowsecurity
                      and c.relname in ('odds_sources','odds_source_links','odds_market_rules','odds_quotes',
                                        'odds_history_rules','odds_source_health','odds_worker_runs')) = 7
              then 'enabled' else 'INCOMPLETE' end

  -- ── 8. Seed data from 20260101000800 ────────────────────────────────
  union all select 'seed', 'odds_sources rows (mock, the-odds-api)', '2',
         case when to_regclass('public.odds_sources') is null then 'n/a'
              else (select count(*)::text from public.odds_sources where key in ('mock', 'the-odds-api')) end
  union all select 'seed', 'market_types added by the engine', '13',
         case when to_regclass('public.market_types') is null then 'n/a'
              else (select count(*)::text from public.market_types
                    where code in ('SPREADS','MATCH_WINNER_LAY','WINNER_LAY','HALF_TIME_FULL_TIME',
                                   'TEAM_TOTAL','CORNERS_1X2','TO_QUALIFY')) end
  union all select 'seed', 'the-odds-api market rules', '>=21',
         case when to_regclass('public.odds_market_rules') is null then 'n/a'
              else (select count(*)::text from public.odds_market_rules r
                    join public.odds_sources s on s.id = r.source_id
                    where s.key = 'the-odds-api') end
  union all select 'seed', 'mock market rules', '6',
         case when to_regclass('public.odds_market_rules') is null then 'n/a'
              else (select count(*)::text from public.odds_market_rules r
                    join public.odds_sources s on s.id = r.source_id
                    where s.key = 'mock') end
  union all select 'seed', 'history rules rows', '>=8',
         case when to_regclass('public.odds_history_rules') is null then 'n/a'
              else (select count(*)::text from public.odds_history_rules) end

  -- ── 9. The website's trigger is still attached ──────────────────────
  union all select 'trigger', 'trg_selection_odds on selections', 'exists',
         case when exists (select 1 from pg_trigger where tgname = 'trg_selection_odds' and not tgisinternal)
              then 'exists' else 'MISSING' end
  union all select 'trigger', 'trg_selections_upd on selections', 'exists',
         case when exists (select 1 from pg_trigger where tgname = 'trg_selections_upd' and not tgisinternal)
              then 'exists' else 'MISSING' end
)

select
  area,
  object,
  expected,
  actual,
  case
    when actual = expected then 'PASS'
    when expected = '>=21' and actual ~ '^[0-9]+$' and actual::int >= 21 then 'PASS'
    when expected = '>=8'  and actual ~ '^[0-9]+$' and actual::int >= 8  then 'PASS'
    when actual = 'n/a' then 'SKIP (table missing)'
    else 'FAIL'
  end as status
from checks
order by
  case area
    when 'table' then 1 when 'column' then 2 when 'index' then 3 when 'function' then 4
    when 'backfill' then 5 when 'constraint' then 6 when 'rls' then 7 when 'seed' then 8
    else 9
  end,
  object;
