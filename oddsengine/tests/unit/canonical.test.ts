/**
 * Canonical identity is the contract between the engine and the database.
 * These tests pin the exact strings, because a drift here means two providers
 * silently stop meeting on the same market.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalMarketKey,
  humaniseCode,
  lineKey,
  marketDisplayName,
  outcomeSortIndex,
  OUTCOME_ORDER_FALLBACK,
  parseMarketKey,
  periodLabel,
  resolveOutcomeKey,
  slug,
  teamKey,
} from '../../src/normalize/canonical.ts';

describe('lineKey', () => {
  // These must match the SQL function odds_line_key() exactly.
  it.each([
    [2.5, '2.5'],
    [2.0, '2'],
    [3, '3'],
    [-1.25, '-1.25'],
    [0, '0'],
    [220.5, '220.5'],
    [-0.5, '-0.5'],
    [1.5, '1.5'],
    [0.25, '0.25'],
    [10, '10'],
  ])('%s → %s', (input, expected) => {
    expect(lineKey(input)).toBe(expected);
  });

  it('returns an empty string for a missing line', () => {
    expect(lineKey(null)).toBe('');
    expect(lineKey(undefined)).toBe('');
    expect(lineKey(Number.NaN)).toBe('');
  });

  it('rounds to the storage resolution of markets.line', () => {
    // numeric(8,2): 2.375 cannot be stored, so the key must describe what is.
    expect(lineKey(2.375)).toBe('2.38');
  });

  it('never mutates a zero-padded integer into a wrong value', () => {
    expect(lineKey(100)).toBe('100');
    expect(lineKey(-10)).toBe('-10');
  });
});

describe('slug / teamKey', () => {
  it('strips diacritics and punctuation', () => {
    expect(slug('Bayern München')).toBe('bayern_munchen');
    expect(teamKey("Nott'm Forest")).toBe('nott_m_forest');
  });

  it('collapses repeated separators and trims them', () => {
    expect(slug('  A   B  ')).toBe('a_b');
  });
});

describe('parseMarketKey', () => {
  it.each([
    ['totals', 'totals', 'FT', false],
    ['totals_h1', 'totals', 'H1', false],
    ['totals_q3', 'totals', 'Q3', false],
    ['h2h_p1', 'h2h', 'P1', false],
    ['btts_s1', 'btts', 'S1', false],
    ['h2h_1st_5_innings', 'h2h', 'I5', false],
    ['alternate_totals_q2', 'totals', 'Q2', true],
    ['player_points_alternate', 'player_points', 'FT', true],
  ])('%s → base=%s period=%s alternate=%s', (raw, base, period, alternate) => {
    const parsed = parseMarketKey(raw);
    expect(parsed.base).toBe(base);
    expect(parsed.period).toBe(period);
    expect(parsed.alternate).toBe(alternate);
  });

  it('does not treat a stat qualifier as a period', () => {
    // `_corners` is a different market from `totals`, not a different period.
    const parsed = parseMarketKey('totals_corners');
    expect(parsed.base).toBe('totals_corners');
    expect(parsed.period).toBe('FT');
  });

  it('leaves an already-normalised key alone', () => {
    expect(parseMarketKey('1X2').base).toBe('1x2');
    expect(parseMarketKey('1X2_1H').base).toBe('1x2_1h');
  });
});

describe('canonicalMarketKey', () => {
  it('distinguishes period, line and subject', () => {
    expect(canonicalMarketKey({ canonicalCode: 'MATCH_WINNER', period: 'FT' })).toBe('MATCH_WINNER|FT||');
    expect(canonicalMarketKey({ canonicalCode: 'OVER_UNDER', period: 'FT', line: 2.5 })).toBe(
      'OVER_UNDER|FT|2.5|',
    );
    expect(canonicalMarketKey({ canonicalCode: 'MATCH_WINNER', period: 'H1' })).toBe('MATCH_WINNER|H1||');
    expect(
      canonicalMarketKey({ canonicalCode: 'PLAYER_POINTS', period: 'FT', line: 25.5, subject: 'LeBron James' }),
    ).toBe('PLAYER_POINTS|FT|25.5|lebron_james');
  });

  it('gives different subjects different keys', () => {
    const a = canonicalMarketKey({ canonicalCode: 'PLAYER_POINTS', period: 'FT', line: 25.5, subject: 'LeBron James' });
    const b = canonicalMarketKey({ canonicalCode: 'PLAYER_POINTS', period: 'FT', line: 25.5, subject: 'Stephen Curry' });
    expect(a).not.toBe(b);
  });
});

describe('resolveOutcomeKey', () => {
  const base = { marketCode: 'MATCH_WINNER', lineType: 'none' as const, homeTeam: 'Arsenal', awayTeam: 'Chelsea' };

  it('maps participant names to HOME / AWAY', () => {
    expect(resolveOutcomeKey({ ...base, name: 'Arsenal' })).toBe('HOME');
    expect(resolveOutcomeKey({ ...base, name: 'Chelsea' })).toBe('AWAY');
    expect(resolveOutcomeKey({ ...base, name: 'Draw' })).toBe('DRAW');
  });

  it('is case and punctuation insensitive for participants', () => {
    expect(resolveOutcomeKey({ ...base, name: 'ARSENAL' })).toBe('HOME');
    expect(resolveOutcomeKey({ ...base, name: 'Arsenal F.C.' })).toBe('HOME');
  });

  it('maps the generic vocabulary', () => {
    expect(resolveOutcomeKey({ ...base, name: 'Home' })).toBe('HOME');
    expect(resolveOutcomeKey({ ...base, name: '1' })).toBe('HOME');
    expect(resolveOutcomeKey({ ...base, name: 'X' })).toBe('DRAW');
    expect(resolveOutcomeKey({ ...base, name: '2' })).toBe('AWAY');
    expect(resolveOutcomeKey({ ...base, name: 'Home or Draw' })).toBe('HOME_OR_DRAW');
    expect(resolveOutcomeKey({ ...base, name: 'Yes' })).toBe('YES');
    expect(resolveOutcomeKey({ ...base, name: 'No' })).toBe('NO');
  });

  it('handles labels that carry the line in the text', () => {
    expect(resolveOutcomeKey({ ...base, name: 'Over 2.5' })).toBe('OVER');
    expect(resolveOutcomeKey({ ...base, name: 'Under 220.5' })).toBe('UNDER');
  });

  it('turns a scoreline into a correct-score key', () => {
    expect(resolveOutcomeKey({ ...base, name: '2-1' })).toBe('CS_2_1');
    expect(resolveOutcomeKey({ ...base, name: '0:0' })).toBe('CS_0_0');
  });

  it('honours an explicit provider override before anything else', () => {
    expect(
      resolveOutcomeKey({ ...base, name: '1', outcomeMap: { '1': 'HOME_OR_DRAW' } }),
    ).toBe('HOME_OR_DRAW');
  });

  it('never drops an unknown label', () => {
    expect(resolveOutcomeKey({ ...base, name: 'Some Prop Outcome' })).toBe('NAME_SOME_PROP_OUTCOME');
  });

  it('does not confuse a team called "Home" with the home side of another match', () => {
    expect(
      resolveOutcomeKey({
        marketCode: 'MATCH_WINNER',
        lineType: 'none',
        homeTeam: 'Real Madrid',
        awayTeam: 'Barcelona',
        name: 'Draw',
      }),
    ).toBe('DRAW');
  });
});

describe('outcomeSortIndex', () => {
  it('orders 1X2 as home, draw, away — whatever the provider sent', () => {
    expect(outcomeSortIndex('HOME')).toBeLessThan(outcomeSortIndex('DRAW'));
    expect(outcomeSortIndex('DRAW')).toBeLessThan(outcomeSortIndex('AWAY'));
  });

  it('orders two-way markets', () => {
    expect(outcomeSortIndex('OVER')).toBeLessThan(outcomeSortIndex('UNDER'));
    expect(outcomeSortIndex('YES')).toBeLessThan(outcomeSortIndex('NO'));
  });

  it('orders double chance', () => {
    expect(outcomeSortIndex('HOME_OR_DRAW')).toBeLessThan(outcomeSortIndex('HOME_OR_AWAY'));
    expect(outcomeSortIndex('HOME_OR_AWAY')).toBeLessThan(outcomeSortIndex('DRAW_OR_AWAY'));
  });

  it('orders correct scores by total goals, then exact score', () => {
    const ordered = ['CS_2_1', 'CS_0_0', 'CS_1_1', 'CS_1_0'].sort(
      (a, b) => outcomeSortIndex(a) - outcomeSortIndex(b),
    );

    expect(ordered).toEqual(['CS_0_0', 'CS_1_0', 'CS_1_1', 'CS_2_1']);
  });

  it('keeps correct-score keys distinct', () => {
    const keys = [];
    for (let home = 0; home <= 9; home += 1) {
      for (let away = 0; away <= 9; away += 1) keys.push(`CS_${home}_${away}`);
    }

    const indexes = keys.map(outcomeSortIndex);
    expect(new Set(indexes).size).toBe(indexes.length);
    // And every one of them sorts before the unknown-outcome fallback.
    expect(Math.max(...indexes)).toBeLessThan(OUTCOME_ORDER_FALLBACK);
  });

  it('gives an unknown outcome the fallback, so provider order is kept', () => {
    expect(outcomeSortIndex('NAME_ARSENAL')).toBe(OUTCOME_ORDER_FALLBACK);
    expect(outcomeSortIndex('SOMETHING_NEW')).toBe(OUTCOME_ORDER_FALLBACK);
  });

  it('sorts a provider that sent home/away/draw into home/draw/away', () => {
    // Exactly the shape The Odds API returns for h2h: the bookmaker's own order.
    const asProviderSent = ['HOME', 'AWAY', 'DRAW'];
    const sorted = [...asProviderSent].sort((a, b) => outcomeSortIndex(a) - outcomeSortIndex(b));

    expect(sorted).toEqual(['HOME', 'DRAW', 'AWAY']);
  });
});

describe('display helpers', () => {
  it('labels periods', () => {
    expect(periodLabel('FT')).toBe('Full time');
    expect(periodLabel('H1')).toBe('1st half');
    expect(periodLabel('Q4')).toBe('4th quarter');
    expect(periodLabel('I3')).toBe('Innings 3');
    expect(periodLabel('X9')).toBe('X9');
  });

  it('builds a readable market name', () => {
    expect(
      marketDisplayName({ canonicalName: 'Over / Under', period: 'FT', line: 2.5, subject: null, lineType: 'total' }),
    ).toBe('Over / Under 2.5');

    expect(
      marketDisplayName({ canonicalName: 'Handicap', period: 'H1', line: -1.5, subject: null, lineType: 'spread' }),
    ).toBe('Handicap -1.5 (1st half)');

    expect(
      marketDisplayName({
        canonicalName: 'Points',
        period: 'FT',
        line: 25.5,
        subject: 'LeBron James',
        lineType: 'total',
      }),
    ).toBe('LeBron James Points 25.5');
  });

  it('humanises a canonical code', () => {
    expect(humaniseCode('PLAYER_POINTS')).toBe('Player Points');
    expect(humaniseCode('EXT_SOME_MARKET')).toBe('Ext Some Market');
  });
});
