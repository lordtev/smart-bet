/**
 * The Odds API adapter, against the response shape documented in their OpenAPI
 * schema. No network, no credentials: the HTTP client is faked, so this pins the
 * normalisation contract for the one real provider integration.
 *
 * Shapes come from https://the-odds-api.com/api-reference/v4/schema.yml
 *   Sport      { key, group, title, description, active, has_outrights }
 *   Event      { id, sport_key, sport_title, commence_time, home_team, away_team, bookmakers[] }
 *   Bookmaker  { key, title, last_update, markets[] }
 *   Market     { key, last_update, outcomes[] }
 *   Outcome    { name, price, point?, description? }
 */
import { describe, expect, it, vi } from 'vitest';
import { createTheOddsApiProvider } from '../../src/providers/the-odds-api/adapter.ts';
import { THE_ODDS_API_SAMPLE, THE_ODDS_API_SPORTS } from '../fixtures/the-odds-api.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import type { AdapterContext, HttpClient, HttpRequest } from '../../src/providers/types.ts';
import type { TheOddsApiConfig } from '../../src/config.ts';

function config(overrides: Partial<TheOddsApiConfig> = {}): TheOddsApiConfig {
  return {
    apiKey: 'test-api-key-value',
    baseUrl: 'https://api.the-odds-api.com',
    ipv6BaseUrl: 'https://ipv6-api.the-odds-api.com',
    useIpv6: false,
    useHeaderAuth: true,
    regions: ['uk'],
    markets: ['h2h', 'spreads', 'totals'],
    sports: ['soccer_epl'],
    bookmakers: [],
    minQuota: 0,
    maxCreditsPerCycle: 0,
    ...overrides,
  };
}

/** A fake transport that records requests and replays queued responses. */
function fakeHttp(responses: Array<{ body: unknown; headers?: Record<string, string> }>) {
  const requests: HttpRequest[] = [];
  let index = 0;

  const http: HttpClient = {
    request: async <T,>(req: HttpRequest) => {
      requests.push(req);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        status: 200,
        data: (response?.body ?? null) as T,
        headers: response?.headers ?? {},
        durationMs: 5,
      };
    },
  };

  return { http, requests };
}

function context(http: HttpClient): AdapterContext {
  return {
    log: silentLogger(),
    signal: new AbortController().signal,
    http,
    now: () => new Date('2026-09-26T18:00:00.000Z'),
  };
}

const sportsResponse = { body: THE_ODDS_API_SPORTS, headers: { 'x-requests-remaining': '100', 'x-requests-used': '400', 'x-requests-last': '0' } };
const oddsResponse = {
  body: THE_ODDS_API_SAMPLE,
  headers: { 'x-requests-remaining': '421', 'x-requests-used': '79', 'x-requests-last': '3' },
};

async function initialized(overrides: Partial<TheOddsApiConfig> = {}) {
  const { http, requests } = fakeHttp([sportsResponse, oddsResponse]);
  const provider = createTheOddsApiProvider({ config: config(overrides), sportKeys: ['soccer_epl'] });
  await provider.init(context(http));
  return { provider, requests, http };
}

const window = {
  mode: 'prematch' as const,
  from: new Date('2026-09-26T18:00:00.000Z'),
  to: new Date('2026-10-03T18:00:00.000Z'),
  limit: 50,
};

