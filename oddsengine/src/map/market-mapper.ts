/**
 * Market mapping
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns a provider's markets into canonical markets. This is the only place
 * that decides "what market is this, really", and it is entirely driven by data
 * (rows in `odds_market_rules`) rather than by provider-specific code paths.
 *
 * Three things it guarantees:
 *
 *  1. NOTHING IS SILENTLY DROPPED. A market with no rule is reported to the
 *     caller, which records it for review. Depending on configuration it is
 *     either stored under a derived canonical code (`EXT_…`, review_status
 *     'auto') or skipped and left in the queue as 'pending'.
 *
 *  2. DIFFERENT THINGS ARE NEVER MERGED. Period, line and subject are all part
 *     of the canonical key, so `Over 2.5` and `Over 3.5`, `1st half 1X2` and
 *     full-time 1X2, and LeBron's points prop and Curry's points prop are four
 *     different markets that can never collapse into one.
 *
 *  3. ONE PROVIDER MARKET MAY BECOME MANY. Alternate-line and player-prop
 *     payloads return several lines (and several players) in a single market.
 *     They are split here, which is why `canonicalKey` is not the provider key.
 */

import {
  canonicalMarketKey,
  humaniseCode,
  lineKey,
  marketDisplayName,
  outcomeSortIndex,
  parseMarketKey,
  resolveOutcomeKey,
  slug,
  teamKey,
  type LineType,
} from '../normalize/canonical.ts';
import { roundLine, toDecimalOdds, validateOdds, type MarketStatus, type OddsFormat } from '../normalize/odds.ts';
import type { NormalizedBook, NormalizedFixture, NormalizedMarket } from '../providers/types.ts';

/* ── Rule model (mirrors the odds_market_rules table) ────────────────────── */

export type RuleReviewStatus = 'mapped' | 'auto' | 'pending' | 'ignored';

export type MarketRule = {
  /** Provider market key. May contain a trailing `*` to act as a prefix rule. */
  providerKey: string;
  /** NULL only while the rule is still in review. */
  canonicalCode: string | null;
  /** Canonical display name of that code (joined from market_types). */
  canonicalName: string | null;
  period: string;
  lineType: LineType;
  outcomeMap: Record<string, string> | null;
  reviewStatus: RuleReviewStatus;
};

/** Where rules come from. The engine passes a database-backed source; tests pass a literal one. */
export type MarketRuleSource = {
  /** All rules for a provider, keyed by provider market key. */
  listRules: (providerKey: string) => Promise<MarketRule[]>;
  /**
   * Record a provider market key that has no rule, so it appears in the review
   * queue. When the engine fell back to a derived code, that code is stored too,
   * so an operator can see exactly what is in use and replace it with a curated
   * mapping later.
   */
  recordUnknownMarket: (input: {
    providerKey: string;
    providerMarketKey: string;
    derivedCanonicalCode: string | null;
    autoMapped: boolean;
    sample: unknown;
  }) => Promise<void>;
};

/* ── Output model ────────────────────────────────────────────────────────── */

export type CanonicalOutcome = {
  outcomeKey: string;
  /** Display label sent to `selections.name`. */
  name: string;
  sourceKey: string;
  price: number;
  status: MarketStatus;
};

export type CanonicalMarket = {
  /** `<CODE>|<PERIOD>|<LINE>|<SUBJECT>` — the `markets.canonical_key`. */
  canonicalKey: string;
  canonicalCode: string;
  canonicalName: string;
  period: string;
  line: number | null;
  subject: string | null;
  /** Display name for `markets.name`. */
  name: string;
  status: MarketStatus;
  providerUpdatedAt: string | null;
  /** Which provider market this came from, for traceability. */
  sourceMarketKey: string;
  outcomes: CanonicalOutcome[];
};

export type MappedBook = {
  bookmakerKey: string;
  bookmakerTitle: string;
  markets: CanonicalMarket[];
};

export type MappedFixture = {
  sourceEventKey: string;
  markets: MappedBook[];
  /** Canonical market types the caller must ensure exist before writing. */
  requiredMarketTypes: Map<string, string>;
  stats: MappingStats;
};

export type MappingStats = {
  providerMarkets: number;
  canonicalMarkets: number;
  outcomesIn: number;
  outcomesOut: number;
  rejectedPrices: number;
  unknownMarkets: string[];
  ignoredMarkets: string[];
  duplicateOutcomes: number;
};

export type MapperOptions = {
  /** Odds format the provider's prices are in. */
  oddsFormat?: OddsFormat;
  /** Store unmapped markets under a derived code instead of skipping them. */
  autoMapUnknownMarkets?: boolean;
  /** Review status given to fields' derived rules. */
  autoReviewStatus?: RuleReviewStatus;
};

