/**
 * The Odds API — adapter
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns The Odds API v4 payloads into the engine's provider-neutral shapes. This
 * is the only file in the engine that knows anything about this provider.
 *
 * Notes that come from the provider's own documentation rather than guesswork:
 *
 *   • One feed carries many bookmakers. Each `bookmakers[].key` is preserved as
 *     the `bookmakerKey` on the normalised book, which is what keeps two
 *     bookmakers' quotes on the same selection from ever overwriting each other.
 *   • `commence_time <= now` means the event is in play — there is no separate
 *     "live" flag.
 *   • The market-level `last_update` is used as `provider_updated_at` (the docs
 *     deprecate the bookmaker-level field and specifically recommend this one).
 *   • The sport taxonomy comes from `/v4/sports`: `group` is the sport
 *     ("Football") and `title` is the competition ("EPL"). No mapping table of
 *     invented names.
 *   • Outrights have null home/away teams and are excluded unless the engine is
 *     configured to include them.
 *   • Empty responses and `/v4/sports` cost no quota; only `/odds` does.
 */

import type {
  AdapterContext,
  FetchWindow,
  NormalizedBook,
  NormalizedFixture,
  NormalizedMarket,
  NormalizedOutcome,
  ProviderAdapter,
  ProviderUsage,
} from '../types.ts';
import type { TheOddsApiConfig } from '../../config.ts';
import { estimateOddsCost, TheOddsApiClient } from './api.ts';
import type { TheOddsApiBookmaker, TheOddsApiEvent } from './types.ts';

export type TheOddsApiProviderOptions = {
  config: TheOddsApiConfig;
  /** Return outright/futures events too (they have no home and away team). */
  includeOutrights?: boolean;
  /** Sport keys to ingest. Empty = every active sport that has odds configured. */
  sportKeys?: string[];
};

