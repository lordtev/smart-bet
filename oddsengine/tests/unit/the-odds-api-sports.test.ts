/**
 * Multi-sport fetching: the credit budget, and sport discovery.
 *
 * An empty sport list means "every in-season sport" — around 70 feeds at 3
 * credits each. That is fine for one prematch cycle and ruinous for a 3-second
 * live poll, so the adapter has a per-cycle credit ceiling. These tests pin it,
 * and pin the `sports --probe` discovery that lets an operator choose instead of
 * guessing.
 */
import { describe, expect, it } from 'vitest';
import { createTheOddsApiProvider } from '../../src/providers/the-odds-api/adapter.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import type { AdapterContext, HttpClient, HttpRequest } from '../../src/providers/types.ts';
import type { TheOddsApiConfig } from '../../src/config.ts';

const NOW = new Date('2026-09-26T18:00:00.000Z');

const SPORTS = [
  { key: 'soccer_epl', group: 'Soccer', title: 'EPL', description: '', active: true, has_outrights: false },
  { key: 'basketball_nba', group: 'Basketball', title: 'NBA', description: '', active: true, has_outrights: false },
  { key: 'tennis_atp', group: 'Tennis', title: 'ATP', description: '', active: true, has_outrights: false },
  { key: 'soccer_epl_winner', group: 'Soccer', title: 'EPL Winner', description: '', active: true, has_outrights: true },
];

/** One event with one h2h market, enough to be a real fixture. */
function eventFor(sportKey: string, index: number) {
  return {
    id: `${sportKey}-${index}`,
    sport_key: sportKey,
    sport_title: sportKey,
    commence_time: new Date(NOW.getTime() + 3_600_000).toISOString(),
    home_team: 'Home FC',
    away_team: 'Away FC',
    bookmakers: [
      {
        key: 'book-a',
        title: 'Book A',
        last_update: NOW.toISOString(),
        markets: [
          {
            key: 'h2h',
            last_update: NOW.toISOString(),
            outcomes: [
              { name: 'Home FC', price: 2.1 },
              { name: 'Away FC', price: 3.2 },
              { name: 'Draw', price: 3.4 },
            ],
          },
        ],
      },
    ],
  };
}

/** How many events each sport returns; a sport not listed here returns none. */
const EVENT_COUNTS: Record<string, number> = {
  soccer_epl: 10,
  basketball_nba: 4,
  tennis_atp: 2,
};

function routingHttp() {
  const requested: string[] = [];

  const http: HttpClient = {
    request: async <T,>(req: HttpRequest) => {
      const url = new URL(req.url);
      const path = url.pathname;
      requested.push(path);

      const respond = (body: unknown, headers: Record<string, string> = {}) => ({
        status: 200,
        data: body as T,
        headers,
        durationMs: 1,
      });

      if (path === '/v4/sports') return respond(SPORTS, { 'x-requests-remaining': '400' });

      const oddsMatch = path.match(/^\/v4\/sports\/([^/]+)\/odds$/);
      if (oddsMatch) {
        const key = oddsMatch[1] as string;
        const count = EVENT_COUNTS[key] ?? 0;
        const events = Array.from({ length: count }, (_, index) => eventFor(key, index));
        return respond(events, { 'x-requests-last': count > 0 ? '3' : '0' });
      }

      const eventsMatch = path.match(/^\/v4\/sports\/([^/]+)\/events$/);
      if (eventsMatch) {
        const key = eventsMatch[1] as string;
        const count = EVENT_COUNTS[key] ?? 0;
        return respond(
          Array.from({ length: count }, (_, index) => ({ id: `${key}-${index}`, commence_time: NOW.toISOString() })),
        );
      }

      throw new Error(`unexpected request: ${path}`);
    },
  };

  return { http, requested };
}

function config(overrides: Partial<TheOddsApiConfig> = {}): TheOddsApiConfig {
  return {
    apiKey: 'test-key-value',
    baseUrl: 'https://api.the-odds-api.com',
    ipv6BaseUrl: 'https://ipv6-api.the-odds-api.com',
    useIpv6: false,
    useHeaderAuth: true,
    regions: ['uk'],
    markets: ['h2h', 'spreads', 'totals'],
    // Empty: every in-season sport.
    sports: [],
    bookmakers: [],
    minQuota: 0,
    maxCreditsPerCycle: 0,
    ...overrides,
  };
}

function context(http: HttpClient): AdapterContext {
  return { log: silentLogger(), signal: new AbortController().signal, http, now: () => NOW };
}

const window = {
  mode: 'prematch' as const,
  from: NOW,
  to: new Date(NOW.getTime() + 7 * 86_400_000),
  limit: 500,
};