/* ── Rule index ──────────────────────────────────────────────────────────── */

export type RuleIndex = {
  exact: Map<string, MarketRule>;
  patterns: Array<{ prefix: string; rule: MarketRule }>;
};

export function buildRuleIndex(rules: readonly MarketRule[]): RuleIndex {
  const exact = new Map<string, MarketRule>();
  const patterns: Array<{ prefix: string; rule: MarketRule }> = [];

  for (const rule of rules) {
    const key = rule.providerKey.trim().toLowerCase();
    if (key.endsWith('*')) {
      patterns.push({ prefix: key.slice(0, -1), rule });
    } else {
      exact.set(key, rule);
    }
  }

  // Longest prefix first so `player_points_alternate*` beats `player_*`.
  patterns.sort((a, b) => b.prefix.length - a.prefix.length);
  return { exact, patterns };
}

/** Expand a rule's `%` placeholder with the part matched by its `*`. */
function expandCode(rule: MarketRule, baseKey: string): string {
  if (!rule.canonicalCode) return '';
  if (!rule.canonicalCode.includes('%')) return rule.canonicalCode;

  const ruleKey = rule.providerKey.trim().toLowerCase();
  const star = ruleKey.indexOf('*');
  const remainder = star >= 0 ? baseKey.slice(ruleKey.slice(0, star).length) : '';
  const code = remainder ? slug(remainder).toUpperCase() : 'OTHER';
  return rule.canonicalCode.replace('%', code);
}

export function findRule(index: RuleIndex, baseKey: string): MarketRule | null {
  const direct = index.exact.get(baseKey);
  if (direct) return direct;

  for (const { prefix, rule } of index.patterns) {
    if (baseKey.startsWith(prefix)) return rule;
  }
  return null;
}

/* ── Mapping ─────────────────────────────────────────────────────────────── */

type OutcomeGroup = {
  line: number | null;
  subject: string | null;
  subjectLabel: string | null;
  outcomes: NormalizedMarket['outcomes'];
};

/**
 * Split a provider market into (line, subject) groups.
 *
 * - `none` → one group.
 * - `total` (over/under) → one group per line and subject. Both sides of a total
 *   share the same point, so the point is the line.
 * - `spread` / `handicap` → the two sides carry OPPOSITE points (+1.5 / −1.5),
 *   so they are grouped by the absolute point and the canonical line is taken
 *   from the HOME side. Without this, "Arsenal −1.5" and "Chelsea +1.5" would be
 *   split into two half-markets instead of one handicap market.
 * - `subject` comes from `outcome.description` only: a market that names players
 *   in the outcome label (rather than in `description`) is one market.
 */
function groupOutcomes(
  market: NormalizedMarket,
  lineType: LineType,
  homeTeam: string | null,
  awayTeam: string | null,
): OutcomeGroup[] {
  if (lineType === 'none') {
    return [{ line: null, subject: null, subjectLabel: null, outcomes: market.outcomes }];
  }

  const mirrored = lineType === 'spread' || lineType === 'handicap';
  const groups = new Map<string, { subject: string | null; subjectLabel: string | null; outcomes: NormalizedMarket['outcomes'] }>();

  for (const outcome of market.outcomes) {
    const rawPoint =
      outcome.point === null || outcome.point === undefined || !Number.isFinite(outcome.point)
        ? null
        : roundLine(outcome.point);

    const subjectLabel = outcome.description?.trim() ? outcome.description.trim() : null;
    const subject = subjectLabel ? slug(subjectLabel) : null;
    const magnitude = rawPoint === null ? '' : lineKey(Math.abs(rawPoint));
    const groupKey = `${magnitude}#${subject ?? ''}`;

    const existing = groups.get(groupKey);
    if (existing) {
      existing.outcomes.push(outcome);
    } else {
      groups.set(groupKey, { subject, subjectLabel, outcomes: [outcome] });
    }
  }

  return [...groups.values()].map((group) => {
    if (!mirrored) {
      const point =
        group.outcomes[0]?.point === null || group.outcomes[0]?.point === undefined
          ? null
          : roundLine(group.outcomes[0]!.point);
      return { line: point, ...group };
    }

    // Spread: express the line from the home side's perspective.
    const home = homeTeam ? teamKey(homeTeam) : null;
    const away = awayTeam ? teamKey(awayTeam) : null;

    const homeOutcome = group.outcomes.find((outcome) => home !== null && teamKey(outcome.name) === home);
    const awayOutcome = group.outcomes.find((outcome) => away !== null && teamKey(outcome.name) === away);

    const source = homeOutcome ?? awayOutcome ?? group.outcomes[0];
    const point =
      source?.point === null || source?.point === undefined ? null : roundLine(source.point);

    return { line: point, ...group };
  });
}

