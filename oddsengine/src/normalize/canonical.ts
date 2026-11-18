/**
 * Canonical identity
 * ───────────────────────────────────────────────────────────────────────────── * Everything that turns provider-specific text into a canonical, comparable
 * identifier lives here — and nowhere else. Two providers quoting the same
 * market must produce byte-identical strings, otherwise they never meet.
 *
 * ┌─ Canonical market key ─────────────────────────────────────────────────┐
 * │  <CANONICAL_CODE>|<PERIOD>|<LINE_KEY>|<SUBJECT_KEY>                    │
 * │                                                                        │
 * │  MATCH_WINNER|FT||            1X2 full time                            │
 * │  OVER_UNDER|FT|2.5|           total goals over/under 2.5               │
 * │  PLAYER_POINTS|FT|25.5|lebron_james   player prop for one player       │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * `lineKey()` MUST agree with the SQL function `odds_line_key()` in
 * supabase/migrations/20260101000700_odds_engine.sql. Both are pinned by tests:
 *   2.5 → '2.5'    3 → '3'    -1.25 → '-1.25'    0 → '0'
 *
 * Deliberately NOT merged, because their settlement rules differ:
 *   • different periods            (FT vs H1)              → period segment
 *   • different lines              (2.5 vs 3.5)            → line segment
 *   • different subject            (LeBron vs Curry)       → subject segment
 *   • back vs lay                  (h2h vs h2h_lay)        → different code
 */

import { roundHalfAwayFromZero } from './odds.ts';

/** Market status as providers express it, after adapter normalisation. */
export type CanonicalMarketStatus = 'open' | 'suspended' | 'closed';

export type LineType = 'none' | 'total' | 'spread' | 'handicap';

/* ── Text helpers ────────────────────────────────────────────────────────── */

/** Lowercase, strip diacritics, collapse anything non-alphanumeric to `_`. */
export function slug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

/**
 * Tokens clubs append and providers disagree about ("Arsenal" vs "Arsenal F.C.").
 * Stripped for participant matching only — never for display, and never for a
 * key that is stored.
 */
const CLUB_NOISE = new Set([
  'fc',
  'cf',
  'sc',
  'afc',
  'ac',
  'club',
  'sport',
  'sports',
  'sporting',
  'sportsclub',
  'the',
  'cd',
  'ud',
  'sv',
  'bk',
  'if',
  'fk',
]);

/** Team/participant name key used for matching, never for display. */
export function teamKey(input: string): string {
  return slug(input);
}

/**
 * Aggressive participant key for comparing the same club across providers:
 * "Manchester United F.C." → `manchester united`. Falls back to the plain slug
 * when a name is made entirely of noise tokens.
 */
export function participantKey(input: string): string {
  // Collapse initialisms first, so "F.C." becomes "fc" and is then recognised
  // as noise instead of splitting into two single-letter tokens.
  const normalized = input.replace(/(^|[^A-Za-z0-9])([A-Za-z])\./g, '$1$2');

  const tokens = slug(normalized).split('_').filter(Boolean);
  const withoutNoise = tokens.filter((token) => !CLUB_NOISE.has(token));
  const chosen = withoutNoise.length > 0 ? withoutNoise : tokens;
  return chosen.join(' ');
}

/**
 * Stable text for a numeric line. Mirrors the SQL helper `odds_line_key()`
 * exactly, and is computed from the value as it will be *stored*
 * (`markets.line` is numeric(8,2)), so the key cannot drift from the row.
 *
 * Rounding goes through the same half-away-from-zero helper as the database, so
 * a negative quarter line cannot round differently in the two places.
 */
export function lineKey(line: number | null | undefined): string {
  if (line === null || line === undefined || !Number.isFinite(line)) return '';

  const stored = roundHalfAwayFromZero(line, 2);
  const text = stored
    .toFixed(3)
    .replace(/0+$/, '')
    .replace(/\.$/, '');

  return text === '-0' ? '0' : text;
}

/* ── Periods ─────────────────────────────────────────────────────────────── */

/**
 * Provider market keys carry the period as a suffix. These are the only
 * suffixes treated as periods; anything else (for example `_corners`, `_cards`)
 * is part of the market family and stays put.
 *
 * The Odds API: `_h1`/`_h2`, `_q1`…`_q4`, `_p1`…`_p3`, `_s1`/`_s2` and
 * `_1st_N_innings` for baseball.
 */
const PERIOD_SUFFIXES: ReadonlyArray<{ pattern: RegExp; period: (m: RegExpMatchArray) => string }> = [
  { pattern: /^(.*)_h([12])$/, period: (m) => `H${m[2]}` },
  { pattern: /^(.*)_q([1-4])$/, period: (m) => `Q${m[2]}` },
  { pattern: /^(.*)_p([1-4])$/, period: (m) => `P${m[2]}` },
  { pattern: /^(.*)_s([1-2])$/, period: (m) => `S${m[2]}` },
  { pattern: /^(.*)_1st_([1-9])_innings$/, period: (m) => `I${m[2]}` },
];

