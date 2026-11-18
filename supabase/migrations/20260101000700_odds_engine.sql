-- =====================================================================
-- SMARTBET — ODDS ENGINE SCHEMA  (additive only)
-- =====================================================================
-- Run this in the Supabase SQL Editor AFTER every other migration
-- (000000 … 000600). Then run 20260101000800_odds_market_rules.sql.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- The existing catalogue (sports → leagues → teams → events → market_types →
-- markets → selections) is provider-neutral and is REUSED as-is. Two things it
-- cannot express are the reason for every object below:
--
--   1. `selections.odds` is a single price column. It is the price the website
--      renders AND the price `place_bet()` freezes onto a bet leg, so it must
--      stay the *published* price — but it cannot hold one quote per provider.
--   2. Nothing in the catalogue gives a provider's own identifiers a stable
--      home, so a second feed would either collide with `events.external_id`
--      (globally UNIQUE, currently occupied by the demo rows m1…m12) or have to
--      overwrite the first feed's data.
--
-- The model added here:
--
--   odds_sources      one row per provider / bookmaker / aggregator
--   odds_quotes       CURRENT odds, keyed (source, selection) — never merged
--   odds_history      (existing table, extended) price movement, per source
--   odds_source_links provider fixture id → events.id
--   odds_market_rules provider market key → canonical code / period / line type
--   odds_history_rules per-market-type retention switches
--   odds_source_health + odds_worker_runs   operational visibility
--
-- `selections.odds` is then filled by an explicit *publication* step from
-- exactly one source at a time (`odds_sources.is_pricing_source`), which is why
-- adding a second provider can never disturb the first provider's quotes.
--
-- SAFETY
-- ------
--   * No table, column, policy, function or row is dropped, renamed or narrowed.
--   * Every change to an existing table is additive: new nullable column, or
--     NOT NULL with a DEFAULT that backfills correctly.
--   * The one replaced function, log_odds_change(), keeps today's behaviour
--     exactly when no odds_history_rules row exists for a market type.
--   * The whole file is idempotent apart from the guarded duplicate checks.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. HELPERS
-- ---------------------------------------------------------------------

-- Numeric → stable text for canonical market keys.
-- MUST stay identical in behaviour to oddsengine/src/normalize/canonical.ts
-- (lineKey()):  2.50 -> '2.5'   3.00 -> '3'   -1.25 -> '-1.25'   2.25 -> '2.25'
create or replace function odds_line_key(p_line numeric) returns text
language sql immutable as $$
  select case
    when p_line is null then ''
    else trim(trailing '.' from trim(trailing '0' from round(p_line, 3)::text))
  end
$$;

-- Never let one malformed provider field abort a whole ingest batch.
create or replace function odds_safe_numeric(p_text text) returns numeric
language plpgsql immutable as $$
begin
  if p_text is null or btrim(p_text) = '' then return null; end if;
  begin
    return btrim(p_text)::numeric;
  exception when others then
    return null;
  end;
end $$;

create or replace function odds_safe_timestamptz(p_text text) returns timestamptz
language plpgsql immutable as $$
begin
  if p_text is null or btrim(p_text) = '' then return null; end if;
  begin
    return btrim(p_text)::timestamptz;
  exception when others then
    return null;
  end;
end $$;

-- ---------------------------------------------------------------------
-- 1. EXTEND THE EXISTING CATALOGUE (additive)
-- ---------------------------------------------------------------------

-- Full-time vs first-half vs first-quarter … Two providers' "Over 2.5" for
-- different periods are different markets and must never be merged.
-- Expected values: FT, H1, H2, Q1..Q4, P1..P3, S1, S2, I1..I7 (baseball innings).
-- Left as free text on purpose so a new sport never needs a migration.
alter table markets    add column if not exists period        text not null default 'FT';

