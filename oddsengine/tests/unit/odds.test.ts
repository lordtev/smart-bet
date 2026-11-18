/**
 * Odds arithmetic and validation: the boundary between "a number the provider
 * sent" and "a price the database will accept".
 */
import { describe, expect, it } from 'vitest';
import {
  americanToDecimal,
  fractionalToDecimal,
  impliedProbability,
  normalizeEventStatus,
  normalizeMarketStatus,
  overround,
  roundHalfAwayFromZero,
  roundLine,
  roundOdds,
  toDecimalOdds,
  validateOdds,
  MAX_ODDS,
  MIN_ODDS,
} from '../../src/normalize/odds.ts';

describe('conversion', () => {
  it('converts American odds', () => {
    expect(americanToDecimal(-303)).toBeCloseTo(1.33, 2);
    expect(americanToDecimal(240)).toBeCloseTo(3.4, 2);
    expect(americanToDecimal(-100)).toBeCloseTo(2, 5);
    expect(americanToDecimal(100)).toBeCloseTo(2, 5);
  });

  it('rejects American zero', () => {
    expect(Number.isNaN(americanToDecimal(0))).toBe(true);
  });

  it('converts fractional odds', () => {
    expect(fractionalToDecimal(5, 2)).toBeCloseTo(3.5, 5);
    expect(fractionalToDecimal(1, 3)).toBeCloseTo(1.3333, 3);
  });
});

describe('toDecimalOdds', () => {
  it('passes decimal numbers through, rounded to 3dp', () => {
    expect(toDecimalOdds(2.5, 'decimal')).toBe(2.5);
    expect(toDecimalOdds(3.456789, 'decimal')).toBe(3.457);
  });

  it('accepts numeric strings', () => {
    expect(toDecimalOdds('2.05', 'decimal')).toBe(2.05);
  });

  it('parses fractional strings whatever the declared format', () => {
    expect(toDecimalOdds('5/2', 'decimal')).toBe(3.5);
  });

  it('converts American input', () => {
    expect(toDecimalOdds(-200, 'american')).toBe(1.5);
    expect(toDecimalOdds('+150', 'american')).toBe(2.5);
  });

  it('rejects anything unusable instead of throwing', () => {
    expect(toDecimalOdds(null, 'decimal')).toBeNull();
    expect(toDecimalOdds(undefined, 'decimal')).toBeNull();
    expect(toDecimalOdds('', 'decimal')).toBeNull();
    expect(toDecimalOdds('not a price', 'decimal')).toBeNull();
    expect(toDecimalOdds(Number.NaN, 'decimal')).toBeNull();
    expect(toDecimalOdds({ price: 2 }, 'decimal')).toBeNull();
  });

  it('enforces the database floor and ceiling', () => {
    // `selections.odds` has CHECK (odds >= 1.001): a provider sending exactly
    // 1.00 must be rejected here, not discovered as a constraint violation.
    expect(toDecimalOdds(1.0, 'decimal')).toBeNull();
    expect(toDecimalOdds(0.9999, 'decimal')).toBeNull();
    // 1.0009 rounds to the storable 1.001, so it is accepted and clamped up.
    expect(toDecimalOdds(1.0009, 'decimal')).toBe(1.001);
    expect(toDecimalOdds(1.001, 'decimal')).toBe(1.001);
    expect(toDecimalOdds(MAX_ODDS + 1, 'decimal')).toBeNull();
    expect(toDecimalOdds(0, 'decimal')).toBeNull();
    expect(toDecimalOdds(-2.5, 'decimal')).toBeNull();
  });
});

describe('validateOdds', () => {
  it('accepts the documented range', () => {
    expect(validateOdds(MIN_ODDS)).toBe(1.001);
    expect(validateOdds(2)).toBe(2);
    expect(validateOdds(MAX_ODDS)).toBe(MAX_ODDS);
  });
});

describe('rounding', () => {
  it('rounds odds to 3dp and lines to 2dp', () => {
    expect(roundOdds(2.0005)).toBe(2.001);
    expect(roundLine(2.375)).toBe(2.38);
  });

  it('rounds half away from zero, matching PostgreSQL', () => {
    // Math.round(-112.5) is -112, PostgreSQL round(-1.125, 2) is -1.13.
    expect(roundLine(-1.125)).toBe(-1.13);
    expect(roundHalfAwayFromZero(-1.125, 2)).toBe(-1.13);
    expect(roundHalfAwayFromZero(1.125, 2)).toBe(1.13);
  });
});

describe('normalizeMarketStatus', () => {
  it.each([
    ['open', 'open'],
    ['ACTIVE', 'open'],
    ['trading', 'open'],
    ['suspended', 'suspended'],
    ['FROZEN', 'suspended'],
    ['closed', 'closed'],
    ['settled', 'closed'],
    ['cancelled', 'closed'],
  ])('%s â†’ %s', (raw, expected) => {
    expect(normalizeMarketStatus(raw)).toBe(expected);
  });

  it('treats a missing status as open (providers omit it when trading)', () => {
    expect(normalizeMarketStatus(undefined)).toBe('open');
    expect(normalizeMarketStatus(null)).toBe('open');
  });

  it('treats an unknown status as suspended, never open', () => {
    // An unrecognised state must never silently become bettable.
    expect(normalizeMarketStatus('some-new-state')).toBe('suspended');
  });
});

describe('normalizeEventStatus', () => {
  it('trusts the live flag above any string', () => {
    expect(normalizeEventStatus('finished', true)).toBe('live');
  });

  it('maps the usual vocabulary', () => {
    expect(normalizeEventStatus('upcoming', false)).toBe('scheduled');
    expect(normalizeEventStatus('in_play', false)).toBe('live');
    expect(normalizeEventStatus('FINISHED', false)).toBe('finished');
    expect(normalizeEventStatus('postponed', false)).toBe('postponed');
    expect(normalizeEventStatus('canceled', false)).toBe('cancelled');
  });

  it('defaults to scheduled when nothing is known', () => {
    expect(normalizeEventStatus(undefined, false)).toBe('scheduled');
  });
});

describe('book maths', () => {
  it('computes implied probability and overround', () => {
    expect(impliedProbability(2)).toBeCloseTo(0.5, 6);
    expect(overround([2, 4, 4])).toBeCloseTo(1, 6);
    expect(overround([1.9, 1.9])).toBeGreaterThan(1);
  });
});