export type ParsedMarketKey = {
  /** Original key, lowercased and trimmed. */
  raw: string;
  /** Key after period and `alternate` markers are removed. Used for rule lookup. */
  base: string;
  /** Canonical period: FT, H1, H2, Q1…Q4, P1…P4, S1, S2, I1…I9. */
  period: string;
  /** True when the key carried an `alternate` marker (extra lines, same market). */
  alternate: boolean;
};

/**
 * Split a provider market key into (base, period).
 *
 * `alternate_totals_q2` → base `totals`, period `Q2`, alternate true.
 * `player_points_alternate` → base `player_points`, period `FT`.
 * `totals_corners` → base `totals_corners`, period `FT` (nothing stripped).
 */
export function parseMarketKey(providerKey: string): ParsedMarketKey {
  const raw = providerKey.trim().toLowerCase();
  let working = raw;
  let period = 'FT';
  let alternate = false;

  for (const { pattern, period: toPeriod } of PERIOD_SUFFIXES) {
    const match = working.match(pattern);
    if (match) {
      period = toPeriod(match);
      working = match[1] ?? working;
      break;
    }
  }

  if (working.startsWith('alternate_')) {
    working = working.slice('alternate_'.length);
    alternate = true;
  }
  if (working.endsWith('_alternate')) {
    working = working.slice(0, -'_alternate'.length);
    alternate = true;
  }

  return { raw, base: working, period, alternate };
}

/* ── Keys ────────────────────────────────────────────────────────────────── */

export function canonicalMarketKey(input: {
  canonicalCode: string;
  period: string;
  line?: number | null;
  subject?: string | null;
}): string {
  const subject = input.subject ? slug(input.subject) : '';
  return [input.canonicalCode, input.period || 'FT', lineKey(input.line), subject].join('|');
}

/* ── Outcomes ────────────────────────────────────────────────────────────── */

/**
 * The canonical outcome vocabulary. Anything a provider names outside this list
 * still gets a stable, comparable key (`NAME_<slug>` / `CS_<home>_<away>`) so it
 * is stored rather than dropped — it simply is not yet aligned with another
 * provider's equivalent.
 */
const OUTCOME_VOCABULARY: Record<string, string> = {
  home: 'HOME',
  '1': 'HOME',
  draw: 'DRAW',
  x: 'DRAW',
  tie: 'DRAW',
  away: 'AWAY',
  '2': 'AWAY',
  over: 'OVER',
  under: 'UNDER',
  yes: 'YES',
  no: 'NO',
  'home or draw': 'HOME_OR_DRAW',
  '1x': 'HOME_OR_DRAW',
  'home or away': 'HOME_OR_AWAY',
  '12': 'HOME_OR_AWAY',
  'draw or away': 'DRAW_OR_AWAY',
  x2: 'DRAW_OR_AWAY',
};

/**
 * Labels that carry the line in the text: "Over 2.5", "Under 220.5",
 * "Yes 1st half". The line itself lives on the market, so only the prefix
 * matters for the outcome key.
 */
const OUTCOME_PREFIXES: ReadonlyArray<{ pattern: RegExp; key: string }> = [
  { pattern: /^over\b/, key: 'OVER' },
  { pattern: /^under\b/, key: 'UNDER' },
  { pattern: /^yes\b/, key: 'YES' },
  { pattern: /^no\b/, key: 'NO' },
];

/** `2-1` → `CS_2_1`. Correct-score markets name their outcomes this way. */
const CORRECT_SCORE = /^(\d{1,3})\s*[-:]\s*(\d{1,3})$/;

export type OutcomeKeyInput = {
  /** The outcome label exactly as the provider gave it. */
  name: string;
  marketCode: string;
  lineType: LineType;
  homeTeam: string | null;
  awayTeam: string | null;
  /** Provider-specific overrides from odds_market_rules.outcome_map. */
  outcomeMap?: Record<string, string> | null;
};

/**
 * Resolve one outcome to a canonical key.
 *
 * Order matters: an explicit rule wins, then the home/away match (most providers
 * name the participants rather than saying "Home"), then the shared vocabulary,
 * then a stable fallback so nothing is ever dropped.
 */
