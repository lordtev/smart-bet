/**
 * The provider contract
 * ─────────────────────────────────────────────────────────────────────────────
 * This file is the boundary between "provider-specific" and "everything else".
 * Anything below this line (matching, mapping, change detection, writes,
 * history, publishing) is written once and works for every provider.
 *
 * A provider module's only job is to turn its own API into `NormalizedFixture`
 * values. It never touches the database, never knows what a canonical market
 * code is, and never writes a price.
 *
 * Adding a provider therefore means:
 *   1. create `src/providers/<key>/adapter.ts` exporting a `ProviderAdapter`;
 *   2. register it in `src/providers/index.ts`;
 *   3. add its API key to `.env`;
 *   4. add it to ENABLED_PROVIDERS.
 * No core file changes, and no existing provider is affected — each provider's
 * rows in `odds_quotes` are keyed by its own `source_id`.
 */

import type { Logger } from '../logging/logger.ts';

/* ── Normalised shapes ───────────────────────────────────────────────────── */

/**
 * A provider's own view of whether a market can be bet into right now.
 * Mapped onto the engine's canonical terms by the adapter, never by the core.
 */
export type NormalizedMarketStatus = 'open' | 'suspended' | 'closed';

export type NormalizedOutcome = {
  /** The provider's identifier for this selection. Used for traceability only. */
  sourceKey: string;
  /** Label exactly as the provider gave it ("Home", "Over", "LeBron James"). */
  name: string;
  /**
   * Extra disambiguation the provider supplies. For player props this is the
   * player's name, and it becomes part of the canonical market identity — that
   * is why two players' props never collapse into one market.
   */
  description?: string | null;
  /** Decimal odds. The adapter converts American/fractional itself. */
  price: number;
  /** Handicap or total line, when the market has one. */
  point?: number | null;
  /** Optional per-outcome availability, when the provider suspends individuals. */
  status?: NormalizedMarketStatus;
};

export type NormalizedMarket = {
  /** The provider's market key, e.g. `totals`, `h2h_q1`, `player_points`. */
  sourceKey: string;
  /** The provider's human label for the market, used for display fallbacks. */
  name?: string | null;
  status: NormalizedMarketStatus;
  /**
   * The provider's own "last time I saw odds for this market" timestamp. This
   * becomes `odds_quotes.provider_updated_at` and is what stops an out-of-order
   * response from overwriting newer odds.
   */
  updatedAt: string | null;
  outcomes: NormalizedOutcome[];
};

export type NormalizedBook = {
  /**
   * Identity of the bookmaker inside the provider, e.g. `draftkings`.
   * Defaults to 'default' for single-book providers.
   */
  bookmakerKey: string;
  /** Display name of the bookmaker. */
  bookmakerTitle: string;
  markets: NormalizedMarket[];
};

export type NormalizedFixture = {
  /** The provider's fixture id. Keyed into `odds_source_links`. */
  sourceEventKey: string;
  /**
   * Canonical sport name, e.g. "Football". The adapter maps its own sport keys
   * onto this (`soccer_epl` → Football), because only the adapter knows its
   * provider's taxonomy.
   */
  sportName: string;
  /** Provider sport key, e.g. `soccer_epl`. Kept for traceability. */
  sportKey: string;
  /** Provider's presentation name for the competition, e.g. "EPL". */
  competitionTitle: string | null;
  /** Country code for the competition, when the provider supplies one. */
  countryCode: string | null;
  /** Home participant. Null for outright/futures events. */
  homeTeam: string | null;
  /** Away participant. Null for outright/futures events. */
  awayTeam: string | null;
  /** Display name for the fixture. The core also regenerates it from the teams. */
  name: string;
  /** ISO-8601 kickoff. */
  commenceTime: string;
  /** True when the provider reports the fixture as in play. */
  isLive: boolean;
  homeScore: number | null;
  awayScore: number | null;
  /** Elapsed minute, when the provider reports one. */
  minute: number | null;
  books: NormalizedBook[];
};

/* ── Fetch windows ───────────────────────────────────────────────────────── */

export type FetchMode = 'live' | 'prematch';

export type FetchWindow = {
  mode: FetchMode;
  /** Inclusive lower bound on kickoff. For `live` this is in the past. */
  from: Date;
  /** Inclusive upper bound on kickoff. */
  to: Date;
  /** Upper bound on fixtures returned, so one cycle cannot run away. */
  limit: number;
};

/* ── Runtime handed to an adapter ────────────────────────────────────────── */

export type AdapterContext = {
  log: Logger;
  /** Aborted on shutdown, so adapters can stop mid-flight. */
  signal: AbortSignal;
  /** Shared HTTP client: retries, timeouts, rate limiting, redaction. */
  http: HttpClient;
  /** Wall clock, injected so tests can control time. */
  now: () => Date;
};

export type HttpRequest = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Label used in logs and in rate-limit accounting (e.g. 'odds'). */
  label: string;
  /** How many provider quota credits this call is expected to cost, if known. */
  expectedCost?: number;
};

