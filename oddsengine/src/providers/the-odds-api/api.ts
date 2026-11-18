/**
 * The Odds API — HTTP client
 * ─────────────────────────────────────────────────────────────────────────────
 * Authentication, request construction and quota accounting for
 * https://api.the-odds-api.com/v4, confined to one file so the adapter above it
 * can stay about data and the engine can stay about odds.
 *
 * Auth (per the docs, both forms are supported):
 *   • `x-api-key: <key>` header — used by default, since it keeps the key out of
 *     URLs, proxy logs and error messages;
 *   • `?apiKey=<key>` query parameter — available when THE_ODDS_API_USE_HEADER_AUTH
 *     is false.
 *
 * Quota: cost = (number of markets) × (number of regions), and every response
 * returns x-requests-remaining / x-requests-used / x-requests-last. Those are
 * read from the headers of the actual response, never assumed.
 *
 * Endpoints used, and why:
 *   GET /v4/sports                       in-season sports (no quota cost)
 *   GET /v4/sports/{sport}/odds          featured odds, live and upcoming
 *   GET /v4/sports/{sport}/events        fixture list without odds (no quota cost)
 */

import type { AdapterContext, HttpClient } from '../types.ts';
import type { TheOddsApiEvent, TheOddsApiSport, TheOddsApiUsage } from './types.ts';
import type { TheOddsApiConfig } from '../../config.ts';

export type OddsQuery = {
  sportKey: string;
  regions?: string[];
  bookmakers?: string[];
  markets?: string[];
  oddsFormat: 'decimal' | 'american';
  commenceTimeFrom?: string;
  commenceTimeTo?: string;
  eventIds?: string[];
};

/** How many quota credits a call is expected to cost: markets × regions. */
export function estimateOddsCost(query: OddsQuery): number {
  const markets = query.markets?.length ?? 1;
  // The docs treat each group of 10 bookmakers as one region.
  const regions = query.bookmakers?.length ? Math.ceil(query.bookmakers.length / 10) : (query.regions?.length ?? 1);
  return markets * regions;
}

/**
 * Normalise a timestamp to the exact format the API's time parameters accept.
 *
 * Documented as "ISO 8601 format, for example 2023-09-09T00:00:00Z", and validated
 * strictly: `Date.toISOString()` emits milliseconds, and
 * `2026-11-16T12:57:48.240Z` is rejected with
 * `INVALID_COMMENCE_TIME_FROM` (422). Seconds only, always.
 */