export function resolveOutcomeKey(input: OutcomeKeyInput): string {
  const raw = input.name.trim();
  const lower = raw.toLowerCase().replace(/\s+/g, ' ');

  if (input.outcomeMap) {
    const mapped = input.outcomeMap[raw] ?? input.outcomeMap[lower];
    if (mapped) return mapped.trim().toUpperCase();
  }

  const key = teamKey(raw);
  const participant = participantKey(raw);

  // Participant matching tolerates the club suffixes providers disagree about
  // ("Arsenal" in one feed, "Arsenal F.C." in another) — otherwise the same
  // outcome would get a different key from each provider and never line up.
  if (input.homeTeam && (key === teamKey(input.homeTeam) || participant === participantKey(input.homeTeam))) {
    return 'HOME';
  }
  if (input.awayTeam && (key === teamKey(input.awayTeam) || participant === participantKey(input.awayTeam))) {
    return 'AWAY';
  }

  const exact = OUTCOME_VOCABULARY[lower] ?? OUTCOME_VOCABULARY[key];
  if (exact) return exact;

  for (const { pattern, key: prefixKey } of OUTCOME_PREFIXES) {
    if (pattern.test(lower)) return prefixKey;
  }

  const score = raw.match(CORRECT_SCORE);
  if (score) return `CS_${score[1]}_${score[2]}`;

  // Participant-named outright markets (a futures "Winner" market) land here.
  return `NAME_${(key || 'unknown').toUpperCase()}`;
}

/* ── Display order ───────────────────────────────────────────────────────── */

/**
 * Canonical display order for an outcome inside its market.
 *
 * `selections.sort_order` is literally what the website sorts a market's buttons
 * by, so it has to come from canonical identity — never from the position the
 * provider happened to use in its payload. The Odds API returns `h2h` outcomes in
 * the bookmaker's own order (commonly home, away, draw), which put Away where
 * players expect Draw.
 *
 * Ties keep the provider's order, because JavaScript's sort is stable.
 */
const OUTCOME_ORDER: Record<string, number> = {
  // 1X2 / moneyline
  HOME: 0,
  DRAW: 1,
  AWAY: 2,
  // two-way markets, where there is no draw
  OVER: 0,
  UNDER: 1,
  YES: 0,
  NO: 1,
  // double chance
  HOME_OR_DRAW: 0,
  HOME_OR_AWAY: 1,
  DRAW_OR_AWAY: 2,
};

/**
 * Anything not in the vocabulary keeps provider order, after the known keys.
 *
 * Must stay above the correct-score range (100 … 1999 for 0-0 … 9-9) so the
 * ordering is total and a correct-score market never sorts past an unknown one.
 */
export const OUTCOME_ORDER_FALLBACK = 10_000;

/** `CS_2_1` → a sortable number, ordered by total goals then the exact score. */
const CORRECT_SCORE_KEY = /^CS_(\d{1,3})_(\d{1,3})$/;

export function outcomeSortIndex(outcomeKey: string): number {
  const known = OUTCOME_ORDER[outcomeKey];
  if (known !== undefined) return known;

  const score = CORRECT_SCORE_KEY.exec(outcomeKey);
  if (score) {
    const home = Number(score[1]);
    const away = Number(score[2]);
    // 100 … 1899, so correct-score markets sort below the fallback but above the
    // vocabulary — and stay distinct: the home*10+away term cannot overflow 99.
    return 100 + (home + away) * 100 + home * 10 + away;
  }

  return OUTCOME_ORDER_FALLBACK;
}

/* ── Market labels ───────────────────────────────────────────────────────── */

const PERIOD_LABEL: Record<string, string> = {
  FT: 'Full time',
  H1: '1st half',
  H2: '2nd half',
  Q1: '1st quarter',
  Q2: '2nd quarter',
  Q3: '3rd quarter',
  Q4: '4th quarter',
  P1: '1st period',
  P2: '2nd period',
  P3: '3rd period',
  P4: '4th period',
  S1: '1st set',
  S2: '2nd set',
};

/** Human label for a period, e.g. `H1` → `1st half`. */
export function periodLabel(period: string): string {
  if (PERIOD_LABEL[period]) return PERIOD_LABEL[period] as string;
  const innings = period.match(/^I(\d)$/);
  if (innings) return `Innings ${innings[1]}`;
  return period;
}

/**
 * Display name for a canonical market. Only used when the provider gives no
 * label of its own; the website renders `markets.name`.
 */
export function marketDisplayName(input: {
  canonicalName: string;
  period: string;
  line: number | null;
  subject: string | null;
  lineType: LineType;
}): string {
  const parts: string[] = [];
  if (input.subject) parts.push(input.subject);
  parts.push(input.canonicalName);

  if (input.line !== null && input.line !== undefined) {
    const signed = input.lineType === 'total' ? lineKey(input.line) : input.line > 0 ? `+${lineKey(input.line)}` : lineKey(input.line);
    parts.push(signed);
  }

  if (input.period !== 'FT') parts.push(`(${periodLabel(input.period)})`);
  return parts.join(' ');
}

/** `PLAYER_POINTS` → `Player Points`. Used for auto-created market types. */
export function humaniseCode(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
