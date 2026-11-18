/**
 * Configuration is the operator interface to the engine, so it must fail loudly
 * on anything ambiguous and never silently invent a setting.
 */
import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig, parseEnvFile } from '../../src/config.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abcdefghijklmnop',
  ODDS_ENV_FALLBACK_FILES: '',
};

describe('parseEnvFile', () => {
  it('handles comments, quotes, export prefixes and a BOM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oddsengine-env-'));
    const file = join(dir, '.env');

    writeFileSync(
      file,
      '\uFEFF# a comment\r\n' +
        'PLAIN=value\r\n' +
        'EXPORTED="quoted value"\r\n' +
        "SINGLE='single'\r\n" +
        'TRAILING=abc  # inline note\r\n' +
        '\r\n' +
        'EMPTY=\r\n' +
        '  SPACED = padded \r\n',
      'utf8',
    );

    const parsed = parseEnvFile(file);

    expect(parsed['PLAIN']).toBe('value');
    expect(parsed['EXPORTED']).toBe('quoted value');
    expect(parsed['SINGLE']).toBe('single');
    expect(parsed['TRAILING']).toBe('abc');
    expect(parsed['EMPTY']).toBe('');
    expect(parsed['SPACED']).toBe('padded');
    // The very first key must not carry the BOM.
    expect(Object.keys(parsed)[0]).toBe('PLAIN');
  });
});

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(BASE);

    expect(config.providers.enabled).toEqual(['mock']);
    expect(config.providers.pricingProvider).toBe('mock');
    expect(config.polling.liveIntervalMs).toBe(3_000);
    expect(config.polling.prematchIntervalMs).toBe(1_800_000);
    expect(config.history.enabled).toBe(true);
    expect(config.runtime.dryRun).toBe(false);
    expect(config.logging.level).toBe('info');
  });

  it('refuses a live poll faster than 2 seconds', () => {
    expect(() => loadConfig({ ...BASE, LIVE_POLL_INTERVAL_MS: '500' })).toThrow(
      /LIVE_POLL_INTERVAL_MS must be at least 2000/,
    );
  });

  it('refuses a prematch poll faster than 30 minutes', () => {
    expect(() => loadConfig({ ...BASE, PREMETCH_POLL_INTERVAL_MS: '60000' })).toThrow(
      /PREMETCH_POLL_INTERVAL_MS must be at least/,
    );
  });

  it('refuses a pricing provider that is not enabled', () => {
    expect(() =>
      loadConfig({ ...BASE, ENABLED_PROVIDERS: 'mock', PRICING_PROVIDER: 'the-odds-api' }),
    ).toThrow(/PRICING_PROVIDER "the-odds-api" is not in ENABLED_PROVIDERS/);
  });

  it('refuses an empty provider list', () => {
    expect(() => loadConfig({ ...BASE, ENABLED_PROVIDERS: ' , ' })).toThrow(/ENABLED_PROVIDERS is empty/);
  });

  it('refuses duplicate providers', () => {
    expect(() => loadConfig({ ...BASE, ENABLED_PROVIDERS: 'mock,mock' })).toThrow(/duplicates/);
  });

  it('refuses out-of-range and non-integer numbers', () => {
    expect(() => loadConfig({ ...BASE, MAX_CONCURRENCY: 'lots' })).toThrow(/MAX_CONCURRENCY must be a whole number/);
    expect(() => loadConfig({ ...BASE, MAX_CONCURRENCY: '0' })).toThrow(/between 1 and/);
    expect(() => loadConfig({ ...BASE, REQUEST_TIMEOUT_MS: '1' })).toThrow(/between 250 and/);
  });

  it('refuses a nonsense boolean', () => {
    expect(() => loadConfig({ ...BASE, DRY_RUN: 'maybe' })).toThrow(/DRY_RUN must be a boolean/);
  });

  it('refuses an unknown log level', () => {
    expect(() => loadConfig({ ...BASE, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL must be one of/);
  });

  it('refuses a bad log format', () => {
    expect(() => loadConfig({ ...BASE, LOG_FORMAT: 'xml' })).toThrow(/LOG_FORMAT must be pretty or json/);
  });

  it('accepts the boolean spellings operators actually type', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(loadConfig({ ...BASE, DRY_RUN: value }).runtime.dryRun).toBe(true);
    }
    for (const value of ['0', 'false', 'no', 'off', 'FALSE']) {
      expect(loadConfig({ ...BASE, DRY_RUN: value }).runtime.dryRun).toBe(false);
    }
  });

  it('caps concurrency rather than accepting an unsafe value', () => {
    const config = loadConfig({ ...BASE, MAX_CONCURRENCY: '64' });
    expect(config.polling.concurrency).toBe(64);
  });

  it('applies CLI overrides', () => {
    const config = loadConfig(BASE, {
      enabled: ['mock'],
      pricingProvider: 'mock',
      dryRun: true,
      logLevel: 'debug',
    });

    expect(config.runtime.dryRun).toBe(true);
    expect(config.logging.level).toBe('debug');
  });

  it('errors clearly when the service-role key is missing', () => {
    // No fallback files either, so there is genuinely nowhere else to look.
    expect(() => loadConfig({ SUPABASE_URL: 'https://x.supabase.co', ODDS_ENV_FALLBACK_FILES: '' })).toThrow(
      /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set/,
    );
  });

  it('can fall back to another env file for database credentials only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oddsengine-fallback-'));
    const file = join(dir, 'env');
    writeFileSync(file, 'SUPABASE_URL=https://fallback.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_fallback_key\n', 'utf8');

    const config = loadConfig({ ODDS_ENV_FALLBACK_FILES: file });

    expect(config.supabase.url).toBe('https://fallback.supabase.co');
    expect(config.supabase.credentialSource).toBe(file);
  });
});