describe('the-odds-api adapter', () => {
  it('sends the key as the x-api-key header by default', async () => {
    const { provider, requests } = await initialized();
    await provider.fetchFixtures(window, context(fakeHttp([oddsResponse]).http));

    const oddsRequest = requests[1];
    expect(oddsRequest?.headers?.['x-api-key']).toBe('test-api-key-value');
    expect(oddsRequest?.query?.['apiKey']).toBeUndefined();
  });

  it('falls back to the apiKey query parameter when configured to', async () => {
    const { http, requests } = fakeHttp([sportsResponse, oddsResponse]);
    const provider = createTheOddsApiProvider({ config: config({ useHeaderAuth: false }), sportKeys: ['soccer_epl'] });
    await provider.init(context(http));
    await provider.fetchFixtures(window, context(http));

    expect(requests[1]?.query?.['apiKey']).toBe('test-api-key-value');
    expect(requests[1]?.headers?.['x-api-key']).toBeUndefined();
  });

  it('uses the documented endpoints and query parameters', async () => {
    const { provider, requests, http } = await initialized();
    await provider.fetchFixtures(window, context(http));

    expect(requests[0]?.url).toBe('https://api.the-odds-api.com/v4/sports');
    expect(requests[1]?.url).toBe('https://api.the-odds-api.com/v4/sports/soccer_epl/odds');
    expect(requests[1]?.query).toMatchObject({
      regions: 'uk',
      markets: 'h2h,spreads,totals',
      oddsFormat: 'decimal',
      dateFormat: 'iso',
    });
  });

  it('uses the IPv6 host when asked', async () => {
    const { provider, requests, http } = await initialized({ useIpv6: true });
    await provider.fetchFixtures(window, context(http));
    expect(requests[1]?.url).toContain('ipv6-api.the-odds-api.com');
  });

  it('turns the sport key into the real sport group and competition title', async () => {
    const { provider, http } = await initialized();
    const fixtures = await provider.fetchFixtures(window, context(http));

    expect(fixtures[0]).toMatchObject({
      sportName: 'Soccer',
      competitionTitle: 'EPL',
      sportKey: 'soccer_epl',
    });
  });

  it('keeps every bookmaker as its own key', async () => {
    const { provider, http } = await initialized();
    const fixtures = await provider.fetchFixtures(window, context(http));

    expect(fixtures[0]?.books.map((book) => book.bookmakerKey)).toEqual(['book-one', 'book-two']);
    expect(fixtures[0]?.books[0]?.bookmakerTitle).toBe('Book One');
  });

  it('keeps the provider market keys untouched, including period and alternate markers', async () => {
    const { provider, http } = await initialized();
    const fixtures = await provider.fetchFixtures(window, context(http));

    const keys = fixtures[0]?.books[0]?.markets.map((market) => market.sourceKey) ?? [];
    expect(keys).toEqual(['h2h', 'totals', 'totals_h1', 'player_points']);
  });

  it('uses the market-level last_update, which the docs recommend over the bookmaker one', async () => {
    const { provider, http } = await initialized();
    const fixtures = await provider.fetchFixtures(window, context(http));

    const [h2h, totals] = fixtures[0]?.books[0]?.markets ?? [];
    expect(h2h?.updatedAt).toBe('2026-09-26T12:00:00.000Z');
    // The second market has its own, later timestamp.
    expect(totals?.updatedAt).toBe('2026-09-26T12:05:00.000Z');
  });

  it('carries point and description through for lines and player props', async () => {
    const { provider, http } = await initialized();
    const fixtures = await provider.fetchFixtures(window, context(http));

    const markets = fixtures[0]?.books[0]?.markets ?? [];
    const totals = markets.find((market) => market.sourceKey === 'totals');
    const prop = markets.find((market) => market.sourceKey === 'player_points');

    expect(totals?.outcomes[0]).toMatchObject({ name: 'Over', price: 1.95, point: 2.5 });
    expect(prop?.outcomes[0]).toMatchObject({ description: 'Player One', point: 25.5 });
  });

  it('decides "in play" from commence_time, because there is no live flag', async () => {
    // The sample kickoff is in the future relative to the injected clock.
    const upcoming = fakeHttp([sportsResponse, oddsResponse]);
    const upcomingProvider = createTheOddsApiProvider({ config: config(), sportKeys: ['soccer_epl'] });
    await upcomingProvider.init(context(upcoming.http));

    const prematch = await upcomingProvider.fetchFixtures(window, context(upcoming.http));
    expect(prematch).toHaveLength(1);
    expect(prematch[0]?.isLive).toBe(false);

    // The same event, with a kickoff that has already passed.
    const past = [
      {
        ...THE_ODDS_API_SAMPLE[0]!,
        commence_time: '2026-09-26T15:00:00Z',
      },
    ];

    const inPlay = fakeHttp([sportsResponse, { body: past }]);
    const inPlayProvider = createTheOddsApiProvider({ config: config(), sportKeys: ['soccer_epl'] });
    await inPlayProvider.init(context(inPlay.http));

    const liveWindow = {
      mode: 'live' as const,
      from: new Date('2026-09-26T14:00:00.000Z'),
      to: new Date('2026-09-26T18:00:00.000Z'),
      limit: 50,
    };

    const live = await inPlayProvider.fetchFixtures(liveWindow, context(inPlay.http));
    expect(live).toHaveLength(1);
    expect(live[0]?.isLive).toBe(true);

    // And it must not leak into the prematch window.
    const prematchAgain = await inPlayProvider.fetchFixtures(window, context(inPlay.http));
    expect(prematchAgain).toHaveLength(0);
  });

  it('records the quota the provider reports', async () => {
    const { provider, http } = await initialized();
    await provider.fetchFixtures(window, context(http));

    expect(provider.getUsage()).toMatchObject({ quotaRemaining: 421, quotaUsed: 79, lastCost: 3 });
  });

  it('stops fetching when the quota is below the configured floor', async () => {
    const { http } = fakeHttp([sportsResponse, oddsResponse]);
    const provider = createTheOddsApiProvider({ config: config({ minQuota: 500 }), sportKeys: ['soccer_epl'] });
    await provider.init(context(http));

    const fixtures = await provider.fetchFixtures(window, context(http));
    expect(fixtures).toEqual([]);
  });

  it('returns nothing rather than throwing when no event has prices', async () => {
    const { http } = fakeHttp([sportsResponse, { body: [] }]);
    const provider = createTheOddsApiProvider({ config: config(), sportKeys: ['soccer_epl'] });
    await provider.init(context(http));

    await expect(provider.fetchFixtures(window, context(http))).resolves.toEqual([]);
  });

  it('drops a bookmaker that prices nothing', async () => {
    const payload = [
      {
        ...THE_ODDS_API_SAMPLE[0],
        bookmakers: [
          ...THE_ODDS_API_SAMPLE[0]!.bookmakers,
          { key: 'empty-book', title: 'Empty', last_update: '2026-09-26T12:00:00Z', markets: [] },
        ],
      },
    ];

    const { http } = fakeHttp([sportsResponse, { body: payload }]);
    const provider = createTheOddsApiProvider({ config: config(), sportKeys: ['soccer_epl'] });
    await provider.init(context(http));

    const fixtures = await provider.fetchFixtures(window, context(http));
    expect(fixtures[0]?.books.map((book) => book.bookmakerKey)).toEqual(['book-one', 'book-two']);
  });

  it('excludes outrights by default and includes them when asked', async () => {
    // Outrights (futures) have null home/away teams.
    const outright = {
      id: 'outright-1',
      sport_key: 'soccer_epl_winner',
      sport_title: 'EPL Winner',
      commence_time: '2026-10-01T12:00:00Z',
      home_team: null,
      away_team: null,
      bookmakers: [
        {
          key: 'book-one',
          title: 'Book One',
          last_update: '2026-09-26T12:00:00Z',
          markets: [{ key: 'outrights', outcomes: [{ name: 'Arsenal', price: 4.5 }] }],
        },
      ],
    };

    const payload = [...THE_ODDS_API_SAMPLE, outright];
    const bothSports = config({ sports: ['soccer_epl', 'soccer_epl_winner'] });

    const without = fakeHttp([sportsResponse, { body: payload }]);
    const providerA = createTheOddsApiProvider({ config: bothSports, includeOutrights: false, sportKeys: ['soccer_epl', 'soccer_epl_winner'] });
    await providerA.init(context(without.http));
    const excluded = await providerA.fetchFixtures(window, context(without.http));

    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded.every((fixture) => fixture.homeTeam !== null)).toBe(true);

    const withThem = fakeHttp([sportsResponse, { body: payload }]);
    const providerB = createTheOddsApiProvider({ config: bothSports, includeOutrights: true, sportKeys: ['soccer_epl', 'soccer_epl_winner'] });
    await providerB.init(context(withThem.http));
    const included = await providerB.fetchFixtures(window, context(withThem.http));

    expect(included.some((fixture) => fixture.homeTeam === null)).toBe(true);
  });

  it('refuses to run without an API key', async () => {
    const provider = createTheOddsApiProvider({ config: config({ apiKey: null }), sportKeys: ['soccer_epl'] });
    await expect(provider.init(context(fakeHttp([]).http))).rejects.toThrow(/THE_ODDS_API_KEY is empty/);
  });

  it('refuses to fetch before init', async () => {
    const provider = createTheOddsApiProvider({ config: config(), sportKeys: ['soccer_epl'] });
    await expect(provider.fetchFixtures(window, context(fakeHttp([]).http))).rejects.toThrow(/before init/);
  });

  it('rejects a response that is not the documented array shape', async () => {
    const { http } = fakeHttp([sportsResponse, { body: { error: 'unexpected' } }]);
    const provider = createTheOddsApiProvider({ config: config(), sportKeys: ['soccer_epl'] });
    await provider.init(context(http));

    await expect(provider.fetchFixtures(window, context(http))).rejects.toThrow(/unexpected payload/);
  });

  it('estimates the quota cost as markets x regions', async () => {
    const { estimateOddsCost } = await import('../../src/providers/the-odds-api/api.ts');

    expect(estimateOddsCost({ sportKey: 'x', markets: ['h2h'], regions: ['uk'], oddsFormat: 'decimal' })).toBe(1);
    expect(
      estimateOddsCost({ sportKey: 'x', markets: ['h2h', 'totals'], regions: ['uk', 'eu'], oddsFormat: 'decimal' }),
    ).toBe(4);
    // Up to 10 bookmakers count as a single region, per the docs.
    expect(
      estimateOddsCost({ sportKey: 'x', markets: ['h2h'], bookmakers: ['a', 'b', 'c'], oddsFormat: 'decimal' }),
    ).toBe(1);
  });

  it('sends time parameters at second precision, which the API validates strictly', async () => {
    const { toProviderTime } = await import('../../src/providers/the-odds-api/api.ts');

    // Date.toISOString() emits milliseconds; the API rejects that with
    // INVALID_COMMENCE_TIME_FROM (422), so the adapter must strip them.
    expect(new Date('2026-11-16T12:57:48.240Z').toISOString()).toBe('2026-11-16T12:57:48.240Z');
    expect(toProviderTime(new Date('2026-11-16T12:57:48.240Z'))).toBe('2026-11-16T12:57:48Z');
    expect(toProviderTime('2026-11-16T12:57:48.240Z')).toBe('2026-11-16T12:57:48Z');
    expect(toProviderTime('2026-09-09T00:00:00Z')).toBe('2026-09-09T00:00:00Z');

    expect(() => toProviderTime('not a date')).toThrow(/cannot format/);
  });

  it('formats the commenceTime parameters it actually puts on the wire', async () => {
    const { http, requests } = fakeHttp([sportsResponse, oddsResponse]);
    const provider = createTheOddsApiProvider({ config: config(), sportKeys: ['soccer_epl'] });
    await provider.init(context(http));

    await provider.fetchFixtures(
      {
        mode: 'prematch',
        // Deliberately millisecond-laden, exactly what the engine computes.
        from: new Date('2026-09-26T18:00:00.123Z'),
        to: new Date('2026-10-03T18:00:00.987Z'),
        limit: 50,
      },
      context(http),
    );

    expect(requests[1]?.query?.['commenceTimeFrom']).toBe('2026-09-26T18:00:00Z');
    expect(requests[1]?.query?.['commenceTimeTo']).toBe('2026-10-03T18:00:00Z');
  });

  it('omits the commenceTime parameters entirely in live mode', async () => {
    const { http, requests } = fakeHttp([sportsResponse, oddsResponse]);
    const provider = createTheOddsApiProvider({ config: config(), sportKeys: ['soccer_epl'] });
    await provider.init(context(http));

    await provider.fetchFixtures(
      { mode: 'live', from: new Date('2026-09-26T14:00:00Z'), to: new Date('2026-09-26T18:00:00Z'), limit: 50 },
      context(http),
    );

    expect(requests[1]?.query?.['commenceTimeFrom']).toBeUndefined();
    expect(requests[1]?.query?.['commenceTimeTo']).toBeUndefined();
  });
});

describe('adapter shutdown', () => {
  it('is safe to call twice and refuses further use afterwards', async () => {
    const { provider, http } = await initialized();
    await provider.shutdown();
    await expect(provider.shutdown()).resolves.toBeUndefined();
    await expect(provider.fetchFixtures(window, context(http))).rejects.toThrow(/before init/);
  });
});

describe('fake transport sanity', () => {
  it('records one request per call', async () => {
    const { http, requests } = fakeHttp([sportsResponse]);
    await http.request({ url: 'https://x.test/a', label: 'a' });
    expect(requests).toHaveLength(1);
    expect(vi.isMockFunction(http.request)).toBe(false);
  });
});