/** Normalise a provider timestamp to ISO-8601, or null. */
function toIso(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeMarket(bookmaker: TheOddsApiBookmaker, marketIndex: number): NormalizedMarket | null {
  const market = bookmaker.markets[marketIndex];
  if (!market || typeof market.key !== 'string') return null;

  const outcomes: NormalizedOutcome[] = [];

  for (const [outcomeIndex, outcome] of (market.outcomes ?? []).entries()) {
    if (!outcome || typeof outcome.name !== 'string') continue;

    const price = typeof outcome.price === 'number' ? outcome.price : Number(outcome.price);
    if (!Number.isFinite(price)) continue;

    outcomes.push({
      // The provider only exposes a stable selection id when includeSids=true,
      // so fall back to a deterministic composite.
      sourceKey: outcome.sid ?? `${market.key}:${outcome.name}:${outcome.point ?? ''}:${outcomeIndex}`,
      name: outcome.name,
      description: outcome.description ?? null,
      price,
      point: typeof outcome.point === 'number' && Number.isFinite(outcome.point) ? outcome.point : null,
      // The provider has no per-outcome status; suspension is expressed by the
      // market going quiet and eventually disappearing, which the engine
      // detects through staleness rather than through a flag.
      status: 'open',
    });
  }

  if (outcomes.length === 0) return null;

  return {
    sourceKey: market.key,
    name: null,
    status: 'open',
    updatedAt: toIso(market.last_update) ?? toIso(bookmaker.last_update) ?? null,
    outcomes,
  };
}

function normalizeBook(bookmaker: TheOddsApiBookmaker): NormalizedBook | null {
  if (!bookmaker || typeof bookmaker.key !== 'string' || !Array.isArray(bookmaker.markets)) return null;

  const markets = bookmaker.markets
    .map((_, index) => normalizeMarket(bookmaker, index))
    .filter((market): market is NormalizedMarket => market !== null);

  if (markets.length === 0) return null;

  return {
    bookmakerKey: bookmaker.key,
    bookmakerTitle: bookmaker.title || bookmaker.key,
    markets,
  };
}

export function createTheOddsApiProvider(options: TheOddsApiProviderOptions): ProviderAdapter {
  const config = options.config;
  const includeOutrights = options.includeOutrights ?? false;

  let client: TheOddsApiClient | null = null;
  let sportsByKey = new Map<string, { group: string; title: string; hasOutrights: boolean }>();
  let usage: ProviderUsage = { quotaRemaining: null, quotaUsed: null, lastCost: null };

  const resolveSport = (sportKey: string, sportTitle: string): { sportName: string; competitionTitle: string } => {
    const meta = sportsByKey.get(sportKey);
    if (meta) {
      return { sportName: meta.group, competitionTitle: meta.title || sportTitle };
    }

    // Fallback when /v4/sports has not resolved this key: derive from the key's
    // prefix, which is the provider's own naming convention (`soccer_epl`).
    const prefix = sportKey.split('_')[0] ?? sportKey;
    return { sportName: prefix, competitionTitle: sportTitle };
  };

  const adapter: ProviderAdapter = {
    key: 'the-odds-api',
    name: 'The Odds API',
    supportsLive: true,
    supportsPrematch: true,
    knownBookmakers: config.bookmakers,

    async init(ctx: AdapterContext) {
      if (!config.apiKey) {
        throw new Error(
          'THE_ODDS_API_KEY is empty. Put it in oddsengine/.env as ' +
            'THE_ODDS_API_KEY=<your key> (the engine reads that file automatically), or export it in the ' +
            'environment. Note that the Supabase fallback file is only used for SUPABASE_* values, so a key ' +
            'placed in the website\'s .env will not be seen. Alternatively remove the-odds-api from ' +
            'ENABLED_PROVIDERS.',
        );
      }

      client = new TheOddsApiClient(ctx.http, config, ctx.log);

      // Free call: gives us the authoritative sport group/title taxonomy and
      // also proves the key works before a quota-consuming request is made.
      const sports = await client.listSports();
      sportsByKey = new Map(
        sports.map((sport) => [sport.key, { group: sport.group, title: sport.title, hasOutrights: sport.has_outrights }]),
      );

      usage = {
        quotaRemaining: client.getRemaining(),
        quotaUsed: client.getUsage().used,
        lastCost: client.getUsage().lastCost,
      };

      ctx.log.info('the-odds-api ready', {
        sports: sportsByKey.size,
        regions: config.regions,
        markets: config.markets,
        bookmakers: config.bookmakers.length ? config.bookmakers : '(from regions)',
        quotaRemaining: usage.quotaRemaining,
      });

      if (usage.quotaRemaining !== null && usage.quotaRemaining !== undefined && usage.quotaRemaining < config.minQuota) {
        ctx.log.warn('quota is below THE_ODDS_API_MIN_QUOTA', {
          quotaRemaining: usage.quotaRemaining,
          minQuota: config.minQuota,
        });
      }
    },

    async fetchFixtures(window: FetchWindow, ctx: AdapterContext): Promise<NormalizedFixture[]> {
      if (!client) throw new Error('the-odds-api adapter used before init()');

      const remaining = client.getRemaining();
      if (remaining !== null && remaining < config.minQuota) {
        // Back-pressure rather than a hard failure: keep whatever quotes already
        // exist and try again on the next tick.
        ctx.log.warn('skipping cycle: quota below THE_ODDS_API_MIN_QUOTA', {
          quotaRemaining: remaining,
          minQuota: config.minQuota,
        });
        return [];
      }

      const sportKeys = options.sportKeys?.length
        ? options.sportKeys
        : [...sportsByKey.entries()]
            .filter(([, meta]) => (includeOutrights ? true : !meta.hasOutrights))
            .map(([key]) => key);

      if (sportKeys.length === 0) {
        ctx.log.warn('no sports selected — set THE_ODDS_API_SPORTS');
        return [];
      }

      const fixtures: NormalizedFixture[] = [];
      const nowMs = ctx.now().getTime();
      const budget = config.maxCreditsPerCycle;
      const costPerSport = estimateOddsCost({
        sportKey: 'any',
        regions: config.regions,
        bookmakers: config.bookmakers.length ? config.bookmakers : undefined,
        markets: config.markets,
        oddsFormat: 'decimal',
      });

      let spent = 0;
      let sportsQueried = 0;
      let stoppedByBudget = false;

      for (const sportKey of sportKeys) {
        if (budget > 0 && spent >= budget) {
          stoppedByBudget = true;
          break;
        }

        const events = await client.odds({
          sportKey,
          regions: config.regions,
          bookmakers: config.bookmakers.length ? config.bookmakers : undefined,
          markets: config.markets,
          oddsFormat: 'decimal',
          // Only used to narrow the payload; the window filter below is the
          // authoritative one because live events started in the past.
          commenceTimeFrom: window.mode === 'prematch' ? window.from.toISOString() : undefined,
          commenceTimeTo: window.mode === 'prematch' ? window.to.toISOString() : undefined,
        });

        sportsQueried += 1;
        // The provider does not charge for a call that returned no events, so
        // bill it exactly the same way instead of reserving credits up front.
        if (events.length > 0) spent += costPerSport;

        for (const event of events) {
          const normalized = normalizeEvent(event, window, nowMs, ctx);
          if (!normalized) continue;
          if (fixtures.length >= window.limit) break;
          fixtures.push(normalized);
        }

        if (fixtures.length >= window.limit) break;
      }

      if (stoppedByBudget) {
        ctx.log.warn('per-cycle credit budget reached - remaining sports were skipped', {
          budget,
          creditsSpent: spent,
          sportsQueried,
          sportsConfigured: sportKeys.length,
        });
      }

      const latest = client.getUsage();
      usage = { quotaRemaining: latest.remaining, quotaUsed: latest.used, lastCost: latest.lastCost };

      if (sportKeys.length > 1) {
        ctx.log.info('sports cycle summary', {
          sportsConfigured: sportKeys.length,
          sportsQueried,
          creditsSpent: spent,
          budget: budget > 0 ? budget : '(unlimited)',
          quotaRemaining: usage.quotaRemaining ?? null,
        });
      }

      return fixtures;
    },

    getUsage: () => usage,

    /**
     * List the sport keys this account can ingest, optionally probing how many
     * fixtures each one currently holds.
     *
     * The probe uses `/v4/sports/{sport}/events`, which the provider documents as
     * free, so an operator can decide what to enable before spending a credit.
     */
    async listSports(_ctx: AdapterContext, options?: { probeWindow?: { from: Date; to: Date } }) {
      if (!client) throw new Error('the-odds-api adapter used before init()');
      // Bind once: TypeScript cannot see that `client` is non-null inside the
      // async map below.
      const api = client;

      const sports = await api.listSports();
      const markets = config.markets.length || 1;
      // Each group of 10 bookmakers counts as one region, per the docs.
      const regions = config.bookmakers.length ? Math.ceil(config.bookmakers.length / 10) : config.regions.length || 1;
      const estimatedCredits = markets * regions;

      const descriptors = await Promise.all(
        sports
          .filter((sport) => includeOutrights || !sport.has_outrights)
          .map(async (sport) => {
            const base = {
              key: sport.key,
              title: sport.title,
              group: sport.group,
              hasOutrights: sport.has_outrights,
              estimatedCredits,
            };

            if (!options?.probeWindow) return base;

            try {
              const events = await api.events({
                sportKey: sport.key,
                from: options.probeWindow.from.toISOString(),
                to: options.probeWindow.to.toISOString(),
              });
              return { ...base, eventCount: events.length };
            } catch {
              // A probe failure must not stop the listing; -1 means "unknown".
              return { ...base, eventCount: -1 };
            }
          }),
      );

      usage = {
        quotaRemaining: api.getRemaining(),
        quotaUsed: api.getUsage().used,
        lastCost: api.getUsage().lastCost,
      };

      return descriptors;
    },

    async shutdown() {
      client = null;
    },
  };

  const normalizeEvent = (
    event: TheOddsApiEvent,
    window: FetchWindow,
    nowMs: number,
    ctx: AdapterContext,
  ): NormalizedFixture | null => {
    if (!event || typeof event.id !== 'string' || typeof event.commence_time !== 'string') return null;

    const commenceIso = toIso(event.commence_time);
    if (!commenceIso) return null;

    const commenceMs = Date.parse(commenceIso);
    const isLive = commenceMs <= nowMs;

    // A window check in both directions: the provider returns far more than one
    // cycle should handle, and prematch must not include in-play fixtures.
    if (commenceMs < window.from.getTime() || commenceMs > window.to.getTime()) return null;
    if (window.mode === 'live' && !isLive) return null;
    if (window.mode === 'prematch' && isLive) return null;

    const hasTeams = Boolean(event.home_team && event.away_team);
    if (!hasTeams && !includeOutrights) return null;

    const books = (event.bookmakers ?? [])
      .map((bookmaker) => normalizeBook(bookmaker))
      .filter((book): book is NormalizedBook => book !== null);

    // No bookmaker prices this event any more. Nothing to store, and crucially
    // nothing to delete: the quotes already in the database keep their prices.
    if (books.length === 0) return null;

    const sport = resolveSport(event.sport_key, event.sport_title);

    ctx.log.trace('fixture normalised', {
      sourceEventKey: event.id,
      sport: sport.sportName,
      competition: sport.competitionTitle,
      books: books.length,
      markets: books.reduce((sum, book) => sum + book.markets.length, 0),
      isLive,
    });

    return {
      sourceEventKey: event.id,
      sportName: sport.sportName,
      sportKey: event.sport_key,
      competitionTitle: sport.competitionTitle,
      countryCode: null,
      homeTeam: event.home_team ?? null,
      awayTeam: event.away_team ?? null,
      name: hasTeams ? `${event.home_team} vs ${event.away_team}` : event.sport_title,
      commenceTime: commenceIso,
      isLive,
      // The odds endpoints do not carry scores; the scores endpoint does and is
      // out of scope for the odds engine.
      homeScore: null,
      awayScore: null,
      minute: null,
      books,
    };
  };

  return adapter;
}