/** Best-guess rule for a market nobody has mapped yet. */
function derivedRule(parsed: ReturnType<typeof parseMarketKey>, market: NormalizedMarket): MarketRule {
  const hasLine = market.outcomes.some(
    (o) => o.point !== null && o.point !== undefined && Number.isFinite(o.point),
  );

  const code = `EXT_${slug(parsed.base).toUpperCase() || 'UNKNOWN'}`;

  return {
    providerKey: parsed.base,
    canonicalCode: code,
    canonicalName: humaniseCode(code),
    period: parsed.period,
    lineType: hasLine ? 'total' : 'none',
    outcomeMap: null,
    reviewStatus: 'auto',
  };
}

export type MapFixtureInput = {
  fixture: NormalizedFixture;
  /** Rule lookup for the provider these markets came from. */
  ruleSource: MarketRuleSource;
  /** Provider key, used when recording unknown markets. */
  providerKey: string;
  options?: MapperOptions;
};

/**
 * Map one fixture's provider markets into canonical markets.
 *
 * Never throws for provider data reasons: unusable prices are counted and
 * skipped, unknown markets are reported. Errors only escape if the rule source
 * itself fails, because then nothing downstream can be trusted.
 */
export async function mapFixture(input: MapFixtureInput): Promise<MappedFixture> {
  const { fixture, ruleSource, providerKey } = input;
  const options = input.options ?? {};
  const oddsFormat = options.oddsFormat ?? 'decimal';
  const autoMap = options.autoMapUnknownMarkets ?? true;

  const rules = await ruleSource.listRules(providerKey);
  const index = buildRuleIndex(rules);

  const stats: MappingStats = {
    providerMarkets: 0,
    canonicalMarkets: 0,
    outcomesIn: 0,
    outcomesOut: 0,
    rejectedPrices: 0,
    unknownMarkets: [],
    ignoredMarkets: [],
    duplicateOutcomes: 0,
  };

  const requiredMarketTypes = new Map<string, string>();
  const unknownSeen = new Map<string, NormalizedMarket>();
  const books: MappedBook[] = [];

  for (const book of fixture.books) {
    const mapped = mapBook({
      book,
      fixture,
      index,
      oddsFormat,
      autoMap,
      stats,
      requiredMarketTypes,
      unknownSeen,
    });
    if (mapped.markets.length > 0) books.push(mapped);
  }

  // Report every distinct unknown market once per fixture, not once per book.
  // Storing the derived code (when the engine fell back to one) means the very
  // next cycle finds a rule instead of re-deriving, and an operator can see in
  // the table exactly what is in use before replacing it with a curated mapping.
  for (const [base, market] of unknownSeen) {
    const derived = derivedRule(parseMarketKey(market.sourceKey), market);
    const derivedCode = autoMap ? derived.canonicalCode : null;

    if (derivedCode) {
      requiredMarketTypes.set(derivedCode, derived.canonicalName ?? humaniseCode(derivedCode));
    }

    await ruleSource.recordUnknownMarket({
      providerKey,
      providerMarketKey: base,
      derivedCanonicalCode: derivedCode,
      autoMapped: autoMap,
      sample: { sourceKey: market.sourceKey, outcomeNames: market.outcomes.slice(0, 5).map((o) => o.name) },
    });
    stats.unknownMarkets.push(base);
  }

  stats.canonicalMarkets = books.reduce((sum, b) => sum + b.markets.length, 0);

  return { sourceEventKey: fixture.sourceEventKey, markets: books, requiredMarketTypes, stats };
}

type MapBookInput = {
  book: NormalizedBook;
  fixture: NormalizedFixture;
  index: RuleIndex;
  oddsFormat: OddsFormat;
  autoMap: boolean;
  stats: MappingStats;
  requiredMarketTypes: Map<string, string>;
  unknownSeen: Map<string, NormalizedMarket>;
};

