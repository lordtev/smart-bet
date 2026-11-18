/**
 * Mock provider
 * ─────────────────────────────────────────────────────────────────────────────
 * A complete provider that talks to nothing. It exists so the whole pipeline —
 * fetching, matching, mapping, change detection, history, publishing, health —
 * can be developed and tested without an API key, without a network, and
 * without spending a single credit.
 *
 * It is deliberately awkward in the ways real providers are awkward, because
 * that is what tests need to cover:
 *
 *   • prices move between cycles (so change detection has something to detect);
 *   • some markets go temporarily suspended and come back;
 *   • a configurable percentage of markets disappears from a payload entirely —
 *     the "incomplete response" case, which must never be read as "these markets
 *     were removed";
 *   • prices carry both a 1X2 and multiple total lines, and one first-half
 *     market, so the period and line dimensions of the canonical key are
 *     exercised;
 *   • an optional failure mode makes every fetch throw, to prove that a provider
 *     outage changes nothing about the existing odds.
 *
 * Determinism: every price is a pure function of (fixture key, market key,
 * cycle number, seed). Two runs with the same cycle number produce byte-identical
 * output, which is what makes the tests reproducible.
 */

import type {
  AdapterContext,
  FetchWindow,
  NormalizedFixture,
  NormalizedMarket,
  NormalizedOutcome,
  ProviderAdapter,
  ProviderUsage,
} from './types.ts';

export type MockProviderOptions = {
  /** Fixtures produced per cycle. */
  fixtureCount?: number;
  /** Markets offered per fixture, from the known list below. */
  marketsPerFixture?: number;
  /** How far a price may drift from its base value, in percent. */
  jitterPct?: number;
  /** Percentage of markets that go suspended in a given cycle. */
  seedChangePct?: number;
  /** Percentage of markets that vanish from a payload entirely. */
  omitMarketsPct?: number;
  /** Deterministic seed. */
  seed?: number;
  /** Which cycle this is. Drives price movement. Defaults to an internal counter. */
  cycle?: number;
  /** Make every fetch throw, to simulate an outage. */
  failAlways?: false | 'network' | 'auth' | 'quota';
  /** Number of bookmakers to emit. More than one exercises per-bookmaker isolation. */
  bookmakers?: string[];
  /**
   * When set, `subscribe()` pushes a fresh payload on this interval instead of
   * waiting to be polled. Used to prove the push path end to end.
   */
  pushIntervalMs?: number;
  /** Make `subscribe()` fail, to prove the worker falls back to polling. */
  failPush?: boolean;
  /** Injectable clock. */
  now?: () => Date;
};

/** Deterministic PRNG. Small, fast and good enough for fake odds. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(input: string): number {
  let value = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

const TEAMS: ReadonlyArray<readonly [string, string]> = [
  ['Mock United', 'Mock Rovers'],
  ['Kampala City', 'Entebbe Stars'],
  ['North Harbour', 'South Vale'],
  ['Riverside Athletic', 'Hilltop Town'],
  ['East End FC', 'West Gate FC'],
  ['Lakeview Rangers', 'Greenfield Albion'],
  ['Old Mill Town', 'New Bridge City'],
  ['Stonebridge', 'Fernhill'],
];

/** Market templates the mock publishes. Keys match the seeded odds_market_rules. */
const MOCK_MARKETS: ReadonlyArray<{ key: string; label: string }> = [
  { key: '1X2', label: '1X2' },
  { key: 'OVER_UNDER_2_5', label: 'Total goals 2.5' },
  { key: 'BTTS', label: 'Both teams to score' },
  { key: 'OVER_UNDER_1_5', label: 'Total goals 1.5' },
  { key: '1X2_1H', label: '1X2 (1st half)' },
  { key: 'DOUBLE_CHANCE', label: 'Double chance' },
];

type OutcomeSpec = { name: string; base: number; point?: number };