-- Canonical identity of a market instance, formatted
--     <CANONICAL_CODE>|<PERIOD>|<LINE_KEY>|<SUBJECT_KEY>
-- e.g. MATCH_WINNER|FT||            (1X2, full time)
--      OVER_UNDER|FT|2.5|           (total goals over/under 2.5)
--      ALTERNATE_TOTALS|FT|3.5|     (an alternate line)
--      PLAYER_POINTS|FT|25.5|lebron_james   (player prop: subject = player)
-- NULL for rows created by hand / by the demo seed before this migration.
-- NULLs are allowed to repeat, so legacy rows are untouched.
alter table markets    add column if not exists canonical_key text;

-- Canonical identity of an outcome inside a market: HOME, DRAW, AWAY, OVER,
-- UNDER, YES, NO, HOME_OR_DRAW, DRAW_OR_AWAY, HOME_OR_AWAY, CS_2_1, NAME_<slug>.
-- NULL for legacy rows.
alter table selections add column if not exists outcome_key   text;

-- One history table serves both purposes:
--   source_id IS NULL → the published price line the website shows (today's data)
--   source_id NOT NULL → that provider's own movement for the selection
alter table odds_history add column if not exists source_id uuid;
alter table odds_history add column if not exists provider_updated_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. NEW TABLES
-- ---------------------------------------------------------------------

-- 2.1 Sources ---------------------------------------------------------
-- One row per upstream FEED, not per bookmaker. A feed that carries several
-- bookmakers (The Odds API does) keeps them as the `bookmaker_key` dimension
-- on odds_quotes, so market-mapping rules stay attached to the feed and do not
-- have to be duplicated per bookmaker.
-- kind 'provider' / 'bookmaker' = an upstream odds feed.
-- kind 'aggregate'              = a derived row (best price, average, …) that
--                                 the engine writes so aggregated odds live in
--                                 the same table as bookmaker odds but can
--                                 never be confused with them.
create table if not exists odds_sources (
  id                     uuid primary key default gen_random_uuid(),
  key                    text not null unique,          -- 'mock', 'the-odds-api'
  name                   text not null,
  kind                   text not null default 'provider'
                           check (kind in ('provider', 'bookmaker', 'aggregate')),
  is_enabled             boolean not null default false, -- mirrors ENABLED_PROVIDERS
  priority               int not null default 100,       -- lower wins in comparisons
  is_pricing_source      boolean not null default false, -- publishes to selections.odds
  -- Which bookmaker inside this feed publishes the book's price:
  --   NULL → every bookmaker of the feed (only sane for single-book feeds)
  --   'draftkings' → that one bookmaker only
  pricing_bookmaker_key  text,
  supports_live          boolean not null default true,
  supports_prematch      boolean not null default true,
  -- Non-secret provider settings only (region list, market list, timeouts…).
  -- API keys live exclusively in the engine's environment.
  config                 jsonb not null default '{}'::jsonb,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- At most ONE enabled pricing source, enforced by the database rather than by
-- engine discipline. Switch it with a single UPDATE.
create unique index if not exists uq_odds_sources_single_pricing_source
  on odds_sources ((true))
  where is_pricing_source and is_enabled;

-- 2.2 Provider fixture identity --------------------------------------
-- Replaces any temptation to reuse events.external_id (which is globally
-- UNIQUE and already used by the demo data). Real FK, so no orphan links.
create table if not exists odds_source_links (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references odds_sources(id) on delete cascade,
  external_key  text not null,                          -- provider's fixture id
  event_id      uuid not null references events(id) on delete cascade,
  match_method  text not null default 'created'
                  check (match_method in ('linked', 'exact_name_kickoff', 'fuzzy_name', 'created', 'manual')),
  confidence    numeric(4,3) not null default 1.000 check (confidence >= 0 and confidence <= 1),
  metadata      jsonb not null default '{}'::jsonb,     -- raw provider teams / league names
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (source_id, external_key)
);

create index if not exists idx_odds_source_links_event
  on odds_source_links (event_id);
create index if not exists idx_odds_source_links_source_event
  on odds_source_links (source_id, event_id);

-- 2.3 Market mapping rules (+ the unknown-market review queue) --------
-- A row with review_status 'pending' and canonical_code NULL *is* the review
-- queue entry: nothing is silently discarded, it is recorded and listed.
create table if not exists odds_market_rules (
  id             uuid primary key default gen_random_uuid(),
  source_id      uuid not null references odds_sources(id) on delete cascade,
  provider_key   text not null,                          -- provider's market key
  canonical_code text references market_types(code) on update cascade,
  period         text not null default 'FT',
  -- 'none'   = one market per provider key (1X2, BTTS, correct score …)
  -- 'total'  = provider may return several lines in one payload, so it expands
  --            into one canonical market per line (and per subject, which is how
  --            player props split into one market per player)
  -- 'spread' / 'handicap' = same expansion, outcomes are teams rather than
  --            Over/Under.
  line_type      text not null default 'none'
                   check (line_type in ('none', 'total', 'spread', 'handicap')),
  -- Optional provider-outcome → canonical outcome_key overrides, e.g.
  -- {"1":"HOME","X":"DRAW","2":"AWAY"}
  outcome_map    jsonb not null default '{}'::jsonb,
  review_status  text not null default 'mapped'
                   check (review_status in ('mapped', 'auto', 'pending', 'ignored')),
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (source_id, provider_key),
  constraint odds_market_rules_mapped_needs_code
    check (review_status not in ('mapped') or canonical_code is not null)
);

create index if not exists idx_odds_market_rules_review
  on odds_market_rules (source_id, review_status);

-- 2.4 CURRENT odds, one row per (source, bookmaker, selection) -------
-- This is the table that guarantees provider isolation: the unique key means a
-- provider/bookmaker can only ever write its own row. Two feeds quoting the
-- same selection live side by side and are never merged.
create table if not exists odds_quotes (
  id                   uuid primary key default gen_random_uuid(),
  source_id            uuid not null references odds_sources(id) on delete cascade,
  bookmaker_key        text not null default 'default',  -- bookmaker inside the feed
  selection_id         uuid not null references selections(id) on delete cascade,
  odds                 numeric(10,3) not null check (odds >= 1.001 and odds <= 1000),
  status               text not null default 'open'
                         check (status in ('open', 'suspended', 'closed')),
  provider_line        numeric(10,3),
  provider_updated_at  timestamptz,                      -- provider's own timestamp
  received_at          timestamptz not null default now(),  -- local receipt time
  last_seen_at         timestamptz not null default now(),  -- last poll that contained it
  last_changed_at      timestamptz not null default now(),  -- last time the value changed
  source_event_key     text,
  source_market_key    text,
  source_selection_key text,
  payload              jsonb not null default '{}'::jsonb,
  unique (source_id, bookmaker_key, selection_id)
);

-- Hot paths: "publish one source", "what does this fixture cost at each book".
create index if not exists idx_odds_quotes_source_changed
  on odds_quotes (source_id, bookmaker_key, last_changed_at desc);
create index if not exists idx_odds_quotes_selection
  on odds_quotes (selection_id);

-- 2.5 Per-market history retention ----------------------------------
-- Absent row = published history captured (today's behaviour), provider
-- history NOT captured. Provider history is opt-in per market type, which is
-- what keeps a 3-second live poll from writing millions of rows.
create table if not exists odds_history_rules (
  market_type_id             uuid primary key references market_types(id) on delete cascade,
  capture_published_history  boolean not null default true,
  capture_source_history     boolean not null default false,
  min_change_pct             numeric(6,3) not null default 0 check (min_change_pct >= 0),
  notes                      text,
  updated_at                 timestamptz not null default now()
);

-- 2.6 Operational visibility ----------------------------------------
create table if not exists odds_source_health (
  source_id             uuid not null references odds_sources(id) on delete cascade,
  worker                text not null check (worker in ('live', 'prematch', 'manual')),
  last_attempt_at       timestamptz,
  last_success_at       timestamptz,
  last_error_at         timestamptz,
  last_error            text,
  consecutive_failures  int not null default 0,
  total_requests        bigint not null default 0,
  total_failures        bigint not null default 0,
  fixtures_seen         bigint not null default 0,
  quotes_seen           bigint not null default 0,
  quotes_changed        bigint not null default 0,
  stale_since           timestamptz,
  rate_limited_until    timestamptz,
  quota_remaining       bigint,
  quota_used            bigint,
  updated_at            timestamptz not null default now(),
  primary key (source_id, worker)
);

create table if not exists odds_worker_runs (
  id          bigint generated always as identity primary key,
  source_id   uuid references odds_sources(id) on delete cascade,
  worker      text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running'
                check (status in ('running', 'succeeded', 'failed', 'aborted')),
  stats       jsonb not null default '{}'::jsonb,
  error       text
);

create index if not exists idx_odds_worker_runs_worker
  on odds_worker_runs (worker, started_at desc);
create index if not exists idx_odds_worker_runs_source
  on odds_worker_runs (source_id, started_at desc);

-- ---------------------------------------------------------------------
-- 3. BACKFILL THE EXISTING CATALOGUE
-- ---------------------------------------------------------------------
-- Makes the demo rows part of the canonical scheme so a real feed adopts them
-- instead of creating a parallel set of markets for the same fixture.

update markets m
set canonical_key = mt.code || '|' || m.period || '|' || odds_line_key(m.line) || '|'
from market_types mt
where mt.id = m.market_type_id
  and m.canonical_key is null;

-- Outcome keys: explicit vocabulary first, then home/away team names, then a
-- stable name slug so nothing is left without an identity.
with mapped as (
  select
    s.id as selection_id,
    rtrim(
      case
        when lower(btrim(s.name)) = 'home'                        then 'HOME'
        when lower(btrim(s.name)) = 'draw'                        then 'DRAW'
        when lower(btrim(s.name)) = 'away'                        then 'AWAY'
        when lower(btrim(s.name)) = 'home or draw'                then 'HOME_OR_DRAW'
        when lower(btrim(s.name)) = 'home or away'                then 'HOME_OR_AWAY'
        when lower(btrim(s.name)) = 'draw or away'                then 'DRAW_OR_AWAY'
        when lower(btrim(s.name)) = 'yes'                         then 'YES'
        when lower(btrim(s.name)) = 'no'                          then 'NO'
        when lower(btrim(s.name)) like 'over%'                    then 'OVER'
        when lower(btrim(s.name)) like 'under%'                   then 'UNDER'
        when ht.id is not null and lower(btrim(s.name)) = lower(btrim(ht.name)) then 'HOME'
        when at.id is not null and lower(btrim(s.name)) = lower(btrim(at.name)) then 'AWAY'
        else 'NAME_' || upper(regexp_replace(btrim(s.name), '[^a-zA-Z0-9]+', '_', 'g'))
      end, '_') as outcome_key
  from selections s
  join markets  m  on m.id = s.market_id
  join events   e  on e.id = m.event_id
  left join teams ht on ht.id = e.home_team_id
  left join teams at on at.id = e.away_team_id
  where s.outcome_key is null
)
update selections s
set outcome_key = mapped.outcome_key
from mapped
where s.id = mapped.selection_id;

-- Guard: refuse to add identity indexes if the existing data cannot satisfy
-- them. Reads clearly instead of failing on a duplicate-key error later.
do $$
declare
  v_dupes text;
begin
  select string_agg(msg, E'\n') into v_dupes from (
    select 'markets: ' || event_id || ' / ' || canonical_key || ' x' || count(*) as msg
    from markets
    where canonical_key is not null
    group by event_id, canonical_key having count(*) > 1
    union all
    select 'selections: ' || market_id || ' / ' || outcome_key || ' x' || count(*) as msg
    from selections
    where outcome_key is not null
    group by market_id, outcome_key having count(*) > 1
  ) d;

  if v_dupes is not null then
    raise exception E'Canonical key backfill produced duplicates — resolve these rows, then re-run:\n%', v_dupes;
  end if;
end $$;

-- Identity indexes. Plain column lists (no expressions, no predicates) so
-- PostgREST upserts can use them via on_conflict. NULL keys are allowed to
-- repeat, leaving hand-created / legacy rows untouched.
create unique index if not exists uq_markets_event_canonical_key
  on markets (event_id, canonical_key);
create unique index if not exists uq_selections_market_outcome_key
  on selections (market_id, outcome_key);

create index if not exists idx_odds_history_source_selection
  on odds_history (source_id, selection_id, recorded_at desc);

-- ---------------------------------------------------------------------
-- 4. CONSTRAINTS ADDED AFTER THE COLUMNS EXIST
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'odds_history_source_fk') then
    -- RESTRICT on purpose: a source must be disabled, never deleted, otherwise
    -- its history would disappear. Requirement: history is never destroyed
    -- because a quote went away.
    alter table odds_history
      add constraint odds_history_source_fk
      foreign key (source_id) references odds_sources(id) on delete restrict;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. REPLACE log_odds_change() — rules-aware, behaviour-preserving
-- ---------------------------------------------------------------------
-- Today every change to selections.odds is logged. That stays true: when no
-- odds_history_rules row exists for the market type, capture_published_history
-- defaults to TRUE. Add a row only to turn a market off.
create or replace function log_odds_change() returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_capture boolean;
begin
  if new.odds is distinct from old.odds then
    select coalesce(r.capture_published_history, true)
      into v_capture
    from markets m
    left join odds_history_rules r on r.market_type_id = m.market_type_id
    where m.id = new.market_id;

    if coalesce(v_capture, true) then
      insert into odds_history (selection_id, odds, source_id, recorded_at)
      values (new.id, new.odds, null, now());
    end if;
  end if;
  return new;
end $$;

-- =====================================================================
-- 6. INGEST — CURRENT ODDS + HISTORY, ONE ATOMIC STATEMENT
-- =====================================================================
-- Contract (JSON array element):
-- {
--   "selection_id":         "<uuid>",            required
--   "odds":                 2.05,                required, 1.001 … 1000, rounded to 3dp
--   "bookmaker_key":        "draftkings",        optional, default "default"
--   "status":               "open"|"suspended"|"closed"   optional, default "open"
--   "provider_line":        2.5,                 optional
--   "provider_updated_at":  "2026-09-26T12:00:00Z"        optional (provider's own clock)
--   "source_event_key":     "…",                 optional
--   "source_market_key":    "…",                 optional
--   "source_selection_key": "…",                 optional
--   "payload":              { … }                optional
-- }
--
-- Guarantees:
--   * never writes a quote older than the one already stored (provider_updated_at
--     guard) — an out-of-order response cannot roll back newer odds;
--   * writes nothing at all for an unchanged quote, apart from an optional
--     heartbeat on last_seen_at at most once per p_heartbeat_seconds;
--   * unknown / malformed rows are counted, never thrown, so one bad provider
--     field cannot abort a batch;
--   * history rows are written only when the quote actually changed AND the
--     market type opted into provider history;
--   * never touches another source's (or another bookmaker's) rows.
create or replace function odds_apply_quotes(
  p_source_id          uuid,
  p_quotes             jsonb,
  p_capture_history    boolean default true,
  p_heartbeat_seconds  integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ts       timestamptz := clock_timestamp();
  v_received int;
  v_out      jsonb;
begin
  if p_source_id is null then
    raise exception 'odds_apply_quotes: p_source_id is required';
  end if;
  if not exists (select 1 from odds_sources where id = p_source_id) then
    raise exception 'odds_apply_quotes: unknown odds source %', p_source_id;
  end if;
  if p_quotes is null or jsonb_typeof(p_quotes) <> 'array' then
    raise exception 'odds_apply_quotes: p_quotes must be a JSON array';
  end if;

  v_received := jsonb_array_length(p_quotes);
  if v_received = 0 then
    return jsonb_build_object(
      'received', 0, 'accepted', 0, 'invalid', 0, 'touched', 0, 'changed', 0,
      'inserted', 0, 'heartbeat', 0, 'skipped', 0, 'stale', 0, 'history', 0,
      'applied_at', v_ts);
  end if;

  with raw as (
    select
      e.elem,
      nullif(btrim(coalesce(e.elem ->> 'selection_id', '')), '')        as selection_id_txt,
      nullif(btrim(coalesce(e.elem ->> 'odds', '')), '')                as odds_txt,
      nullif(btrim(coalesce(e.elem ->> 'bookmaker_key', '')), '')       as bookmaker_key_txt,
      lower(nullif(btrim(coalesce(e.elem ->> 'status', '')), ''))       as status_txt,
      nullif(btrim(coalesce(e.elem ->> 'provider_line', '')), '')       as line_txt,
      nullif(btrim(coalesce(e.elem ->> 'provider_updated_at', '')), '') as updated_txt,
      nullif(btrim(coalesce(e.elem ->> 'source_event_key', '')), '')    as source_event_key,
      nullif(btrim(coalesce(e.elem ->> 'source_market_key', '')), '')   as source_market_key,
      nullif(btrim(coalesce(e.elem ->> 'source_selection_key', '')), '')as source_selection_key,
      case when jsonb_typeof(e.elem -> 'payload') = 'object'
           then e.elem -> 'payload' else '{}'::jsonb end                as payload
    from jsonb_array_elements(p_quotes) as e(elem)
  ),
  typed as (
    select
      case when r.selection_id_txt
             ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           then r.selection_id_txt::uuid end                            as selection_id,
      coalesce(r.bookmaker_key_txt, 'default')                          as bookmaker_key,
      case when r.odds_txt is not null then round(odds_safe_numeric(r.odds_txt), 3) end as odds,
      coalesce(case when r.status_txt in ('open', 'suspended', 'closed')
                    then r.status_txt end, 'open')                      as status,
      case when r.line_txt is not null
           then round(odds_safe_numeric(r.line_txt), 3) end             as provider_line,
      odds_safe_timestamptz(r.updated_txt)                              as provider_updated_at,
      r.source_event_key, r.source_market_key, r.source_selection_key, r.payload
    from raw r
  ),
  accepted as (
    select distinct on (t.bookmaker_key, t.selection_id)
           t.bookmaker_key, t.selection_id, t.odds, t.status, t.provider_line,
           t.provider_updated_at, t.source_event_key, t.source_market_key,
           t.source_selection_key, t.payload
    from typed t
    join selections s on s.id = t.selection_id
    where t.odds is not null
      and t.odds >= 1.001
      and t.odds <= 1000
    order by t.bookmaker_key, t.selection_id, t.provider_updated_at desc nulls last
  ),
  existing as (
    select q.bookmaker_key, q.selection_id, q.odds, q.status, q.provider_line,
           q.provider_updated_at, q.last_seen_at
    from odds_quotes q
    join accepted a
      on a.bookmaker_key = q.bookmaker_key
     and a.selection_id  = q.selection_id
    where q.source_id = p_source_id
  ),
  up as (
    insert into odds_quotes as oq (
      source_id, bookmaker_key, selection_id, odds, status, provider_line, provider_updated_at,
      received_at, last_seen_at, last_changed_at,
      source_event_key, source_market_key, source_selection_key, payload
    )
    select p_source_id, a.bookmaker_key, a.selection_id, a.odds, a.status, a.provider_line,
           coalesce(a.provider_updated_at, v_ts), v_ts, v_ts, v_ts,
           a.source_event_key, a.source_market_key, a.source_selection_key, a.payload
    from accepted a
    on conflict (source_id, bookmaker_key, selection_id) do update set
      odds                = excluded.odds,
      status              = excluded.status,
      provider_line       = excluded.provider_line,
      provider_updated_at = excluded.provider_updated_at,
      received_at         = v_ts,
      last_seen_at        = v_ts,
      last_changed_at     = case
                              when (oq.odds, oq.status, oq.provider_line)
                                   is distinct from
                                   (excluded.odds, excluded.status, excluded.provider_line)
                              then v_ts
                              else oq.last_changed_at
                            end,
      source_event_key      = excluded.source_event_key,
      source_market_key     = excluded.source_market_key,
      source_selection_key  = excluded.source_selection_key,
      payload               = excluded.payload
    where (oq.provider_updated_at is null
           or excluded.provider_updated_at is null
           or excluded.provider_updated_at >= oq.provider_updated_at)
      and (
            (oq.odds, oq.status, oq.provider_line)
            is distinct from
            (excluded.odds, excluded.status, excluded.provider_line)
            or (p_heartbeat_seconds > 0
                and oq.last_seen_at
                    <= v_ts - make_interval(secs => p_heartbeat_seconds))
          )
    returning oq.bookmaker_key, oq.selection_id, oq.odds, oq.status, oq.last_changed_at
  ),
  changed as (
    select * from up where last_changed_at = v_ts
  ),
  hist as (
    insert into odds_history (selection_id, odds, source_id, recorded_at, provider_updated_at)
    select c.selection_id, c.odds, p_source_id, v_ts, null
    from changed c
    join selections s on s.id = c.selection_id
    join markets    m on m.id = s.market_id
    left join odds_history_rules r on r.market_type_id = m.market_type_id
    where p_capture_history
      and coalesce(r.capture_source_history, false)
    returning 1
  )
  select jsonb_build_object(
    'received',  v_received,
    'accepted',  (select count(*) from accepted),
    'invalid',   v_received - (select count(*) from accepted),
    'touched',   (select count(*) from up),
    'changed',   (select count(*) from changed),
    'inserted',  (select count(*) from changed c
                  where not exists (select 1 from existing e
                                    where e.bookmaker_key = c.bookmaker_key
                                      and e.selection_id  = c.selection_id)),
    'heartbeat', (select count(*) from up u where u.last_changed_at <> v_ts),
    'skipped',   (select count(*) from accepted)
                 - (select count(*) from up),
    'stale',     (select count(*) from accepted a
                  join existing e
                    on e.bookmaker_key = a.bookmaker_key
                   and e.selection_id  = a.selection_id
                  where a.provider_updated_at is not null
                    and e.provider_updated_at is not null
                    and a.provider_updated_at < e.provider_updated_at),
    'history',   (select count(*) from hist),
    'applied_at', v_ts
  ) into v_out;

  return v_out;
end $$;

-- =====================================================================
-- 7. PUBLISH — pricing source → selections.odds (what the website reads)
-- =====================================================================
-- Only called for the source flagged is_pricing_source, and only for the
-- bookmaker(s) named in odds_sources.pricing_bookmaker_key. Consequences of
-- that split, all of which are the point of it:
--   * a second provider can be fetched, stored and compared without ever
--     touching the price a bet is settled at;
--   * a provider outage changes nothing, because rows that were not received
--     are simply not in odds_quotes yet — nothing is deleted or suspended;
--   * switching the book's price feed is one UPDATE on odds_sources.
-- Settled / void markets, finished events and already-settled selections are
-- never touched.
create or replace function odds_publish_prices(
  p_source_id              uuid,
  p_max_staleness_seconds  integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ts        timestamptz := clock_timestamp();
  v_src       odds_sources%rowtype;
  v_prices    int := 0;
  v_statuses  int := 0;
begin
  if p_source_id is null then
    raise exception 'odds_publish_prices: p_source_id is required';
  end if;

  select * into v_src from odds_sources where id = p_source_id;

  if not found then
    raise exception 'odds_publish_prices: unknown odds source %', p_source_id;
  end if;
  if not v_src.is_pricing_source then
    raise exception 'odds_publish_prices: source % is not the pricing source', v_src.key;
  end if;

  -- 7.1 prices
  with target as (
    select s.id as selection_id, q.odds
    from odds_quotes q
    join selections s on s.id = q.selection_id
    join markets    m on m.id = s.market_id
    join events     e on e.id = m.event_id
    where q.source_id   = p_source_id
      and (v_src.pricing_bookmaker_key is null
           or q.bookmaker_key = v_src.pricing_bookmaker_key)
      and q.status      = 'open'
      and s.status in ('active', 'suspended')
      and m.status in ('open', 'suspended')
      and e.status in ('scheduled', 'live')
      and s.odds is distinct from q.odds
      and (p_max_staleness_seconds <= 0
           or q.last_seen_at >= v_ts - make_interval(secs => p_max_staleness_seconds))
  ),
  upd as (
    update selections s
    set odds = t.odds
    from target t
    where s.id = t.selection_id
    returning 1
  )
  select count(*) into v_prices from upd;

  -- 7.2 suspension / reopening
  with target as (
    select s.id as selection_id, s.status as old_status,
           case when q.status = 'open'
                then 'active'::selection_status
                else 'suspended'::selection_status end as new_status
    from odds_quotes q
    join selections s on s.id = q.selection_id
    join markets    m on m.id = s.market_id
    join events     e on e.id = m.event_id
    where q.source_id = p_source_id
      and (v_src.pricing_bookmaker_key is null
           or q.bookmaker_key = v_src.pricing_bookmaker_key)
      and s.status in ('active', 'suspended')
      and m.status in ('open', 'suspended')
      and e.status in ('scheduled', 'live')
      and (p_max_staleness_seconds <= 0
           or q.last_seen_at >= v_ts - make_interval(secs => p_max_staleness_seconds))
  ),
  upd as (
    update selections s
    set status = t.new_status
    from target t
    where s.id = t.selection_id
      and t.new_status is distinct from t.old_status
    returning 1
  )
  select count(*) into v_statuses from upd;

  return jsonb_build_object(
    'prices_updated',   v_prices,
    'statuses_updated', v_statuses,
    'published_at',     v_ts
  );
end $$;

-- =====================================================================
-- 8. PRIVILEGES / RLS
-- =====================================================================
-- The odds engine authenticates with the service-role key, which bypasses RLS.
-- Nothing here changes any existing policy: the website keeps reading the
-- catalogue and `selections` exactly as it does today, and never gains access
-- to provider keys or raw provider payloads.
alter table odds_sources       enable row level security;
alter table odds_source_links  enable row level security;
alter table odds_market_rules  enable row level security;
alter table odds_quotes        enable row level security;
alter table odds_history_rules enable row level security;
alter table odds_source_health enable row level security;
alter table odds_worker_runs   enable row level security;

revoke all on odds_sources, odds_source_links, odds_market_rules, odds_quotes,
              odds_history_rules, odds_source_health, odds_worker_runs
  from public, anon, authenticated;

-- Ingestion is server-side only.
revoke all on function odds_apply_quotes(uuid, jsonb, boolean, integer) from public, anon, authenticated;
revoke all on function odds_publish_prices(uuid, integer)               from public, anon, authenticated;
grant execute on function odds_apply_quotes(uuid, jsonb, boolean, integer) to service_role;
grant execute on function odds_publish_prices(uuid, integer)               to service_role;

-- =====================================================================
-- END — verification queries (run manually)
-- =====================================================================
-- Canonical identity coverage (should report 0 uncovered rows):
--   select count(*) from markets where canonical_key is null;
--   select count(*) from selections where outcome_key is null;
--
-- The review queue:
--   select s.key, r.provider_key, r.review_status
--   from odds_market_rules r join odds_sources s on s.id = r.source_id
--   where r.review_status in ('pending', 'auto')
--   order by s.key, r.provider_key;
--
-- Which provider is publishing the book's prices:
--   select key, is_enabled, is_pricing_source, pricing_bookmaker_key, priority
--   from odds_sources order by priority;
--
-- Bookmaker odds side by side for one selection:
--   select s.name as selection, os.key as source, q.bookmaker_key, q.odds,
--          q.status, q.last_changed_at
--   from odds_quotes q
--   join odds_sources os on os.id = q.source_id
--   join selections   s  on s.id = q.selection_id
--   where q.selection_id = '<uuid>'
--   order by q.odds desc;
-- =====================================================================
