/**
 * Provider initialisation.
 *
 * `init()` is where an adapter validates credentials and warms caches, and the
 * contract in `providers/types.ts` says a cycle must not start without it. This
 * was originally missed: only `doctor` called it, so The Odds API failed every
 * cycle with "adapter used before init()" while the mock — which does not need
 * `init` — worked fine and hid the problem entirely.
 *
 * These tests pin the behaviour that prevents a repeat: every provider is
 * initialised exactly once, a provider that fails is excluded rather than
 * retried forever, its failure is reported with the adapter's own message, and
 * one failing provider never stops the others.
 */
import { describe, expect, it, vi } from 'vitest';
import { initProviders } from '../../src/bootstrap.ts';
import { silentLogger } from '../../src/logging/logger.ts';
import type { AdapterContext, ProviderAdapter } from '../../src/providers/types.ts';

type FakeOptions = {
  key: string;
  failWith?: string;
  supportsLive?: boolean;
};

function fakeProvider(options: FakeOptions) {
  const init = vi.fn(async () => {
    if (options.failWith) throw new Error(options.failWith);
  });

  const provider: ProviderAdapter = {
    key: options.key,
    name: `Provider ${options.key}`,
    supportsLive: options.supportsLive ?? true,
    supportsPrematch: true,
    knownBookmakers: [],
    init,
    fetchFixtures: async () => [],
    getUsage: () => ({ quotaRemaining: null, quotaUsed: null, lastCost: null }),
    shutdown: async () => {},
  };

  return { provider, init };
}

function contextFor(): AdapterContext {
  return {
    log: silentLogger(),
    signal: new AbortController().signal,
    http: {
      request: async <T,>() => ({ status: 200, data: null as T, headers: {}, durationMs: 0 }),
    },
    now: () => new Date('2026-09-26T18:00:00.000Z'),
  };
}

describe('initProviders', () => {
  it('initialises every provider exactly once', async () => {
    const a = fakeProvider({ key: 'a' });
    const b = fakeProvider({ key: 'b' });

    const result = await initProviders({
      providers: [a.provider, b.provider],
      contextFor,
      log: silentLogger(),
    });

    expect(a.init).toHaveBeenCalledTimes(1);
    expect(b.init).toHaveBeenCalledTimes(1);
    expect(result.ready.map((provider) => provider.key)).toEqual(['a', 'b']);
    expect(result.failed).toEqual([]);
  });

  it('excludes a provider that cannot initialise, and keeps its own message', async () => {
    const good = fakeProvider({ key: 'mock' });
    const bad = fakeProvider({
      key: 'the-odds-api',
      failWith: 'The Odds API is enabled but THE_ODDS_API_KEY is empty.',
    });

    const result = await initProviders({
      providers: [good.provider, bad.provider],
      contextFor,
      log: silentLogger(),
    });

    expect(result.ready.map((provider) => provider.key)).toEqual(['mock']);
    expect(result.failed).toEqual([
      { key: 'the-odds-api', error: 'The Odds API is enabled but THE_ODDS_API_KEY is empty.' },
    ]);
  });

  it('keeps going when one provider fails — the others are unaffected', async () => {
    const providers = [
      fakeProvider({ key: 'one' }),
      fakeProvider({ key: 'two', failWith: 'boom' }),
      fakeProvider({ key: 'three' }),
    ];

    const result = await initProviders({
      providers: providers.map((entry) => entry.provider),
      contextFor,
      log: silentLogger(),
    });

    expect(result.ready.map((provider) => provider.key)).toEqual(['one', 'three']);
    expect(result.failed).toHaveLength(1);
    // All three were still attempted; a failure did not short-circuit the list.
    for (const entry of providers) expect(entry.init).toHaveBeenCalledTimes(1);
  });

  it('reports every failing provider, not just the first', async () => {
    const result = await initProviders({
      providers: [
        fakeProvider({ key: 'a', failWith: 'no key' }).provider,
        fakeProvider({ key: 'b', failWith: 'host unreachable' }).provider,
      ],
      contextFor,
      log: silentLogger(),
    });

    expect(result.ready).toEqual([]);
    expect(result.failed.map((entry) => entry.key)).toEqual(['a', 'b']);
  });

  it('builds a context per provider', async () => {
    const seen: string[] = [];
    const providers = [fakeProvider({ key: 'a' }), fakeProvider({ key: 'b' })];

    await initProviders({
      providers: providers.map((entry) => entry.provider),
      contextFor: (provider) => {
        seen.push(provider.key);
        return contextFor();
      },
      log: silentLogger(),
    });

    expect(seen).toEqual(['a', 'b']);
  });

  it('handles an empty provider list without failing', async () => {
    const result = await initProviders({ providers: [], contextFor, log: silentLogger() });
    expect(result.ready).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('turns a non-Error rejection into a readable message', async () => {
    const provider: ProviderAdapter = {
      ...fakeProvider({ key: 'weird' }).provider,
      init: async () => {
        // Some libraries reject with a string or a plain object.
        throw 'plain string failure';
      },
    };

    const result = await initProviders({ providers: [provider], contextFor, log: silentLogger() });

    expect(result.failed).toEqual([{ key: 'weird', error: 'plain string failure' }]);
  });
});