const MARKET_OUTCOMES: Record<string, OutcomeSpec[]> = {
  '1X2': [
    { name: 'Home', base: 2.1 },
    { name: 'Draw', base: 3.4 },
    { name: 'Away', base: 3.3 },
  ],
  OVER_UNDER_2_5: [
    { name: 'Over', base: 1.95, point: 2.5 },
    { name: 'Under', base: 1.88, point: 2.5 },
  ],
  OVER_UNDER_1_5: [
    { name: 'Over', base: 1.35, point: 1.5 },
    { name: 'Under', base: 3.2, point: 1.5 },
  ],
  BTTS: [
    { name: 'Yes', base: 1.82 },
    { name: 'No', base: 1.95 },
  ],
  '1X2_1H': [
    { name: 'Home', base: 2.8 },
    { name: 'Draw', base: 2.05 },
    { name: 'Away', base: 4.1 },
  ],
  DOUBLE_CHANCE: [
    { name: 'Home or Draw', base: 1.32 },
    { name: 'Home or Away', base: 1.28 },
    { name: 'Draw or Away', base: 1.55 },
  ],
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function floorToHour(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

export type MockProvider = ProviderAdapter & {
  /** Force the next cycle number (tests use this to compare identical payloads). */
  setCycle: (cycle: number) => void;
  /** Number of fetch calls made since creation. */
  callCount: () => number;
};

export function createMockProvider(options: MockProviderOptions = {}): MockProvider {
  const fixtureCount = options.fixtureCount ?? 6;
  const marketsPerFixture = Math.min(options.marketsPerFixture ?? 5, MOCK_MARKETS.length);
  const jitterPct = options.jitterPct ?? 3;
  const seedChangePct = options.seedChangePct ?? 0;
  const omitMarketsPct = options.omitMarketsPct ?? 0;
  const seed = options.seed ?? 1337;
  const bookmakers = options.bookmakers ?? ['default'];
  const now = options.now ?? (() => new Date());

  let cycle = options.cycle ?? 0;
  let calls = 0;
  let usage: ProviderUsage = { quotaRemaining: null, quotaUsed: null, lastCost: null };

  const buildMarket = (
    fixtureKey: string,
    marketKey: string,
    bookmaker: string,
    isLive: boolean,
    homeTeam: string,
    awayTeam: string,
  ): NormalizedMarket | null => {
    const specs = MARKET_OUTCOMES[marketKey];
    if (!specs) return null;

    const random = mulberry32(hash(`${seed}:${fixtureKey}:${marketKey}:${bookmaker}:${cycle}`));

    // Suspensions: deterministic per market and cycle, so a test can assert that
    // a suspended market is not treated as a removed one.
    const suspendRoll = random();
    const suspended = seedChangePct > 0 && suspendRoll * 100 < seedChangePct;

    // Omissions: the market is missing from this payload entirely.
    const omitRoll = random();
    if (omitMarketsPct > 0 && omitRoll * 100 < omitMarketsPct) return null;

    const outcomes: NormalizedOutcome[] = specs.map((spec) => {
      const drift = (random() - 0.5) * 2 * (jitterPct / 100);
      // Live markets drift more, as they would in reality.
      const scale = isLive ? 1 + drift * 2 : 1 + drift;
      const price = round3(Math.max(1.01, Math.min(50, spec.base * scale)));

      // Providers name participants in 1X2/winner markets; the engine maps
      // those names back to HOME/AWAY, which is what this exercises.
      const name = marketKey.startsWith('1X2') ? (spec.name === 'Home' ? homeTeam : spec.name === 'Away' ? awayTeam : 'Draw') : spec.name;

      return {
        sourceKey: `${marketKey}:${spec.name}`,
        name,
        description: null,
        price,
        point: spec.point ?? null,
        status: suspended ? 'suspended' : 'open',
      };
    });

    return {
      sourceKey: marketKey,
      name: MOCK_MARKETS.find((market) => market.key === marketKey)?.label ?? marketKey,
      status: suspended ? 'suspended' : 'open',
      // A fresh provider timestamp each cycle is what a real feed does.
      updatedAt: new Date(now().getTime() - Math.floor(random() * 5_000)).toISOString(),
      outcomes,
    };
  };

  const buildFixture = (index: number, mode: 'live' | 'prematch'): NormalizedFixture => {
    const [homeTeam, awayTeam] = TEAMS[index % TEAMS.length] as readonly [string, string];
    const kickoffHour = floorToHour(now());

    const commence =
      mode === 'live'
        ? new Date(kickoffHour.getTime() - 30 * 60_000 + index * 10 * 60_000)
        : new Date(kickoffHour.getTime() + 2 * 3_600_000 + index * 90 * 60_000);

    const fixtureKey = `mock-${mode}-${index}`;
    const markets = MOCK_MARKETS.slice(0, marketsPerFixture);

    const books = bookmakers
      .map((bookmaker) => ({
        bookmakerKey: bookmaker,
        bookmakerTitle: bookmaker === 'default' ? 'Mock Book' : `Mock Book ${bookmaker}`,
        markets: markets
          .map((market) => buildMarket(fixtureKey, market.key, bookmaker, mode === 'live', homeTeam, awayTeam))
          .filter((market): market is NormalizedMarket => market !== null),
      }))
      // A real feed never includes a bookmaker that prices nothing, so neither
      // does this one — it keeps "incomplete response" payloads realistic.
      .filter((book) => book.markets.length > 0);

    return {
      sourceEventKey: fixtureKey,
      sportName: 'Football',
      sportKey: 'mock_football',
      competitionTitle: 'Mock League',
      countryCode: 'UG',
      homeTeam,
      awayTeam,
      name: `${homeTeam} vs ${awayTeam}`,
      commenceTime: commence.toISOString(),
      isLive: mode === 'live',
      homeScore: mode === 'live' ? index % 3 : null,
      awayScore: mode === 'live' ? (index + 1) % 3 : null,
      minute: mode === 'live' ? 30 + index * 5 : null,
      books,
    };
  };

  const adapter: MockProvider = {
    key: 'mock',
    name: 'Mock provider (development)',
    supportsLive: true,
    supportsPrematch: true,
    knownBookmakers: bookmakers,

    async init(ctx: AdapterContext) {
      if (options.failAlways === 'auth') {
        throw new Error('mock provider configured to fail: auth');
      }
      ctx.log.info('mock provider ready', {
        fixtures: fixtureCount,
        marketsPerFixture,
        jitterPct,
        seedChangePct,
        omitMarketsPct,
        bookmakers,
      });
    },

    async fetchFixtures(window: FetchWindow, ctx: AdapterContext): Promise<NormalizedFixture[]> {
      calls += 1;

      if (options.failAlways === 'network') {
        throw new Error('mock provider configured to fail: network');
      }
      if (options.failAlways === 'quota') {
        usage = { quotaRemaining: 0, quotaUsed: 999, lastCost: 1 };
        throw new Error('mock provider configured to fail: quota exhausted');
      }

      const fixtures = Array.from({ length: fixtureCount }, (_, index) => buildFixture(index, window.mode));

      const withinWindow = fixtures.filter((fixture) => {
        const start = Date.parse(fixture.commenceTime);
        return start >= window.from.getTime() && start <= window.to.getTime();
      });

      usage = { quotaRemaining: null, quotaUsed: calls, lastCost: 0 };

      ctx.log.debug('mock payload', {
        mode: window.mode,
        cycle,
        fixtures: withinWindow.length,
        markets: withinWindow.reduce(
          (sum, fixture) => sum + fixture.books.reduce((inner, book) => inner + book.markets.length, 0),
          0,
        ),
      });

      // Advance the cycle so the next call produces moved prices.
      cycle += 1;

      return withinWindow.slice(0, window.limit);
    },

    getUsage: () => usage,

    /**
     * Push delivery, so the WebSocket/webhook path is exercised by a real
     * adapter rather than only by a test double. A real provider would open a
     * socket here and call `onFixtures` per message; this one puts a whole
     * cycle's payload on a timer.
     */
    async subscribe(handlers, ctx) {
      if (options.failPush) {
        throw new Error('mock provider configured to fail: push subscription');
      }

      let alive = true;
      const pushIntervalMs = options.pushIntervalMs ?? 1_000;

      const tick = (): void => {
        if (!alive || ctx.signal.aborted) return;

        const window: FetchWindow = {
          mode: 'live',
          from: new Date(now().getTime() - 240 * 60_000),
          to: now(),
          limit: 100,
        };

        // Deliberately reuse the same builder a poll would use, so pushed and
        // polled payloads are indistinguishable downstream.
        const fixtures = Array.from({ length: fixtureCount }, (_, index) => buildFixture(index, window.mode));

        try {
          void handlers.onFixtures(fixtures, { receivedAt: now(), label: 'mock-push' });
        } catch (error) {
          handlers.onError(error instanceof Error ? error : new Error(String(error)), { fatal: false });
        }
      };

      const timer = setInterval(tick, pushIntervalMs);
      timer.unref?.();
      // Emit once immediately so a test does not have to wait a full interval.
      tick();

      ctx.log.info('mock push stream open', { pushIntervalMs });

      return {
        kind: 'mock-websocket',
        active: () => alive,
        async stop() {
          alive = false;
          clearInterval(timer);
          ctx.log.info('mock push stream closed');
        },
      };
    },

    async shutdown() {
      /* nothing to release */
    },

    setCycle(next: number) {
      cycle = next;
    },

    callCount: () => calls,
  };

  return adapter;
}
