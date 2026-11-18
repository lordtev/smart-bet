/**
 * The mock provider is the development workhorse, so its behaviour has to be
 * predictable: deterministic per cycle number, and awkward in the ways real
 * providers are awkward.
 */
import { describe, expect, it } from 'vitest';
import { createMockProvider } from '../../src/providers/mock.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import type { AdapterContext, FetchWindow } from '../../src/providers/types.ts';

const FIXED_NOW = new Date('2026-09-26T18:00:00.000Z');

function context(): AdapterContext {
  return {
    log: silentLogger(),
    signal: new AbortController().signal,
    http: {
      request: async <T,>() => ({ status: 200, data: null as T, headers: {}, durationMs: 0 }),
    },
    now: () => FIXED_NOW,
  };
}

const prematch: FetchWindow = {
  mode: 'prematch',
  from: new Date('2026-09-26T18:00:00.000Z'),
  to: new Date('2026-10-03T18:00:00.000Z'),
  limit: 100,
};

const live: FetchWindow = {
  mode: 'live',
  from: new Date('2026-09-26T14:00:00.000Z'),
  to: FIXED_NOW,
  limit: 100,
};

describe('mock provider payloads', () => {
  it('produces the requested number of prematch fixtures inside the window', async () => {
    const provider = createMockProvider({ fixtureCount: 4, now: () => FIXED_NOW });
    await provider.init(context());

    const fixtures = await provider.fetchFixtures(prematch, context());

    expect(fixtures).toHaveLength(4);
    for (const fixture of fixtures) {
      const start = Date.parse(fixture.commenceTime);
      expect(start).toBeGreaterThanOrEqual(prematch.from.getTime());
      expect(start).toBeLessThanOrEqual(prematch.to.getTime());
      expect(fixture.isLive).toBe(false);
      expect(fixture.books.length).toBeGreaterThan(0);
    }
  });

  it('produces in-play fixtures for the live window', async () => {
    const provider = createMockProvider({ fixtureCount: 3, now: () => FIXED_NOW });
    await provider.init(context());

    const fixtures = await provider.fetchFixtures(live, context());

    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.every((fixture) => fixture.isLive)).toBe(true);
    expect(fixtures.every((fixture) => fixture.minute !== null)).toBe(true);
  });

  it('is deterministic for a given cycle number', async () => {
    const first = createMockProvider({ fixtureCount: 2, seed: 42, cycle: 5, jitterPct: 5, now: () => FIXED_NOW });
    const second = createMockProvider({ fixtureCount: 2, seed: 42, cycle: 5, jitterPct: 5, now: () => FIXED_NOW });

    const a = await first.fetchFixtures(prematch, context());
    const b = await second.fetchFixtures(prematch, context());

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('moves prices between cycles', async () => {
    const provider = createMockProvider({ fixtureCount: 2, jitterPct: 8, now: () => FIXED_NOW });

    const first = await provider.fetchFixtures(prematch, context());
    const second = await provider.fetchFixtures(prematch, context());

    const prices = (fixtures: Awaited<ReturnType<typeof provider.fetchFixtures>>): number[] =>
      fixtures.flatMap((fixture) =>
        fixture.books.flatMap((book) => book.markets.flatMap((market) => market.outcomes.map((outcome) => outcome.price))),
      );

    expect(prices(first)).not.toEqual(prices(second));
  });

  it('can omit markets entirely, to stand in for an incomplete response', async () => {
    const provider = createMockProvider({ fixtureCount: 3, omitMarketsPct: 100, now: () => FIXED_NOW });
    const fixtures = await provider.fetchFixtures(prematch, context());

    const marketCount = fixtures.reduce(
      (sum, fixture) => sum + fixture.books.reduce((inner, book) => inner + book.markets.length, 0),
      0,
    );

    // Books with no markets are dropped, so the payload is effectively empty.
    expect(marketCount).toBe(0);
    expect(fixtures.every((fixture) => fixture.books.length === 0)).toBe(true);
  });

  it('can suspend markets', async () => {
    const provider = createMockProvider({ fixtureCount: 2, seedChangePct: 100, now: () => FIXED_NOW });
    const fixtures = await provider.fetchFixtures(prematch, context());

    const markets = fixtures.flatMap((fixture) => fixture.books.flatMap((book) => book.markets));
    expect(markets.length).toBeGreaterThan(0);
    expect(markets.every((market) => market.status === 'suspended')).toBe(true);
  });

  it('emits several bookmakers when asked, with distinct prices', async () => {
    const provider = createMockProvider({ fixtureCount: 1, bookmakers: ['a', 'b'], now: () => FIXED_NOW });
    const fixtures = await provider.fetchFixtures(prematch, context());

    const books = fixtures[0]?.books ?? [];
    expect(books.map((book) => book.bookmakerKey)).toEqual(['a', 'b']);

    const firstMarket = books[0]?.markets[0];
    const secondMarket = books[1]?.markets[0];
    expect(firstMarket?.sourceKey).toBe(secondMarket?.sourceKey);
    expect(firstMarket?.outcomes[0]?.price).not.toBe(secondMarket?.outcomes[0]?.price);
  });

  it('names participants in 1X2 so the engine can map them to HOME/AWAY', async () => {
    const provider = createMockProvider({ fixtureCount: 1, now: () => FIXED_NOW });
    const fixtures = await provider.fetchFixtures(prematch, context());

    const fixture = fixtures[0]!;
    const market = fixture.books[0]?.markets.find((entry) => entry.sourceKey === '1X2');
    const names = market?.outcomes.map((outcome) => outcome.name) ?? [];

    expect(names).toContain(fixture.homeTeam);
    expect(names).toContain(fixture.awayTeam);
    expect(names).toContain('Draw');
  });

  it('offers a first-half market, so the period dimension is exercised', async () => {
    const provider = createMockProvider({ fixtureCount: 1, marketsPerFixture: 5, now: () => FIXED_NOW });
    const fixtures = await provider.fetchFixtures(prematch, context());

    const keys = fixtures[0]?.books[0]?.markets.map((market) => market.sourceKey) ?? [];
    expect(keys).toContain('1X2_1H');
  });

  it('reports quota usage rather than pretending to have one', async () => {
    const provider = createMockProvider({ fixtureCount: 1, now: () => FIXED_NOW });
    await provider.fetchFixtures(prematch, context());

    expect(provider.getUsage()).toMatchObject({ quotaRemaining: null, lastCost: 0 });
  });

  it('honours the window limit', async () => {
    const provider = createMockProvider({ fixtureCount: 20, now: () => FIXED_NOW });
    const fixtures = await provider.fetchFixtures({ ...prematch, limit: 3 }, context());
    expect(fixtures).toHaveLength(3);
  });

  it('fails on demand so outage behaviour can be tested', async () => {
    const network = createMockProvider({ failAlways: 'network' });
    await expect(network.fetchFixtures(prematch, context())).rejects.toThrow(/fail: network/);

    const auth = createMockProvider({ failAlways: 'auth' });
    await expect(auth.init(context())).rejects.toThrow(/fail: auth/);

    const quota = createMockProvider({ failAlways: 'quota' });
    await expect(quota.fetchFixtures(prematch, context())).rejects.toThrow(/quota exhausted/);
    expect(quota.getUsage().quotaRemaining).toBe(0);
  });

  it('counts its calls and can be rewound to a cycle', async () => {
    const provider = createMockProvider({ fixtureCount: 1, now: () => FIXED_NOW });

    await provider.fetchFixtures(prematch, context());
    await provider.fetchFixtures(prematch, context());
    expect(provider.callCount()).toBe(2);

    provider.setCycle(1);
    const rewound = await provider.fetchFixtures(prematch, context());
    provider.setCycle(1);
    const replayed = await provider.fetchFixtures(prematch, context());

    expect(JSON.stringify(rewound)).toBe(JSON.stringify(replayed));
  });

  it('keeps every price inside the storable range', async () => {
    const provider = createMockProvider({ fixtureCount: 6, jitterPct: 40, now: () => FIXED_NOW });
    const fixtures = await provider.fetchFixtures(prematch, context());

    const prices = fixtures.flatMap((fixture) =>
      fixture.books.flatMap((book) => book.markets.flatMap((market) => market.outcomes.map((outcome) => outcome.price))),
    );

    expect(prices.every((price) => price >= 1.01 && price <= 50)).toBe(true);
  });
});