export type HttpResponse<T = unknown> = {
  status: number;
  data: T;
  headers: Record<string, string>;
  /** Duration in ms, for health reporting. */
  durationMs: number;
};

export type HttpClient = {
  request: <T = unknown>(req: HttpRequest) => Promise<HttpResponse<T>>;
};

/* ── Usage / quota reporting ─────────────────────────────────────────────── */

export type ProviderUsage = {
  /** Credits remaining in the provider's quota window, when reported. */
  quotaRemaining?: number | null;
  /** Credits used in the provider's quota window, when reported. */
  quotaUsed?: number | null;
  /** Cost the provider reported for the last call. */
  lastCost?: number | null;
};

/* ── Push delivery (WebSocket / webhook) ─────────────────────────────────── */

/**
 * What a push subscription hands back to the provider. The provider calls
 * `onFixtures` whenever its stream or webhook delivers a payload; the engine
 * then runs exactly the same map → catalogue → ingest → publish path it uses for
 * a polled payload, so a push update cannot behave differently from a polled
 * one.
 */
export type PushHandlers = {
  onFixtures: (fixtures: NormalizedFixture[], meta: { receivedAt: Date; label: string }) => void | Promise<void>;
  /** Non-fatal stream problems, surfaced in the health record. */
  onError: (error: Error, meta: { fatal: boolean }) => void;
};

export type PushSubscription = {
  /** Stop receiving updates and release the socket / webhook. Idempotent. */
  stop: () => Promise<void>;
  /** False once the provider has given up on the stream (e.g. after a fatal error). */
  active: () => boolean;
  /** Human description for logs and health rows: 'websocket', 'webhook', 'poll'. */
  readonly kind: string;
};

/* ── Sports discovery ────────────────────────────────────────────────────── */

/**
 * One competition feed the provider can ingest, as reported by the provider
 * itself. Used by the `sports` CLI command so an operator can choose what to
 * enable instead of guessing at keys.
 */
export type SportDescriptor = {
  /** The key to put in the provider's sport list setting. */
  key: string;
  /** Provider's presentation title, e.g. "EPL". */
  title: string;
  /** Provider's grouping, e.g. "Soccer". */
  group: string;
  /** True for outright/futures feeds, which have no home or away team. */
  hasOutrights: boolean;
  /** Fixtures inside the probed window. Only set when a probe was requested. */
  eventCount?: number;
  /** Credits one cycle costs if this sport is enabled. Only set by the adapter. */
  estimatedCredits?: number;
};

/* ── The adapter interface ───────────────────────────────────────────────── */

export interface ProviderAdapter {
  /** Registry key, also the `odds_sources.key` this provider writes under. */
  readonly key: string;
  /** Display name. */
  readonly name: string;
  /** Whether the provider can serve live (in-play) odds. */
  readonly supportsLive: boolean;
  /** Whether the provider can serve prematch odds. */
  readonly supportsPrematch: boolean;
  /**
   * Bookmakers this provider knows about, best-effort. Used for the
   * `PRICING_BOOKMAKER` sanity check; empty means "provider-defined".
   */
  readonly knownBookmakers: readonly string[];

  /** Validate credentials and warm caches. Throws if the provider is unusable. */
  init: (ctx: AdapterContext) => Promise<void>;

  /** Fetch one window of fixtures with their markets and outcomes. */
  fetchFixtures: (window: FetchWindow, ctx: AdapterContext) => Promise<NormalizedFixture[]>;

  /**
   * OPTIONAL push delivery.
   *
   * A provider that offers WebSockets or webhooks implements this instead of
   * relying on polling alone. When the engine is configured for push
   * (`PROVIDER_PUSH_ENABLED=true`) and this method exists, the worker subscribes
   * and ingests pushed payloads immediately, keeping a slower reconciliation poll
   * as a safety net — because streams drop and webhooks get lost.
   *
   * Implementing it is never required: polled providers simply omit it, and the
   * engine polls them exactly as before.
   */
  subscribe?: (handlers: PushHandlers, ctx: AdapterContext) => Promise<PushSubscription>;

  /**
   * OPTIONAL: list the competition feeds this provider can ingest.
   *
   * Powers the `sports` CLI command. With `probeWindow` the adapter should also
   * report how many fixtures each feed currently holds — using whatever cheap or
   * free endpoint the provider offers, never the quota-consuming odds endpoint.
   */
  listSports?: (
    ctx: AdapterContext,
    options?: { probeWindow?: { from: Date; to: Date } },
  ) => Promise<SportDescriptor[]>;

  /** Last known quota state, for the health table and for back-pressure. */
  getUsage: () => ProviderUsage;

  /** Release sockets / timers. Must be safe to call twice. */
  shutdown: () => Promise<void>;
}

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * Thrown when a provider is misconfigured or unusable (missing key, bad
 * response shape). `retryable` tells the worker whether the cycle is worth
 * retrying immediately or should just wait for the next tick.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(
    provider: string,
    message: string,
    options: { retryable?: boolean; status?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}
