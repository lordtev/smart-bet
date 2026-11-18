/**
 * Odds arithmetic and validation
 * ─────────────────────────────────────────────────────────────────────────────
 * One implementation of "is this price usable" for the whole engine. The
 * database's own floor is `odds >= 1.001`, so anything at or below 1.00 is
 * rejected here rather than discovered as a constraint violation mid-batch.
 *
 * Decimal is the canonical format. American and fractional are converted on the
 * way in, because storing mixed formats would make comparison meaningless.
 */

/** Smallest price the schema accepts (`selections.odds` / `odds_quotes.odds`). */
export const MIN_ODDS = 1.001;
/** Sanity ceiling: a decimal price above 1000 is a parsing accident, not a market. */
export const MAX_ODDS = 1000;
/** Storage resolution: numeric(10,3). */
export const ODDS_SCALE = 3;
/** Storage resolution of markets.line: numeric(8,2). */
export const LINE_SCALE = 2;

export type OddsFormat = 'decimal' | 'american' | 'fractional';

/**
 * Round half away from zero, matching PostgreSQL's `round(numeric, n)`.
 * `Math.round` rounds halves toward +∞ instead, which would make a stored line
 * and its canonical key disagree for negative quarter lines.
 */
export function roundHalfAwayFromZero(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return rounded / factor;
}

/**
 * Round a decimal price to the storage resolution.
 * Exported so change detection compares exactly what will be stored.
 */
export function roundOdds(value: number): number {
  return roundHalfAwayFromZero(value, ODDS_SCALE);
}

/** Round a line to the storage resolution of `markets.line`. */
export function roundLine(value: number): number {
  return roundHalfAwayFromZero(value, LINE_SCALE);
}

/** American → decimal. `-303` → 1.330, `+240` → 3.400. */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return Number.NaN;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

/** Fractional → decimal. `5/2` → 3.500. */
export function fractionalToDecimal(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return Number.NaN;
  return 1 + numerator / denominator;
}

/**
 * Convert whatever the provider sent into a decimal price, then validate it.
 * Returns `null` for anything unusable — callers count it and move on rather
 * than throwing, so one bad price cannot abort a fixture's whole payload.
 */
export function toDecimalOdds(value: unknown, format: OddsFormat): number | null {
  let numeric: number | null = null;

  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;

    // Fractional strings such as "5/2".
    const fraction = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
    if (fraction) {
      numeric = fractionalToDecimal(Number(fraction[1]), Number(fraction[2]));
      format = 'decimal'; // already converted
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return null;
      numeric = parsed;
    }
  } else {
    return null;
  }

  if (!Number.isFinite(numeric)) return null;

  let decimal = numeric;
  if (format === 'american') decimal = americanToDecimal(numeric);
  if (!Number.isFinite(decimal)) return null;

  return validateOdds(decimal);
}

/** Clamp-check a decimal price and round it to storage resolution. */
export function validateOdds(decimal: number): number | null {
  if (!Number.isFinite(decimal)) return null;
  const rounded = roundOdds(decimal);
  if (rounded < MIN_ODDS || rounded > MAX_ODDS) return null;
  return rounded;
}

/* ── Market status ───────────────────────────────────────────────────────── */

export type MarketStatus = 'open' | 'suspended' | 'closed';

/**
 * Provider status vocabulary → the engine's three states.
 *
 * Anything unrecognised is treated as `suspended`, never `open`: an unknown
 * state must not silently become bettable.
 */
export function normalizeMarketStatus(raw: unknown): MarketStatus {
  if (raw === null || raw === undefined) return 'open';
  const text = String(raw).trim().toLowerCase();

  if (text === '') return 'open';
  if (['open', 'active', 'trading', 'live', 'available', 'scheduled'].includes(text)) return 'open';
  if (['suspended', 'paused', 'halted', 'frozen', 'suspended_by_system'].includes(text)) return 'suspended';
  if (['closed', 'ended', 'finished', 'settled', 'void', 'cancelled', 'canceled', 'removed'].includes(text)) {
    return 'closed';
  }
  return 'suspended';
}

/* ── Fixture status ──────────────────────────────────────────────────────── */

export type EventStatus = 'scheduled' | 'live' | 'finished' | 'postponed' | 'cancelled' | 'abandoned';

export function normalizeEventStatus(raw: unknown, isLive: boolean): EventStatus {
  if (isLive) return 'live';
  if (raw === null || raw === undefined) return 'scheduled';

  const text = String(raw).trim().toLowerCase();
  if (text === '') return 'scheduled';
  if (['scheduled', 'upcoming', 'not_started', 'notstarted', 'prematch', 'pending'].includes(text)) {
    return 'scheduled';
  }
  if (['live', 'inplay', 'in_play', 'playing', 'started'].includes(text)) return 'live';
  if (['finished', 'ended', 'complete', 'completed', 'final'].includes(text)) return 'finished';
  if (['postponed', 'delayed'].includes(text)) return 'postponed';
  if (['cancelled', 'canceled', 'abandoned'].includes(text)) return 'cancelled';
  return 'scheduled';
}

/** Implied probability of a decimal price, used for sanity/overround reporting. */
export function impliedProbability(decimal: number): number {
  return decimal > 0 ? 1 / decimal : 0;
}

/** Sum of implied probabilities for one market: 1.00 is a fair book. */
export function overround(prices: readonly number[]): number {
  return prices.reduce((sum, price) => sum + impliedProbability(price), 0);
}