function mapBook(input: MapBookInput): MappedBook {
  const { book, fixture, index, oddsFormat, autoMap, stats, requiredMarketTypes, unknownSeen } = input;

  const markets: CanonicalMarket[] = [];
  const byKey = new Map<string, CanonicalMarket>();

  for (const market of book.markets) {
    stats.providerMarkets += 1;
    stats.outcomesIn += market.outcomes.length;

    if (market.outcomes.length === 0) continue;

    const parsed = parseMarketKey(market.sourceKey);
    let rule = findRule(index, parsed.base);

    if (!rule) {
      if (!unknownSeen.has(parsed.base)) unknownSeen.set(parsed.base, market);
      if (!autoMap) continue;
      rule = derivedRule(parsed, market);
      requiredMarketTypes.set(rule.canonicalCode as string, rule.canonicalName ?? humaniseCode(rule.canonicalCode as string));
    }

    if (rule.reviewStatus === 'ignored') {
      stats.ignoredMarkets.push(parsed.base);
      continue;
    }
    if (!rule.canonicalCode) {
      // A rule still in review: keep the provider market in the queue, do not guess.
      if (!unknownSeen.has(parsed.base)) unknownSeen.set(parsed.base, market);
      continue;
    }

    // The market key's own period wins when it carries one: `totals_h1` is
    // first-half whatever the family rule's default says.
    const period = parsed.period !== 'FT' ? parsed.period : rule.period;
    const canonicalCode = expandCode(rule, parsed.base);
    if (!canonicalCode) continue;

    if (!requiredMarketTypes.has(canonicalCode)) {
      requiredMarketTypes.set(canonicalCode, rule.canonicalName ?? humaniseCode(canonicalCode));
    }

    const groups = groupOutcomes(market, rule.lineType, fixture.homeTeam, fixture.awayTeam);
    const occurredAt = market.updatedAt;

    for (const group of groups) {
      const canonicalKey = canonicalMarketKey({
        canonicalCode,
        period,
        line: group.line,
        subject: group.subject,
      });

      const outcomes: CanonicalOutcome[] = [];
      const seenOutcomes = new Set<string>();

      for (const outcome of group.outcomes) {
        const price = toDecimalOdds(outcome.price, oddsFormat);
        if (price === null) {
          stats.rejectedPrices += 1;
          continue;
        }

        // Provider quirks: a suspended individual outcome is a real state.
        const outcomeStatus: MarketStatus =
          outcome.status === 'suspended' ? 'suspended' : outcome.status === 'closed' ? 'closed' : market.status;

        if (outcomeStatus === 'closed') continue;

        const outcomeKey = resolveOutcomeKey({
          name: outcome.name,
          marketCode: canonicalCode,
          lineType: rule.lineType,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          outcomeMap: rule.outcomeMap,
        });

        if (seenOutcomes.has(outcomeKey)) {
          stats.duplicateOutcomes += 1;
          continue;
        }
        seenOutcomes.add(outcomeKey);

        outcomes.push({
          outcomeKey,
          // A player prop reads better with the player's name in it.
          name:
            group.subjectLabel && /^(over|under)$/i.test(outcome.name.trim())
              ? `${outcome.name.trim()} ${group.line !== null ? lineKey(group.line) : ''}`.trim()
              : outcome.name.trim(),
          sourceKey: outcome.sourceKey,
          price,
          status: outcomeStatus,
        });
      }

      if (outcomes.length === 0) continue;

      // Display order comes from canonical identity, not from the order the
      // provider used. `sort_order` is derived from this array's indices, and it
      // is what the website sorts the market's buttons by — so a feed that
      // returns home/away/draw must still render home/draw/away. The sort is
      // stable, so unknown outcomes keep the provider's order.
      outcomes.sort((a, b) => outcomeSortIndex(a.outcomeKey) - outcomeSortIndex(b.outcomeKey));

      const displayName = marketDisplayName({
        canonicalName: rule.canonicalName ?? humaniseCode(canonicalCode),
        period,
        line: group.line,
        subject: group.subjectLabel,
        lineType: rule.lineType,
      });

      const existing = byKey.get(canonicalKey);
      if (existing) {
        // Two provider markets (e.g. `totals` and `alternate_totals`) can address
        // the same canonical market. Merge, keeping the first price seen so the
        // payload cannot silently overwrite a line with a different source.
        for (const outcome of outcomes) {
          if (!existing.outcomes.some((o) => o.outcomeKey === outcome.outcomeKey)) {
            existing.outcomes.push(outcome);
          } else {
            stats.duplicateOutcomes += 1;
          }
        }
        continue;
      }

      const canonical: CanonicalMarket = {
        canonicalKey,
        canonicalCode,
        canonicalName: rule.canonicalName ?? humaniseCode(canonicalCode),
        period,
        line: group.line,
        subject: group.subjectLabel,
        name: displayName,
        status: market.status,
        providerUpdatedAt: occurredAt ? new Date(occurredAt).toISOString() : null,
        sourceMarketKey: market.sourceKey,
        outcomes,
      };

      byKey.set(canonicalKey, canonical);
      markets.push(canonical);
      stats.outcomesOut += outcomes.length;
    }
  }

  return { bookmakerKey: book.bookmakerKey, bookmakerTitle: book.bookmakerTitle, markets };
}

/**
 * Validate a provider price without converting, for adapters that already emit
 * decimal (used by the mock provider and by tests).
 */
export function ensureDecimal(price: number): number {
  const validated = validateOdds(price);
  if (validated === null) throw new RangeError(`price ${price} is outside the storable range`);
  return validated;
}
