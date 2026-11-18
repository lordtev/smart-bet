# SMARTBET Odds Engine

A standalone service that pulls odds from external betting providers, normalises
them into the shared Supabase catalogue, and publishes the book's price into the
same `selections.odds` column the website already reads.

It runs entirely on its own — the website does not need to be running — and it
shares the existing database rather than owning a parallel one.

```
┌───────────────┐   ┌──────────────────────┐   ┌────────────────────┐   ┌──────────────┐
│ Provider API  │──▶│ Provider adapter     │──▶│ Provider-independent│──▶│ Supabase     │
│ (any number)  │   │ auth · parse · quota │   │ core               │   │ shared with  │
└───────────────┘   └──────────────────────┘   └────────────────────┘   │ the website  │
                                                                        └──────────────┘
```

- **One provider today** (The Odds API) plus a full offline mock.
- **Any number tomorrow** — adding one is a new module and a config line, no
  change to the core.
- **Nothing is ever overwritten across providers.** Every quote is keyed by
  `(source, bookmaker, selection)`.

---

## Contents

1. [Architecture](#1-architecture)
2. [Folder structure](#2-folder-structure)
3. [Database model](#3-database-model)
4. [Installation](#4-installation)
5. [Environment configuration](#5-environment-configuration)
6. [Running locally](#6-running-locally)
7. [Enabling and disabling providers](#7-enabling-and-disabling-providers)
8. [Adding another provider](#8-adding-another-provider)
9. [Running individual workers](#9-running-individual-workers)
10. [Running the tests](#10-running-the-tests)
11. [How the engine talks to Supabase](#11-how-the-engine-talks-to-supabase)
12. [Operations: health, staleness, failure](#12-operations-health-staleness-failure)
13. [Deploying independently](#13-deploying-independently)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Architecture

A cycle is five steps, and only the first one is provider-specific:

| Step | What happens | Provider-specific? |
| --- | --- | --- |
| **A. Fetch** | The adapter calls its API and returns `NormalizedFixture[]` | **yes** |
| **B. Map** | Provider markets become canonical markets, using rules stored in `odds_market_rules` | no |
| **C. Catalogue** | Missing sports / leagues / teams / events / markets / selections are created; ids are read back | no |
| **D. Ingest** | One SQL statement writes current odds, detects changes, rejects stale quotes, records history | no |
| **E. Publish** | The *pricing source only* writes `selections.odds`, which is what the website shows and what `place_bet()` charges | no |

### The two ideas that make it extensible

**1. Providers only produce normalised data.**
An adapter never touches the database, never knows a canonical market code, and
never writes a price. Its whole job is `fetchFixtures() → NormalizedFixture[]`.

**2. Identity is canonical, not provider-specific.**
Two providers meet on the same row only if their *canonical* identifiers agree:

```
markets.canonical_key   =  <CODE>|<PERIOD>|<LINE>|<SUBJECT>
selections.outcome_key  =  HOME | DRAW | AWAY | OVER | UNDER | YES | NO | CS_2_1 | NAME_…
```

So `MATCH_WINNER|FT||` from provider A and provider B are the same market, while
`OVER_UNDER|FT|2.5|` and `OVER_UNDER|FT|3.5|` are emphatically not — and neither
are full-time and first-half 1X2, nor LeBron's points prop and Curry's.

### Two ways in, one way through

A payload arrives either by **poll** (`fetchFixtures`) or by **push** — a
WebSocket or webhook the provider runs. Both land in the same
`engine.ingest()`, so a pushed update cannot behave differently from a polled
one: same mapping, same change detection, same staleness guard, same publication.

```
poll ─ runCycle() ─┐
                   ├─▶ ingest() ─▶ map ─▶ catalogue ─▶ odds_apply_quotes ─▶ publish
push ─ subscribe() ┘
```

No bundled provider streams today, and none is required: a provider without
`subscribe()` is polled exactly as before. When one does offer a stream, set
`PROVIDER_PUSH_ENABLED=true` and the worker subscribes, coalesces bursts
(`PUSH_DEBOUNCE_MS`), and keeps a slower reconciliation poll
(`PUSH_RECONCILE_INTERVAL_MS`) — because streams drop and webhooks get lost. If
the subscription cannot be established, or later dies, the worker falls back to
plain polling rather than going silent. Pushed payloads that are still queued when
shutdown begins are dropped rather than starting new writes; the next cycle
re-fetches them.

### Why `selections.odds` is written by a separate step

`selections.odds` is read by `src/modules/sportsbook/catalogue.functions.ts` and
re-read by `place_bet()`. It is the price the business settles at. So it is only
ever written by the **one** source flagged `is_pricing_source`. Everything else
lands in `odds_quotes` and is available for comparison without any risk to a
settled bet — which is also why switching price feeds is a one-line change.

### Isolation guarantees

| Risk | What prevents it |
| --- | --- |
| One provider's quote overwriting another's | `odds_quotes` is unique on `(source_id, bookmaker_key, selection_id)` |
| A stale response overwriting a fresh price | `provider_updated_at` guard inside `odds_apply_quotes` |
| An incomplete payload deleting markets | The engine only ever *writes* what it received; nothing is deleted, and suspension only follows an explicit `suspended` status |
| A provider outage suspending the book | A failed cycle writes nothing at all |
| Writing thousands of unchanged rows | Change detection in SQL; a quote is written only when it moves |
| Two sources publishing at once | Partial unique index allows one enabled pricing source |

---

## 2. Folder structure

```
oddsengine/
├── src/
│   ├── config.ts                 env parsing, validation, safe summary
│   ├── bootstrap.ts              assembles the object graph
│   ├── engine.ts                 the cycle: fetch → map → catalogue → ingest → publish
│   ├── cli/main.ts               all commands
│   ├── providers/
│   │   ├── types.ts              THE provider contract (read this first to add one)
│   │   ├── index.ts              registry: one line per provider
│   │   ├── mock.ts               offline provider for development and tests
│   │   └── the-odds-api/
│   │       ├── types.ts          response shapes, from the official OpenAPI schema
│   │       ├── api.ts            auth, request building, quota accounting
│   │       └── adapter.ts        normalisation into NormalizedFixture
│   ├── normalize/
│   │   ├── canonical.ts          canonical keys, periods, outcome vocabulary
│   │   └── odds.ts               decimal/american/fractional, validation, statuses
│   ├── map/market-mapper.ts      provider markets → canonical markets (+ review queue)
│   ├── match/matcher.ts          fixture matching: link → exact → fuzzy → create
│   ├── http/
│   │   ├── client.ts             timeouts, retries, redaction, quota capture
│   │   └── rate-limiter.ts       sliding-window limiter, bounded concurrency
│   ├── db/
│   │   ├── client.ts             service-role Supabase client, table probes
│   │   ├── catalogue.ts          sports/leagues/teams/events/markets/selections
│   │   └── engine.ts             sources, rules, quote RPCs, health, run records
│   ├── workers/worker.ts         polling loop, push subscription, shutdown
│   └── logging/logger.ts         structured logs, secret redaction
├── tests/
│   ├── unit/                     no network, no database
│   └── integration/              real Supabase, auto-skipped until migrated
├── scripts/verify-schema.sql     read-only acceptance check for the migration
├── .env.example
└── package.json
```

`supabase/migrations/20260101000700_odds_engine.sql` and
`20260101000800_odds_market_rules.sql` live in the website repository, next to the
existing migrations.

---

## 3. Database model

The engine **reuses** `sports, leagues, teams, events, market_types, markets,
selections, odds_history` and adds seven tables plus a few columns.

| Object | Purpose |
| --- | --- |
| `odds_sources` | one row per feed (+ future aggregates), enablement, priority, and which one publishes |
| `odds_quotes` | **current odds**, unique on `(source, bookmaker, selection)` |
| `odds_history` (extended) | `source_id IS NULL` = published price line; `source_id` set = that provider's movement |
| `odds_source_links` | provider fixture id → `events.id` (replaces any use of `events.external_id`) |
| `odds_market_rules` | provider market key → canonical code / period / line type, and the unknown-market review queue |
| `odds_history_rules` | per-market retention switches |
| `odds_source_health`, `odds_worker_runs` | operational visibility |

Columns added to existing tables (all additive, all nullable or defaulted):

- `markets.period` (default `'FT'`) and `markets.canonical_key`
- `selections.outcome_key`
- `odds_history.source_id`, `odds_history.provider_updated_at`

Nothing was dropped, renamed or narrowed, and no existing row was deleted.

### Choosing the pricing source

```sql
-- exactly one enabled source may be the pricing source
update odds_sources set is_pricing_source = false where is_pricing_source;
update odds_sources set is_pricing_source = true,
                        pricing_bookmaker_key = 'draftkings'
where key = 'the-odds-api';
```

The engine mirrors `PRICING_PROVIDER` and `PRICING_BOOKMAKER` from the
environment into these columns on startup, so you normally change the
environment rather than the database.

---

## 4. Installation

Requirements: **Node.js 22.6 or newer** (the engine runs TypeScript directly; no
build step) and access to the Supabase project.

```bash
cd oddsengine
npm install
```

Then apply the two migrations in the Supabase SQL editor, in order:

1. `supabase/migrations/20260101000700_odds_engine.sql` — objects (DDL)
2. `supabase/migrations/20260101000800_odds_market_rules.sql` — data (market
   rules, canonical market types, source rows)

Then paste `scripts/verify-schema.sql` into the same editor. It is read-only and
returns one table of PASS/FAIL rows covering every table, column, index, function,
constraint, RLS flag and seed row the engine depends on — so a partial migration
is obvious rather than mysterious.

> **Both files matter.** Running only the first leaves `odds_market_rules` empty,
> and then *every* provider market looks unknown: the engine would auto-map it to
> an `EXT_…` code and publish under a made-up name instead of `MATCH_WINNER` /
> `OVER_UNDER`. `doctor` reports that state as a problem, and the engine logs an
> error the first time it happens.

If you have the service-role key but no SQL-editor access, the data file can be
applied over the API instead — same rows, same idempotent inserts:

```bash
npm run seed -- --dry-run   # show what would be written
npm run seed                # apply
```

Finally verify from the engine itself:

```bash
node src/cli/main.ts doctor
```

`doctor` checks configuration, database connectivity, table and function
presence, canonical-key coverage, seed data, provider credentials and current
health. It exits non-zero if anything is wrong.

---

## 5. Environment configuration

```bash
cp .env.example .env     # then edit
```

Everything is an environment variable; `.env.example` documents each one with
its default. The values that actually matter:

| Variable | Meaning |
| --- | --- |
| `SUPABASE_URL` | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **server-side only.** Never in a browser, never logged |
| `ENABLED_PROVIDERS` | comma-separated provider keys to run (`mock`, `the-odds-api`) |
| `PRICING_PROVIDER` | which of those publishes `selections.odds` |
| `PRICING_BOOKMAKER` | which bookmaker inside it (empty = all) |
| `LIVE_POLL_INTERVAL_MS` | live polling, minimum 2000 ms |
| `PREMETCH_POLL_INTERVAL_MS` | prematch polling, minimum 30 minutes |
| `PROVIDER_PUSH_ENABLED` | prefer a provider's WebSocket/webhook when it has one |
| `PUSH_RECONCILE_INTERVAL_MS` | safety-net poll alongside a live stream |
| `ODDS_HISTORY_ENABLED` | master switch for provider price history |
| `LOG_LEVEL`, `LOG_FORMAT` | `trace…error`, and `pretty` or `json` |

Notes worth knowing:

- **Poll faster ≠ fresher.** The engine refuses a live interval under 2 seconds
  and a prematch interval under 30 minutes, because providers refresh on their
  own schedule and a shorter interval only burns quota.
- **Secrets are redacted.** The service-role key and provider keys are registered
  at startup and scrubbed from every log line and error message, including URLs
  that carry them as query parameters.
- **Local convenience.** If `SUPABASE_*` are absent, the engine reads them from
  the website's `../.env` (see `ODDS_ENV_FALLBACK_FILES`) so you do not have to
  copy a secret into a second file. Set `ODDS_ENV_FALLBACK_FILES=` to disable
  that, which is what a real deployment should do.

---

## 6. Running locally

Nothing below needs the website running.

```bash
cd oddsengine

# 1. Does everything line up? (config, DB, schema, credentials)
node src/cli/main.ts doctor

# 2. What would the engine do? Fetch and map. No odds row is written.
node src/cli/main.ts scan --provider=mock

# 3. One real cycle with the offline provider.
node src/cli/main.ts once --provider=mock

# 4. Continuous, both workers.
node src/cli/main.ts all
```

Then check what landed:

```sql
select s.name, m.name as market, se.name as selection, se.odds, se.status
from selections se
join markets m  on m.id = se.market_id
join events  e  on e.id = m.event_id
join leagues l  on l.id = e.league_id
join sports  s  on s.id = l.sport_id
where l.slug = 'mock-league'
order by 1, 2;
```

The mock provider (`src/providers/mock.ts`) is deterministic per cycle number, so
two runs of the same cycle produce identical payloads — that is what lets the
tests assert "a duplicate response changes nothing". It can also be told to move
prices, suspend markets, omit markets from a payload, or fail outright, which is
how the failure behaviour is exercised without touching a real API.

---

## 7. Enabling and disabling providers

Providers are controlled entirely by environment variables.

```dotenv
# Only the mock
ENABLED_PROVIDERS=mock
PRICING_PROVIDER=mock

# Only The Odds API, publishing DraftKings' prices
ENABLED_PROVIDERS=the-odds-api
PRICING_PROVIDER=the-odds-api
PRICING_BOOKMAKER=draftkings
THE_ODDS_API_KEY=…

# Both at once: The Odds API publishes, the mock is fetched for comparison
ENABLED_PROVIDERS=mock,the-odds-api
PRICING_PROVIDER=the-odds-api
```

To **disable** a provider, remove it from `ENABLED_PROVIDERS`. That is all: its
quotes stay in `odds_quotes` untouched (nothing is deleted), and the next cycle
just does not refresh them. `is_enabled` is mirrored into `odds_sources` so the
database reflects reality.

`ODDS_MOCK_MODE=true` forces the mock and disables every real provider — a
guarantee that a local run or a test suite cannot spend a provider credit.

### The Odds API specifics

```dotenv
THE_ODDS_API_KEY=
THE_ODDS_API_REGIONS=uk              # us | us2 | uk | eu | au
THE_ODDS_API_MARKETS=h2h,spreads,totals
THE_ODDS_API_SPORTS=soccer_epl       # empty = every in-season sport
THE_ODDS_API_BOOKMAKERS=             # optional allowlist; takes priority over regions
THE_ODDS_API_MIN_QUOTA=25            # stop fetching below this many credits
THE_ODDS_API_MAX_CREDITS_PER_CYCLE=0 # hard cap per cycle; 0 = unlimited
```

**Choosing sports.** Leaving `THE_ODDS_API_SPORTS` empty means *every* in-season
sport ? around 70 feeds, about 180 credits per cycle, which is fine once and
ruinous for a 3-second live poll. Two tools make the choice deliberate:

```bash
node src/cli/main.ts sports            # every competition the account can ingest
node src/cli/main.ts sports --probe    # + how many fixtures each holds, and the cost
```

`--probe` uses `/v4/sports/{sport}/events`, which the provider documents as free,
so it spends no quota and prints a ready-to-paste `THE_ODDS_API_SPORTS=` line
ordered by fixture count. Set `THE_ODDS_API_MAX_CREDITS_PER_CYCLE` as a backstop
and a cycle can never outspend it, whatever the sport list says.

> The sport list is ordered by how the provider returns it, so a small credit
> budget with an empty sport list spends itself on whatever comes first ?
> typically American college football and NCAA basketball, not the leagues you
> want. Curate the list.

Quota: **cost = markets × regions** per call, and every response reports
`x-requests-remaining`. The adapter reads it, stores it in `odds_source_health`,
and stops calling when it drops below `THE_ODDS_API_MIN_QUOTA` rather than
failing loudly. `/v4/sports` is free and is used at startup to turn each sport key
into its real `group`/`title`, so no sport taxonomy is invented anywhere.

---

## 8. Adding another provider

Three files and two config lines. No core file changes.

**1. Write the adapter** — `src/providers/<key>/adapter.ts`:

```ts
import type { ProviderAdapter, NormalizedFixture, FetchWindow, AdapterContext } from '../types.ts';

export function createMyProvider(config): ProviderAdapter {
  return {
    key: 'my-provider',
    name: 'My Provider',
    supportsLive: true,
    supportsPrematch: true,
    knownBookmakers: [],

    async init(ctx: AdapterContext) {
      // validate credentials; throw if the provider is unusable
    },

    async fetchFixtures(window: FetchWindow, ctx: AdapterContext): Promise<NormalizedFixture[]> {
      // call the API through ctx.http (retries/timeouts/rate limits are handled)
      // return decimal prices, ISO timestamps, and the provider's own market keys
    },

    getUsage: () => ({ quotaRemaining: null, quotaUsed: null, lastCost: null }),
    async shutdown() {},
  };
}
```

The only rules are: decimal odds, ISO-8601 timestamps, the provider's own market
keys untouched, and `commenceTime` in UTC.

If the provider offers a live stream rather than (or as well as) a REST API, also
implement the optional `subscribe()` method. It receives `onFixtures` /
`onError` handlers and returns a `{ kind, active, stop }` subscription; the engine
then does everything else through the same ingest path.

```ts
async subscribe(handlers, ctx) {
  const socket = new WebSocket(url);
  socket.on('message', (message) =>
    handlers.onFixtures(parse(message), { receivedAt: new Date(), label: 'ws' }),
  );
  return { kind: 'websocket', active: () => socket.isOpen, stop: async () => socket.close() };
}
```

**2. Register it** — one entry in `PROVIDER_FACTORIES` in
`src/providers/index.ts`.

**3. Map its markets** — insert rows into `odds_market_rules`. The engine strips
a trailing `_alternate` and any period suffix (`_h1`, `_q1`…`_q4`) before looking
a key up, so one rule covers every period variant:

```sql
insert into odds_market_rules (source_id, provider_key, canonical_code, line_type, review_status)
select id, 'match_winner', 'MATCH_WINNER', 'none', 'mapped' from odds_sources where key = 'my-provider'
on conflict (source_id, provider_key) do nothing;
```

`provider_key` may end with `*` to act as a prefix rule. `canonical_code` is a
foreign key to `market_types`, so it must name a real market family — a `%`
template is rejected by the database, which is why provider families too numerous
to enumerate (player props) are listed explicitly or left to auto-mapping.

Any market you do **not** map is recorded in that same table with
`review_status = 'auto'` (or `'pending'`), under a derived `EXT_<KEY>` code with
its own `market_types` row created on demand. Nothing is silently dropped; the
review query below lists them, and promoting one is a single `INSERT`:

```sql
-- Promote a guessed market to a proper canonical one, then restart the engine so
-- it re-reads the rules.
insert into odds_market_rules (source_id, provider_key, canonical_code, line_type, review_status)
select id, 'player_blocks', 'PLAYER_BLOCKS', 'total', 'mapped'
from odds_sources where key = 'the-odds-api'
on conflict (source_id, provider_key) do update
  set canonical_code = excluded.canonical_code, review_status = 'mapped';
```

```sql
-- What is still waiting for a decision?
select os.key, r.provider_key, r.review_status, r.canonical_code
from odds_market_rules r join odds_sources os on os.id = r.source_id
where r.review_status in ('auto', 'pending') order by 1, 2;
```

**4. Turn it on** — add its key to `ENABLED_PROVIDERS` and its credentials to
`.env.example` and `.env`.

Its quotes are then stored under its own `source_id`, so they can never
overwrite another provider's.

---

## 9. Running individual workers

```bash
node src/cli/main.ts live        # in-play only
node src/cli/main.ts prematch    # upcoming only
node src/cli/main.ts all         # both, in one process
```

The two workers are independent: separate intervals (`LIVE_POLL_INTERVAL_MS`,
`PREMETCH_POLL_INTERVAL_MS`), separate fixture ceilings
(`LIVE_MAX_FIXTURES`, `PREMETCH_MAX_FIXTURES`), and disjoint time windows, so
they never fetch the same fixture or compete over its price. Each provider gets
its own loop, so one provider's failure cannot delay another's.

`Ctrl-C` (or `SIGTERM`) stops scheduling immediately, lets the in-flight cycle
finish within `SHUTDOWN_GRACE_MS`, and exits — so a deploy never leaves a
half-written batch. A second signal exits at once. Shutdown finishes work in
progress; it never starts new writes.

### CLI reference

| Command | Purpose |
| --- | --- |
| `all`, `live`, `prematch` | run workers until interrupted |
| `once` | one cycle per provider, then exit (non-zero if any cycle failed) |
| `scan` | fetch and map only; forces `dry run`, writes nothing |
| `doctor` | configuration, database, schema, functions, coverage, health, credentials |
| `publish` | publish the pricing source's current quotes, then exit |

Flags: `--provider=<a,b>`, `--mode=live\|prematch\|both`, `--dry-run`,
`--log-level=<level>`, `--json`, `--help`.

---

## 10. Running the tests

```bash
npm test             # everything
npm run test:unit    # no network, no database
npm run typecheck    # tsc --noEmit
```

**Unit tests** (228, always run) cover canonical keys and the SQL-agreement
contract, odds conversion and validation, market mapping including period/line/
subject separation and the unknown-market path, fixture matching, HTTP retry and
timeout and redaction, the rate limiter, configuration validation, the mock
provider, the The Odds API adapter against its documented response shape, push
delivery, and scale.

`tests/unit/engine-flow.test.ts` drives the real `Engine` against in-memory
repositories and pins the guarantees that matter most: **two providers quoting
the same selection stay apart**, two bookmakers likewise, a duplicate response
changes nothing, only moved prices are written, an older timestamp cannot win, a
provider outage writes nothing at all, and a market missing from a payload is not
treated as removed.

`tests/unit/worker-push.test.ts` proves the push capability is real: a pushed
payload takes the shared ingest path, a burst is coalesced into one ingest,
overlapping ingests are serialised, a failed subscription falls back to polling, a
dead stream is noticed, and shutdown finishes in-flight work without starting new
writes.

`tests/unit/scale.test.ts` runs 1000 fixtures / 2000 markets / 5000 quotes in one
cycle and asserts that catalogue and quote writes happen in **one batch per
phase** rather than one per row, that fixture resolution stays within
`MAX_CONCURRENCY`, and that an unusable fixture is counted and skipped instead of
costing the cycle.

**Integration tests** (18, against the live project) exercise the real
SQL: change detection, the staleness guard, per-source and per-bookmaker
isolation, malformed-row tolerance, history rules, publishing, the
single pricing-source constraint, and that the seed migration was applied. Until
the migration exists they skip with an explanatory message; they only ever touch
rows tagged `__oe_test`, which they clean up afterwards.

---

## 11. How the engine talks to Supabase

Exclusively over HTTPS with the **service-role key**, server-side only. Two
routes are used:

**PostgREST** for ordinary reads and batched writes — sports, leagues, teams,
events, markets, selections, sources, rules, health. Writes are batched
(`WRITE_BATCH_SIZE`, default 500) and use `on_conflict` against the canonical
unique indexes, so a repeated upsert is a no-op rather than a duplicate.

**Database functions** for the two hot paths, because they need to be atomic and
set-based:

- `odds_apply_quotes(source, quotes, capture_history, heartbeat)` — one statement
  that inserts or updates current odds, skips unchanged rows, refuses older
  quotes, records history when the market opted in, and returns a summary of what
  it did.
- `odds_publish_prices(source, max_staleness)` — one statement that writes the
  pricing source's quotes into `selections.odds` / `selections.status`, touching
  only rows that actually differ and never a settled market.

The engine never writes a price directly and never deletes a quote or a history
row.

### RLS

The seven new tables have RLS enabled with **no public policies**: only the
service role can read or write them. The website is unaffected — it continues to
read the catalogue and `selections` exactly as before — and provider keys and raw
provider payloads are never exposed.

---

## 12. Operations: health, staleness, failure

| Table | Read it like this |
| --- | --- |
| `odds_source_health` | per (source, worker): last success, consecutive failures, totals, quota left |
| `odds_worker_runs` | one row per cycle with its stats |
| `odds_market_rules` | `review_status in ('auto','pending')` = markets waiting for a mapping |
| `odds_quotes` | `last_seen_at` = last time the provider still quoted it |

```sql
-- Is anything broken?
select source_id, worker, last_success_at, consecutive_failures, last_error, quota_remaining
from odds_source_health order by updated_at desc;

-- Odds nobody is refreshing any more:
select os.key, q.bookmaker_key, count(*)
from odds_quotes q join odds_sources os on os.id = q.source_id
where q.last_seen_at < now() - interval '10 minutes'
group by 1, 2 order by 3 desc;

-- Markets waiting for a human mapping:
select os.key, r.provider_key, r.review_status, r.canonical_code
from odds_market_rules r join odds_sources os on os.id = r.source_id
where r.review_status in ('auto','pending') order by 1, 2;

-- One selection's price at every bookmaker:
select os.key, q.bookmaker_key, q.odds, q.status, q.last_changed_at
from odds_quotes q join odds_sources os on os.id = q.source_id
where q.selection_id = '<uuid>' order by q.odds desc;
```

**What happens when a provider breaks.** The cycle aborts, the error is recorded,
and *nothing else changes*: no quote is deleted, no selection is suspended, no
price is rolled back. Once the provider recovers, the next cycle resumes writing.
A quote that simply disappears from a payload is likewise left alone — the
provider's own documentation says a suspended market stops updating and then
vanishes from the response, so absence is never read as removal.

**Retention.** History is configurable per market type in `odds_history_rules`:
`capture_published_history` (the price line players see) and
`capture_source_history` (each provider's movement, off by default). Historical
rows are never deleted because a current quote disappeared.

### Removing placeholder data

Three kinds of placeholder fixture exist in this project, and one cannot simply
be deleted:

| Kind | How to recognise it | Safe to delete? |
| --- | --- | --- |
| Mock provider | league slug `mock_league` | yes — nothing references it |
| Test debris | league slug `__oe_test` | yes |
| Original demo catalogue | `events.external_id` = `'m1'`…`'m12'`, from `20260101000200_seed_demo_catalogue.sql` | **only the ones no bet references** |

`bet_legs.event_id` deliberately has no `ON DELETE CASCADE`: a pending or settled
bet must keep pointing at the fixture it was placed on. A fixture that a bet
references is therefore **retired** — `events.status = 'finished'` and its markets
`'closed'` — which removes it from the site without destroying the audit trail.

```bash
npm run purge -- --scope=mock --dry-run   # what the mock purge would do
npm run purge -- --scope=demo --dry-run   # what the demo purge would do
npm run purge -- --scope=all              # apply both
```

The script reports every fixture it will delete and every one it will retire,
then applies it. Deleting a fixture cascades to its markets, selections, quotes,
history and provider links, so one delete per fixture is enough; booking-code legs
cascade too.

> **The site's own fallback.** `src/modules/sportsbook/catalogue.functions.ts`
> returns hardcoded demo fixtures from `src/lib/betting-data.ts` whenever the
> database has no fixture with an active price. So if the catalogue ends up empty,
> the site shows demo matches that come from **code**, not the database — no purge
> will remove those. Publishing at least one real fixture is what stops the
> fallback from appearing.

---

## 13. Deploying independently

The engine is a plain Node process with no build step, so it deploys anywhere
Node runs: a small VM, a container, or a scheduler that runs `once` on a timer.

```bash
cd oddsengine
npm ci --omit=dev
node src/cli/main.ts doctor     # fail the deploy if this fails
node src/cli/main.ts all
```

Operational checklist:

1. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as real environment
   variables and set `ODDS_ENV_FALLBACK_FILES=` (empty) so nothing is read from a
   file.
2. Provide provider keys the same way.
3. Run `doctor` as a post-deploy health check and as a cron-based watchdog.
4. Run exactly **one** instance per provider — the engine is not leader-elected,
   and two instances would duplicate provider requests (the writes themselves are
   idempotent, but the quota spend is not).
5. Ship stdout to your log collector with `LOG_FORMAT=json`.
6. Keep `LIVE_POLL_INTERVAL_MS` inside 2000–5000 ms unless the provider documents
   a slower refresh; raise `QUOTE_HEARTBEAT_SECONDS` if write volume is a concern.

There is deliberately no Redis, no queue and no microservice split. The work is
idempotent, bounded by the provider's own rate limits, and cheap to repeat, so a
loop plus a signal is the honest amount of machinery.

---

## 14. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `the database is not migrated yet — missing table(s): …` | Run the two migrations in the SQL editor. |
| `odds_market_rules is empty` from `doctor`, or an error log saying every market will be auto-mapped | Only the schema migration ran. Apply `20260101000800_odds_market_rules.sql`, or `npm run seed`. |
| `PRICING_PROVIDER "x" is not in ENABLED_PROVIDERS` | The pricing source must also be enabled, or nothing would be published. |
| `LIVE_POLL_INTERVAL_MS must be at least 2000` | Polling faster does not make odds fresher; it only spends quota. |
| `THE_ODDS_API_KEY is not set` | Set it, or remove `the-odds-api` from `ENABLED_PROVIDERS`. |
| Everything skipped: "quota below THE_ODDS_API_MIN_QUOTA" | Working as intended — the engine stops rather than exhausting the plan. |
| A market shows up as `EXT_…` | It had no rule. Promote it in `odds_market_rules` and restart; see [adding another provider](#8-adding-another-provider). |
| Prices in the database but not on the site | Check the source is the pricing source (`select key, is_pricing_source from odds_sources`), and that its markets are `open` with `active` selections. |
| Integration tests skipped | Expected until the migration exists; the message names the missing tables. |
