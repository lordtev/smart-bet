/**
 * The Odds API — response shapes
 * ─────────────────────────────────────────────────────────────────────────────
 * Transcribed from the published OpenAPI schema
 * (https://the-odds-api.com/api-reference/v4/schema.yml) and the v4 guide
 * (https://the-odds-api.com/liveapi/guides/v4/). Nothing here is guessed:
 *
 *   Sport        { key, group, title, description, active, has_outrights }
 *   Event        { id, sport_key, sport_title, commence_time, home_team, away_team, bookmakers[] }
 *   Bookmaker    { key, title, last_update, markets[] }
 *   Market       { key, last_update, outcomes[] }
 *   Outcome      { name, price, point?, description?, link?, sid?, bet_limit?, multiplier? }
 *
 * Documented behaviours that shape the adapter:
 *   • An event is in play when `commence_time` is earlier than now; the /odds
 *     endpoint never returns completed events.
 *   • The MARKET-level `last_update` is the recency signal. The guide explicitly
 *     says the bookmaker-level field is deprecated and to prefer the market one.
 *   • When a market is suspended or closed its `last_update` stops advancing and
 *     the market disappears from the response after roughly 15 minutes — which is
 *     exactly why an absent market must never be treated as a removed one.
 *   • `point` is only present on spreads/totals; `description` carries the player
 *     name on player-prop markets.
 *   • `home_team` / `away_team` are null for outrights (futures).
 *   • Quota cost is markets × regions; the response carries x-requests-remaining,
 *     x-requests-used and x-requests-last.
 */

export type TheOddsApiSport = {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
};

export type TheOddsApiOutcome = {
  name: string;
  price: number;
  point?: number | null;
  description?: string | null;
  link?: string | null;
  sid?: string | null;
  bet_limit?: number | null;
};

export type TheOddsApiMarket = {
  key: string;
  last_update?: string | null;
  outcomes: TheOddsApiOutcome[];
};

export type TheOddsApiBookmaker = {
  key: string;
  title: string;
  /** Deprecated per the docs; the market-level timestamp is used instead. */
  last_update?: string | null;
  markets: TheOddsApiMarket[];
};

export type TheOddsApiEvent = {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string | null;
  away_team: string | null;
  bookmakers: TheOddsApiBookmaker[];
};

export type TheOddsApiUsage = {
  remaining: number | null;
  used: number | null;
  lastCost: number | null;
};
