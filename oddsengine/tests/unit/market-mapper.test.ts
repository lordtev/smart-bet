/**
 * The market mapper is where "which market is this, really" is decided. These
 * tests are the specification for that decision.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildRuleIndex, findRule, mapFixture, type MarketRule, type MarketRuleSource } from '../../src/map/market-mapper.ts';
import type { NormalizedFixture } from '../../src/providers/types.ts';

function rules(list: Array<Partial<MarketRule> & { providerKey: string }>): MarketRule[] {
  return list.map((rule) => ({
    providerKey: rule.providerKey,
    canonicalCode: 'canonicalCode' in rule ? (rule.canonicalCode ?? null) : 'MATCH_WINNER',
    canonicalName: rule.canonicalName ?? '1X2',
    period: rule.period ?? 'FT',
    lineType: rule.lineType ?? 'none',
    outcomeMap: rule.outcomeMap ?? null,
    reviewStatus: rule.reviewStatus ?? 'mapped',
  }));
}

function ruleSource(list: MarketRule[]): MarketRuleSource & { recorded: unknown[] } {
  const recorded: unknown[] = [];
  return {
    listRules: async () => list,
    recordUnknownMarket: async (input) => {
      recorded.push(input);
    },
    recorded,
  };
}

/** A minimal fixture with one bookmaker. */
function fixture(
  markets: NormalizedFixture['books'][number]['markets'],
  overrides: Partial<NormalizedFixture> = {},
): NormalizedFixture {
  return {
    sourceEventKey: 'fx-1',
    sportName: 'Football',
    sportKey: 'soccer_epl',
    competitionTitle: 'Premier League',
    countryCode: 'GB',
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    name: 'Arsenal vs Chelsea',
    commenceTime: '2026-09-26T15:00:00.000Z',
    isLive: false,
    homeScore: null,
    awayScore: null,
    minute: null,
    books: [{ bookmakerKey: 'default', bookmakerTitle: 'Book', markets }],
    ...overrides,
  };
}

const standardRules = rules([
  { providerKey: 'h2h', canonicalCode: 'MATCH_WINNER', canonicalName: '1X2' },
  { providerKey: 'totals', canonicalCode: 'OVER_UNDER', canonicalName: 'Over / Under', lineType: 'total' },
  { providerKey: 'spreads', canonicalCode: 'SPREADS', canonicalName: 'Handicap', lineType: 'spread' },
  { providerKey: 'btts', canonicalCode: 'BTTS', canonicalName: 'Both teams to score' },
  { providerKey: 'player_*', canonicalCode: 'PLAYER_%', canonicalName: 'Player prop', lineType: 'total' },
]);

describe('rule index', () => {
  it('prefers an exact rule over a wildcard', () => {
    const index = buildRuleIndex([
      ...standardRules,
      ...rules([{ providerKey: 'player_points', canonicalCode: 'PLAYER_POINTS', canonicalName: 'Points' }]),
    ]);

    expect(findRule(index, 'player_points')?.canonicalCode).toBe('PLAYER_POINTS');
    expect(findRule(index, 'player_rebounds')?.canonicalCode).toBe('PLAYER_%');
  });

  it('returns null for an unknown market', () => {
    expect(findRule(buildRuleIndex(standardRules), 'mystery_market')).toBeNull();
  });
});