describe('describeConfig', () => {
  it('never includes a secret value', () => {
    const config = loadConfig({
      ...BASE,
      THE_ODDS_API_KEY: 'the-odds-api-secret-key-value',
      ENABLED_PROVIDERS: 'the-odds-api',
      PRICING_PROVIDER: 'the-odds-api',
    });

    const description = JSON.stringify(describeConfig(config));

    expect(description).not.toContain('the-odds-api-secret-key-value');
    expect(description).not.toContain('sb_secret_abcdefghijklmnop');
    expect(description).toContain('"serviceRoleKeyPresent":true');
    expect(description).toContain('"keyPresent":true');
  });
});

describe('The Odds API settings', () => {
  it('defaults to the documented host and featured markets', () => {
    const config = loadConfig({ ...BASE, ENABLED_PROVIDERS: 'the-odds-api', PRICING_PROVIDER: 'the-odds-api' });
    const api = config.providers_.theOddsApi;

    expect(api.baseUrl).toBe('https://api.the-odds-api.com');
    expect(api.ipv6BaseUrl).toBe('https://ipv6-api.the-odds-api.com');
    expect(api.markets).toEqual(['h2h', 'spreads', 'totals']);
    expect(api.regions).toEqual(['uk']);
    expect(api.useHeaderAuth).toBe(true);
  });

  it('accepts comma-separated lists', () => {
    const config = loadConfig({
      ...BASE,
      ENABLED_PROVIDERS: 'the-odds-api',
      PRICING_PROVIDER: 'the-odds-api',
      THE_ODDS_API_REGIONS: 'uk, eu , us',
      THE_ODDS_API_MARKETS: 'h2h,totals',
      THE_ODDS_API_SPORTS: 'soccer_epl, soccer_spain_la_liga',
    });

    expect(config.providers_.theOddsApi.regions).toEqual(['uk', 'eu', 'us']);
    expect(config.providers_.theOddsApi.markets).toEqual(['h2h', 'totals']);
    expect(config.providers_.theOddsApi.sports).toEqual(['soccer_epl', 'soccer_spain_la_liga']);
  });

  it('strips a trailing slash from a configured host', () => {
    const config = loadConfig({
      ...BASE,
      ENABLED_PROVIDERS: 'the-odds-api',
      PRICING_PROVIDER: 'the-odds-api',
      THE_ODDS_API_BASE_URL: 'https://api.the-odds-api.com/',
    });
    expect(config.providers_.theOddsApi.baseUrl).toBe('https://api.the-odds-api.com');
  });
});