describe('all-sports fetching', () => {
  it('queries every non-outrights sport when the sport list is empty', async () => {
    const { http, requested } = routingHttp();
    const provider = createTheOddsApiProvider({ config: config() });
    await provider.init(context(http));

    const fixtures = await provider.fetchFixtures(window, context(http));

    const oddsCalls = requested.filter((path) => path.endsWith('/odds'));
    expect(oddsCalls).toEqual(['/v4/sports/soccer_epl/odds', '/v4/sports/basketball_nba/odds', '/v4/sports/tennis_atp/odds']);
    expect(fixtures).toHaveLength(10 + 4 + 2);
  });

  it('stops once the per-cycle credit budget is spent', async () => {
    // One sport costs markets(3) × regions(1) = 3 credits, so a budget of 3
    // allows exactly one sport that returned events.
    const { http, requested } = routingHttp();
    const provider = createTheOddsApiProvider({ config: config({ maxCreditsPerCycle: 3 }) });
    await provider.init(context(http));

    const fixtures = await provider.fetchFixtures(window, context(http));

    const oddsCalls = requested.filter((path) => path.endsWith('/odds'));
    expect(oddsCalls).toHaveLength(1);
    expect(fixtures).toHaveLength(10);
  });

  it('does not charge the budget for a sport that returned no events', async () => {
    // Only the mock-vs-real distinction matters here: a sport with no events is
    // free, so the budget should survive it and carry on.
    const { http, requested } = routingHttp();
    const provider = createTheOddsApiProvider({
      config: config({ maxCreditsPerCycle: 6, sports: ['tennis_atp', 'soccer_epl'] }),
    });
    await provider.init(context(http));

    await provider.fetchFixtures(window, context(http));

    // tennis returns 2 events (3 credits), epl returns 10 (3 credits) — both fit.
    expect(requested.filter((path) => path.endsWith('/odds'))).toHaveLength(2);
  });

  it('records the quota the provider reported', async () => {
    const { http } = routingHttp();
    const provider = createTheOddsApiProvider({ config: config() });
    await provider.init(context(http));
    await provider.fetchFixtures(window, context(http));

    expect(provider.getUsage().quotaRemaining).toBe(400);
  });
});

describe('listSports', () => {
  it('reports one descriptor per ingestable sport, with a cost estimate', async () => {
    const { http } = routingHttp();
    const provider = createTheOddsApiProvider({ config: config() });
    await provider.init(context(http));

    const sports = await provider.listSports!(context(http));

    // Outrights are excluded by default.
    expect(sports.map((sport) => sport.key)).toEqual(['soccer_epl', 'basketball_nba', 'tennis_atp']);
    expect(sports[0]).toMatchObject({ group: 'Soccer', title: 'EPL', hasOutrights: false, estimatedCredits: 3 });
    expect(sports[0]?.eventCount).toBeUndefined();
  });

  it('includes outrights when configured to', async () => {
    const { http } = routingHttp();
    const provider = createTheOddsApiProvider({ config: config(), includeOutrights: true });
    await provider.init(context(http));

    const sports = await provider.listSports!(context(http));
    expect(sports.map((sport) => sport.key)).toContain('soccer_epl_winner');
  });

  it('counts fixtures when given a probe window, using the free events endpoint', async () => {
    const { http, requested } = routingHttp();
    const provider = createTheOddsApiProvider({ config: config() });
    await provider.init(context(http));

    const sports = await provider.listSports!(context(http), { probeWindow: window });

    expect(sports.map((sport) => [sport.key, sport.eventCount])).toEqual([
      ['soccer_epl', 10],
      ['basketball_nba', 4],
      ['tennis_atp', 2],
    ]);
    // The probe must never touch the quota-consuming odds endpoint.
    expect(requested.some((path) => path.endsWith('/odds'))).toBe(false);
    expect(requested.filter((path) => path.endsWith('/events')).length).toBeGreaterThan(0);
  });

  it('puts no milliseconds on the probed window, which the API rejects', async () => {
    const { http, requested } = routingHttp();
    let seenQuery = '';
    const wrapped: HttpClient = {
      request: async <T,>(req: HttpRequest) => {
        if (req.url.includes('/events')) seenQuery = String(req.query?.commenceTimeFrom ?? '');
        return http.request<T>(req);
      },
    };

    const provider = createTheOddsApiProvider({ config: config() });
    await provider.init(context(wrapped));
    await provider.listSports!(context(wrapped), {
      probeWindow: { from: new Date('2026-09-26T18:00:00.123Z'), to: new Date('2026-10-03T18:00:00.987Z') },
    });

    expect(seenQuery).toBe('2026-09-26T18:00:00Z');
    expect(requested.length).toBeGreaterThan(0);
  });

  it('survives a failing probe for one sport without losing the list', async () => {
    const http: HttpClient = {
      request: async <T,>(req: HttpRequest) => {
        if (req.url.endsWith('/v4/sports')) {
          return { status: 200, data: SPORTS as unknown as T, headers: {}, durationMs: 1 };
        }
        if (req.url.includes('basketball_nba')) throw new Error('probe blew up');
        return { status: 200, data: [] as unknown as T, headers: {}, durationMs: 1 };
      },
    };

    const provider = createTheOddsApiProvider({ config: config() });
    await provider.init(context(http));
    const sports = await provider.listSports!(context(http), { probeWindow: window });

    expect(sports).toHaveLength(3);
    expect(sports.find((sport) => sport.key === 'basketball_nba')?.eventCount).toBe(-1);
    expect(sports.find((sport) => sport.key === 'soccer_epl')?.eventCount).toBe(0);
  });

  it('refuses to run before init', async () => {
    const provider = createTheOddsApiProvider({ config: config() });
    await expect(provider.listSports!(context(routingHttp().http))).rejects.toThrow(/before init/);
  });
});

describe('providers without sport discovery', () => {
  it('the mock provider exposes no listSports, and the CLI reports that', async () => {
    const { createMockProvider } = await import('../../src/providers/mock.ts');
    const provider = createMockProvider({ now: () => NOW });
    expect(provider.listSports).toBeUndefined();
  });
});