describe('mapFixture', () => {
  it('maps a 1X2 market to one canonical market with HOME/DRAW/AWAY', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'h2h',
          status: 'open',
          updatedAt: '2026-09-26T14:00:00.000Z',
          outcomes: [
            { sourceKey: 'a', name: 'Arsenal', price: 2.1 },
            { sourceKey: 'b', name: 'Draw', price: 3.4 },
            { sourceKey: 'c', name: 'Chelsea', price: 3.3 },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    const market = result.markets[0]?.markets[0];
    expect(market?.canonicalKey).toBe('MATCH_WINNER|FT||');
    expect(market?.outcomes.map((outcome) => outcome.outcomeKey)).toEqual(['HOME', 'DRAW', 'AWAY']);
    expect(market?.providerUpdatedAt).toBe('2026-09-26T14:00:00.000Z');
    expect(result.requiredMarketTypes.get('MATCH_WINNER')).toBe('1X2');
  });

  it('splits a totals market into one canonical market per line', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'alternate_totals',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: '1', name: 'Over', price: 1.9, point: 1.5 },
            { sourceKey: '2', name: 'Under', price: 1.9, point: 1.5 },
            { sourceKey: '3', name: 'Over', price: 2.4, point: 2.5 },
            { sourceKey: '4', name: 'Under', price: 1.55, point: 2.5 },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    const keys = result.markets[0]?.markets.map((market) => market.canonicalKey).sort();
    expect(keys).toEqual(['OVER_UNDER|FT|1.5|', 'OVER_UNDER|FT|2.5|']);

    const line25 = result.markets[0]?.markets.find((market) => market.line === 2.5);
    expect(line25?.outcomes.map((outcome) => outcome.outcomeKey)).toEqual(['OVER', 'UNDER']);
    expect(line25?.outcomes.find((outcome) => outcome.outcomeKey === 'OVER')?.price).toBe(2.4);
  });

  it('treats a spread as ONE market even though each side has an opposite point', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'spreads',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: '1', name: 'Arsenal', price: 1.9, point: -1.5 },
            { sourceKey: '2', name: 'Chelsea', price: 1.95, point: 1.5 },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    const markets = result.markets[0]?.markets ?? [];
    expect(markets).toHaveLength(1);
    // The line is expressed from the home side, by convention.
    expect(markets[0]?.canonicalKey).toBe('SPREADS|FT|-1.5|');
    expect(markets[0]?.outcomes.map((outcome) => outcome.outcomeKey).sort()).toEqual(['AWAY', 'HOME']);
  });

  it('keeps alternate spread lines separate', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'alternate_spreads',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: '1', name: 'Arsenal', price: 1.9, point: -1.5 },
            { sourceKey: '2', name: 'Chelsea', price: 1.95, point: 1.5 },
            { sourceKey: '3', name: 'Arsenal', price: 2.6, point: -2.5 },
            { sourceKey: '4', name: 'Chelsea', price: 1.5, point: 2.5 },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    const keys = result.markets[0]?.markets.map((market) => market.canonicalKey).sort();
    expect(keys).toEqual(['SPREADS|FT|-1.5|', 'SPREADS|FT|-2.5|']);
  });

  it('lets the period carried by the market key beat the rule default', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'h2h_h1',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: 'a', name: 'Arsenal', price: 2.4 },
            { sourceKey: 'b', name: 'Draw', price: 2.1 },
            { sourceKey: 'c', name: 'Chelsea', price: 4.2 },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    expect(result.markets[0]?.markets[0]?.canonicalKey).toBe('MATCH_WINNER|H1||');
    expect(result.markets[0]?.markets[0]?.period).toBe('H1');
  });

  it('lets an explicit rule period win when the key carries none', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: '1X2_1H',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: 'a', name: 'Arsenal', price: 2.4 },
            { sourceKey: 'b', name: 'Draw', price: 2.1 },
            { sourceKey: 'c', name: 'Chelsea', price: 4.2 },
          ],
        },
      ]),
      ruleSource: ruleSource(rules([{ providerKey: '1x2_1h', canonicalCode: 'MATCH_WINNER', period: 'H1' }])),
      providerKey: 'test',
    });

    expect(result.markets[0]?.markets[0]?.canonicalKey).toBe('MATCH_WINNER|H1||');
  });

  it('splits a player-prop market into one market per player and line', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'player_points',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: '1', name: 'Over', price: 1.9, point: 25.5, description: 'LeBron James' },
            { sourceKey: '2', name: 'Under', price: 1.9, point: 25.5, description: 'LeBron James' },
            { sourceKey: '3', name: 'Over', price: 1.85, point: 28.5, description: 'Stephen Curry' },
            { sourceKey: '4', name: 'Under', price: 1.95, point: 28.5, description: 'Stephen Curry' },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    const keys = result.markets[0]?.markets.map((market) => market.canonicalKey).sort();
    expect(keys).toEqual(['PLAYER_POINTS|FT|25.5|lebron_james', 'PLAYER_POINTS|FT|28.5|stephen_curry']);
    expect(result.requiredMarketTypes.get('PLAYER_POINTS')).toBe('Player prop');
  });

  it('does not treat two players on the same line as one market', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'player_rebounds',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: '1', name: 'Over', price: 1.9, point: 10.5, description: 'Player A' },
            { sourceKey: '2', name: 'Under', price: 1.9, point: 10.5, description: 'Player A' },
            { sourceKey: '3', name: 'Over', price: 2.0, point: 10.5, description: 'Player B' },
            { sourceKey: '4', name: 'Under', price: 1.8, point: 10.5, description: 'Player B' },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    const markets = result.markets[0]?.markets ?? [];
    expect(markets).toHaveLength(2);
    expect(markets.map((market) => market.subject).sort()).toEqual(['Player A', 'Player B']);
  });

  it('records an unknown market for review and maps it when auto-mapping is on', async () => {
    const source = ruleSource(standardRules);

    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'mystery_market',
          status: 'open',
          updatedAt: null,
          outcomes: [{ sourceKey: 'a', name: 'Yes', price: 2.1 }],
        },
      ]),
      ruleSource: source,
      providerKey: 'test',
      options: { autoMapUnknownMarkets: true },
    });

    expect(source.recorded).toHaveLength(1);
    expect(source.recorded[0]).toMatchObject({
      providerMarketKey: 'mystery_market',
      derivedCanonicalCode: 'EXT_MYSTERY_MARKET',
      autoMapped: true,
    });

    expect(result.markets[0]?.markets[0]?.canonicalKey).toBe('EXT_MYSTERY_MARKET|FT||');
    expect(result.requiredMarketTypes.has('EXT_MYSTERY_MARKET')).toBe(true);
    expect(result.stats.unknownMarkets).toContain('mystery_market');
  });

  it('skips an unknown market but still queues it when auto-mapping is off', async () => {
    const source = ruleSource(standardRules);

    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'mystery_market',
          status: 'open',
          updatedAt: null,
          outcomes: [{ sourceKey: 'a', name: 'Yes', price: 2.1 }],
        },
        {
          sourceKey: 'h2h',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: 'a', name: 'Arsenal', price: 2 },
            { sourceKey: 'c', name: 'Chelsea', price: 3.5 },
          ],
        },
      ]),
      ruleSource: source,
      providerKey: 'test',
      options: { autoMapUnknownMarkets: false },
    });

    expect(source.recorded).toHaveLength(1);
    expect(source.recorded[0]).toMatchObject({ providerMarketKey: 'mystery_market', autoMapped: false });
    // The known market still went through - one unknown market does not cost the fixture.
    expect(result.markets[0]?.markets.map((market) => market.canonicalKey)).toEqual(['MATCH_WINNER|FT||']);
  });

  it('never silently discards an unusable price, it counts it', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'h2h',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: 'a', name: 'Arsenal', price: 0.5 },
            { sourceKey: 'b', name: 'Draw', price: 3.4 },
            { sourceKey: 'c', name: 'Chelsea', price: 3.3 },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    expect(result.stats.rejectedPrices).toBe(1);
    expect(result.markets[0]?.markets[0]?.outcomes.map((outcome) => outcome.outcomeKey)).toEqual(['DRAW', 'AWAY']);
  });

  it('drops a market whose only price was unusable', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'btts',
          status: 'open',
          updatedAt: null,
          outcomes: [{ sourceKey: 'a', name: 'Yes', price: 0.9 }],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    expect(result.markets).toHaveLength(0);
    expect(result.stats.rejectedPrices).toBe(1);
  });

  it('mirrors a suspended market onto its outcomes', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'h2h',
          status: 'suspended',
          updatedAt: null,
          outcomes: [
            { sourceKey: 'a', name: 'Arsenal', price: 2 },
            { sourceKey: 'c', name: 'Chelsea', price: 3.5 },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    expect(result.markets[0]?.markets[0]?.status).toBe('suspended');
    expect(result.markets[0]?.markets[0]?.outcomes.every((outcome) => outcome.status === 'suspended')).toBe(true);
  });

  it('skips a closed market entirely', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'h2h',
          status: 'closed',
          updatedAt: null,
          outcomes: [
            { sourceKey: 'a', name: 'Arsenal', price: 2 },
            { sourceKey: 'c', name: 'Chelsea', price: 3.5 },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    expect(result.markets).toHaveLength(0);
  });

  it('ignores a market whose rule is explicitly ignored', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'h2h',
          status: 'open',
          updatedAt: null,
          outcomes: [{ sourceKey: 'a', name: 'Arsenal', price: 2 }],
        },
      ]),
      ruleSource: ruleSource(rules([{ providerKey: 'h2h', canonicalCode: null, reviewStatus: 'ignored' }])),
      providerKey: 'test',
    });

    expect(result.markets).toHaveLength(0);
    expect(result.stats.ignoredMarkets).toContain('h2h');
  });

  it('keeps a rule still in review out of the catalogue but in the queue', async () => {
    const source = ruleSource(rules([{ providerKey: 'h2h', canonicalCode: null, reviewStatus: 'pending' }]));

    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'h2h',
          status: 'open',
          updatedAt: null,
          outcomes: [{ sourceKey: 'a', name: 'Arsenal', price: 2 }],
        },
      ]),
      ruleSource: source,
      providerKey: 'test',
    });

    expect(result.markets).toHaveLength(0);
    expect(source.recorded.length).toBeGreaterThan(0);
  });

  it('reports every distinct unknown market once per fixture, across bookmakers', async () => {
    const source = ruleSource(standardRules);
    const subject = fixture([
      {
        sourceKey: 'mystery_market',
        status: 'open',
        updatedAt: null,
        outcomes: [{ sourceKey: 'a', name: 'Yes', price: 2.1 }],
      },
    ]);
    subject.books.push({
      bookmakerKey: 'second',
      bookmakerTitle: 'Second',
      markets: subject.books[0]!.markets,
    });

    await mapFixture({ fixture: subject, ruleSource: source, providerKey: 'test' });

    expect(source.recorded).toHaveLength(1);
  });

  it('expands a wildcard rule into a canonical code from the matched remainder', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'player_threes',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: '1', name: 'Over', price: 1.9, point: 2.5, description: 'Player A' },
            { sourceKey: '2', name: 'Under', price: 1.9, point: 2.5, description: 'Player A' },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    expect(result.requiredMarketTypes.has('PLAYER_THREES')).toBe(true);
    expect(result.markets[0]?.markets[0]?.canonicalKey).toBe('PLAYER_THREES|FT|2.5|player_a');
  });

  it('merges two provider markets that address the same canonical market', async () => {
    const result = await mapFixture({
      fixture: fixture([
        {
          sourceKey: 'totals',
          status: 'open',
          updatedAt: null,
          outcomes: [
            { sourceKey: '1', name: 'Over', price: 1.9, point: 2.5 },
            { sourceKey: '2', name: 'Under', price: 1.9, point: 2.5 },
          ],
        },
        {
          sourceKey: 'alternate_totals',
          status: 'open',
          updatedAt: null,
          outcomes: [
            // Same line, arriving from a second market: must not create a duplicate.
            { sourceKey: '3', name: 'Over', price: 1.95, point: 2.5 },
            { sourceKey: '4', name: 'Under', price: 1.85, point: 2.5 },
            { sourceKey: '5', name: 'Over', price: 2.4, point: 3.5 },
            { sourceKey: '6', name: 'Under', price: 1.55, point: 3.5 },
          ],
        },
      ]),
      ruleSource: ruleSource(standardRules),
      providerKey: 'test',
    });

    const markets = result.markets[0]?.markets ?? [];
    expect(markets.filter((market) => market.canonicalKey === 'OVER_UNDER|FT|2.5|')).toHaveLength(1);
    expect(markets.filter((market) => market.canonicalKey === 'OVER_UNDER|FT|3.5|')).toHaveLength(1);
    expect(result.stats.duplicateOutcomes).toBeGreaterThan(0);
  });

  it('propagates a failing rule source, because nothing downstream is trustworthy then', async () => {
    const broken: MarketRuleSource = {
      listRules: async () => {
        throw new Error('rules unavailable');
      },
      recordUnknownMarket: vi.fn(),
    };

    await expect(
      mapFixture({ fixture: fixture([]), ruleSource: broken, providerKey: 'test' }),
    ).rejects.toThrow('rules unavailable');
  });
});