export function toProviderTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`cannot format "${String(value)}" as a provider timestamp`);
  }
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class TheOddsApiClient {
  private readonly http: HttpClient;
  private readonly config: TheOddsApiConfig;
  private readonly log: AdapterContext['log'];

  private usage: TheOddsApiUsage = { remaining: null, used: null, lastCost: null };
  private sportsCache: TheOddsApiSport[] | null = null;

  constructor(http: HttpClient, config: TheOddsApiConfig, log: AdapterContext['log']) {
    this.http = http;
    this.config = config;
    this.log = log;
  }

  private get baseUrl(): string {
    return this.config.useIpv6 ? this.config.ipv6BaseUrl : this.config.baseUrl;
  }

  private requireKey(): string {
    if (!this.config.apiKey) {
      throw new Error(
        'THE_ODDS_API_KEY is not set — add your key to oddsengine/.env or disable the-odds-api in ENABLED_PROVIDERS',
      );
    }
    return this.config.apiKey;
  }

  /** Auth headers/query for one call. */
  private auth(): { headers: Record<string, string>; query: Record<string, string | undefined> } {
    const key = this.requireKey();
    return this.config.useHeaderAuth
      ? { headers: { 'x-api-key': key }, query: {} }
      : { headers: {}, query: { apiKey: key } };
  }

  /** Read quota headers off the last response. */
  private recordUsage(headers: Record<string, string>): void {
    const remaining = Number(headers['x-requests-remaining']);
    const used = Number(headers['x-requests-used']);
    const last = Number(headers['x-requests-last']);

    if (Number.isFinite(remaining)) this.usage.remaining = remaining;
    if (Number.isFinite(used)) this.usage.used = used;
    if (Number.isFinite(last)) this.usage.lastCost = last;
  }

  getUsage(): TheOddsApiUsage {
    return { ...this.usage };
  }

  /** Quota left, or null when the provider has not told us yet. */
  getRemaining(): number | null {
    return this.usage.remaining;
  }

  /**
   * In-season sports. Costs nothing, and gives us the authoritative `group`
   * ("American Football") and `title` ("NFL") for every sport key — which is why
   * the adapter never has to invent a sport taxonomy.
   */
  async listSports(force = false): Promise<TheOddsApiSport[]> {
    if (this.sportsCache && !force) return this.sportsCache;

    const { headers, query } = this.auth();
    const response = await this.http.request<TheOddsApiSport[]>({
      url: `${this.baseUrl}/v4/sports`,
      method: 'GET',
      headers,
      query,
      label: 'sports',
      expectedCost: 0,
    });

    this.recordUsage(response.headers);

    if (!Array.isArray(response.data)) {
      throw new Error('The Odds API /v4/sports returned an unexpected payload');
    }

    this.sportsCache = response.data;
    return this.sportsCache;
  }

  /**
   * Fixture list for one sport, WITHOUT odds.
   *
   * The v4 guide states this endpoint does not count against the usage quota, so
   * it is what `sports --probe` uses to find out which competitions actually hold
   * fixtures before any credit is spent.
   */
  async events(query: {
    sportKey: string;
    from: string;
    to: string;
  }): Promise<{ id: string; commence_time: string }[]> {
    const { headers, query: authQuery } = this.auth();

    const response = await this.http.request<{ id: string; commence_time: string }[]>({
      url: `${this.baseUrl}/v4/sports/${encodeURIComponent(query.sportKey)}/events`,
      method: 'GET',
      headers,
      query: {
        ...authQuery,
        dateFormat: 'iso',
        commenceTimeFrom: toProviderTime(query.from),
        commenceTimeTo: toProviderTime(query.to),
      },
      label: `events:${query.sportKey}`,
      expectedCost: 0,
    });

    this.recordUsage(response.headers);
    return Array.isArray(response.data) ? response.data : [];
  }

  /** Featured odds for a sport: live and upcoming events (quota consuming). */
  async odds(query: OddsQuery): Promise<TheOddsApiEvent[]> {    const { headers, query: authQuery } = this.auth();

    const response = await this.http.request<TheOddsApiEvent[]>({
      url: `${this.baseUrl}/v4/sports/${encodeURIComponent(query.sportKey)}/odds`,
      method: 'GET',
      headers,
      query: {
        ...authQuery,
        regions: query.regions?.length ? query.regions.join(',') : undefined,
        bookmakers: query.bookmakers?.length ? query.bookmakers.join(',') : undefined,
        markets: query.markets?.length ? query.markets.join(',') : undefined,
        oddsFormat: query.oddsFormat,
        dateFormat: 'iso',
        commenceTimeFrom: query.commenceTimeFrom ? toProviderTime(query.commenceTimeFrom) : undefined,
        commenceTimeTo: query.commenceTimeTo ? toProviderTime(query.commenceTimeTo) : undefined,
        eventIds: query.eventIds?.length ? query.eventIds.join(',') : undefined,
      },
      label: `odds:${query.sportKey}`,
      expectedCost: estimateOddsCost(query),
    });

    this.recordUsage(response.headers);

    if (!Array.isArray(response.data)) {
      throw new Error(`The Odds API /v4/sports/${query.sportKey}/odds returned an unexpected payload`);
    }

    this.log.debug('odds payload received', {
      sport: query.sportKey,
      events: response.data.length,
      markets: response.data.reduce((sum, event) => sum + event.bookmakers.length, 0),
      quotaRemaining: this.usage.remaining,
      lastCost: this.usage.lastCost,
      durationMs: response.durationMs,
    });

    return response.data;
  }
}
