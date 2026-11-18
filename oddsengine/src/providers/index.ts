/**
 * Provider registry
 * ─────────────────────────────────────────────────────────────────────────────
 * The list of providers the engine knows how to run, and the only place that has
 * to change when a new one is added.
 *
 * To add provider C later:
 *   1. create `src/providers/<key>/adapter.ts` returning a `ProviderAdapter`;
 *   2. add one entry to `PROVIDER_FACTORIES` below;
 *   3. add its credentials to `.env.example` and `.env`;
 *   4. put `<key>` in ENABLED_PROVIDERS.
 *
 * Nothing else in the engine changes: providers are discovered by key, their
 * quotes are isolated by `source_id`, and their markets are mapped through data
 * in `odds_market_rules` rather than through code.
 */

import type { Config } from '../config.ts';
import { createMockProvider, type MockProviderOptions } from './mock.ts';
import { createTheOddsApiProvider } from './the-odds-api/adapter.ts';
import type { ProviderAdapter } from './types.ts';

export type ProviderFactory = (config: Config) => ProviderAdapter;

/** Provider keys the engine can instantiate. */
export const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  mock: (config) => {
    const mockConfig = (config as Config & { providers_?: { mock?: MockProviderOptions } }).providers_?.mock;
    return createMockProvider(mockConfig ?? {});
  },

  'the-odds-api': (config) =>
    createTheOddsApiProvider({
      config: config.providers_.theOddsApi,
      includeOutrights: config.mapping.includeOutrights,
      sportKeys: config.providers_.theOddsApi.sports,
    }),
};

export function knownProviderKeys(): string[] {
  return Object.keys(PROVIDER_FACTORIES).sort();
}

/**
 * Instantiate the providers named in ENABLED_PROVIDERS.
 *
 * When ODDS_MOCK_MODE is on, every real provider is replaced by the mock: that
 * is the switch that guarantees a local run or a test suite can never spend a
 * provider credit. Disabled providers are simply never constructed, so their
 * credentials are never touched.
 */
export function createEnabledProviders(config: Config): ProviderAdapter[] {
  const requested = config.providers.enabled;

  const unknown = requested.filter((key) => !(key in PROVIDER_FACTORIES));
  if (unknown.length > 0) {
    throw new Error(
      `unknown provider(s) in ENABLED_PROVIDERS: ${unknown.join(', ')}. ` +
        `Known providers: ${knownProviderKeys().join(', ')}`,
    );
  }

  if (config.providers.mockMode) {
    return [createMockProvider({})];
  }

  return requested.map((key) => {
    const factory = PROVIDER_FACTORIES[key] as ProviderFactory;
    return factory(config);
  });
}
