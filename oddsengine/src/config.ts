/**
 * Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything the engine can be told to do lives here, and it all comes from the
 * environment. Nothing is hard-coded per provider: adding a provider adds a
 * provider module and a few env values, never an edit to this file's logic.
 *
 * Design rules:
 *  - Fail loudly and early. A bad value stops the process with a message that
 *    names the variable, instead of silently falling back to something the
 *    operator did not ask for.
 *  - Never log a secret. `describeConfig()` is what gets logged, and it only
 *    reports whether a key is present, never its value.
 *  - Keep the safety valves (minimum poll interval, maximum concurrency)
 *    non-negotiable so a misconfiguration cannot hammer a provider.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'pretty' | 'json';
export type WorkerMode = 'live' | 'prematch';

/** Hard floors. A provider gets hammered if these are ignored, so they are not configurable. */
const MIN_LIVE_POLL_MS = 2_000;
const MIN_PREMETCH_POLL_MS = 30 * 60 * 1_000;
const MAX_CONCURRENCY_CEILING = 64;

export type TheOddsApiConfig = {
  apiKey: string | null;
  baseUrl: string;
  ipv6BaseUrl: string;
  useIpv6: boolean;
  useHeaderAuth: boolean;
  regions: string[];
  markets: string[];
  sports: string[];
  bookmakers: string[];
  minQuota: number;
  /**
   * Hard ceiling on credits one cycle may spend across all its sport requests.
   * 0 = no ceiling.
   *
   * This is the guard that makes "ingest everything" survivable: an empty sport
   * list means every in-season sport (~70), and at 3 credits each the 3-second
   * live poll would drain a plan in about a minute. With a ceiling, a cycle takes
   * as many sports as the budget allows and stops.
   */
  maxCreditsPerCycle: number;
};

export type Config = {
  supabase: {
    url: string;
    serviceRoleKey: string;
    /** Where the credentials were found (path or 'environment'). Never a secret. */
    credentialSource: string;
  };
  providers: {
    enabled: string[];
    pricingProvider: string;
    pricingBookmaker: string | null;
    mockMode: boolean;
  };
  polling: {
    liveIntervalMs: number;
    prematchIntervalMs: number;
    liveLookaheadMinutes: number;
    prematchLookaheadMinutes: number;
    liveMaxFixtures: number;
    prematchMaxFixtures: number;
    /** Clamp applied when MAX_CONCURRENCY exceeds the ceiling. */
    concurrency: number;
  };
  push: {
    /**
     * Prefer a provider's WebSocket/webhook stream when it offers one.
     * Providers without a stream are polled exactly as before.
     */
    enabled: boolean;
    /** How long pushed payloads are coalesced before a single ingest. */
    debounceMs: number;
    /**
     * How often a push-enabled worker still polls, as a safety net. Streams drop
     * and webhooks get lost, so push never fully replaces reconciliation.
     * 0 disables the reconciliation poll entirely.
     */
    reconcileIntervalMs: number;
  };
  http: {
    timeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    rateLimitPerMinute: number;
    writeBatchSize: number;
  };
  changeDetection: {
    heartbeatSeconds: number;
    staleAfterSeconds: number;
    publishMaxStalenessSeconds: number;
  };
  history: {
    enabled: boolean;
  };
  mapping: {
    autoMapUnknownMarkets: boolean;
    autoCreateMarketTypes: boolean;
    includeOutrights: boolean;
    fixtureMatchWindowHours: number;
  };
  logging: {
    level: LogLevel;
    format: LogFormat;
  };
  runtime: {
    dryRun: boolean;
    shutdownGraceMs: number;
  };
  providers_: {
    theOddsApi: TheOddsApiConfig;
  };
};

/* ── Tiny .env reader ────────────────────────────────────────────────────── */
/**
 * Hand-rolled on purpose: no dependency, tolerant of a UTF-8 BOM, CRLF, `export`
 * prefixes, quoted values and `#` comments — the four things that break a
 * naively parsed .env.
 */
export function parseEnvFile(path: string): Record<string, string> {
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const out: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Unquoted values may carry a trailing comment: FOO=bar  # note
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

/* ── Typed accessors ─────────────────────────────────────────────────────── */

class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

type Env = Record<string, string | undefined>;

function readString(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function readOptionalString(env: Env, key: string): string | null {
  const v = env[key];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;

  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new EnvError(`${key} must be a whole number (got "${raw}")`);
  }
  if (n < min || n > max) {
    throw new EnvError(`${key} must be between ${min} and ${max} (got ${n})`);
  }
  return n;
}

function readBool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;

  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new EnvError(`${key} must be a boolean such as true/false (got "${raw}")`);
}

function readList(env: Env, key: string, fallback: string[]): string[] {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Like `readList`, but an explicitly empty value means "nothing".
 *
 * This is what lets `ODDS_ENV_FALLBACK_FILES=` disable the local-dev fallback:
 * an unset variable keeps the documented default, while `= ""` is an explicit
 * instruction to stop looking elsewhere for credentials.
 */
function readListAllowingEmpty(env: Env, key: string, fallback: string[]): string[] {
  const raw = env[key];
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readLogLevel(env: Env): LogLevel {
  const raw = readString(env, 'LOG_LEVEL', 'info').trim().toLowerCase();
  const allowed: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
  if (!allowed.includes(raw as LogLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of ${allowed.join(', ')} (got "${raw}")`);
  }
  return raw as LogLevel;
}

function readLogFormat(env: Env): LogFormat {
  const raw = readString(env, 'LOG_FORMAT', 'pretty').trim().toLowerCase();
  if (raw !== 'pretty' && raw !== 'json') {
    throw new EnvError(`LOG_FORMAT must be pretty or json (got "${raw}")`);
  }
  return raw;
}

/* ── The engine's own .env file ──────────────────────────────────────────── */

/** Files read from `oddsengine/`, in order. Later entries win. */
const ENGINE_ENV_FILES = ['.env', '.env.local'] as const;

/**
 * Read `oddsengine/.env` (and `.env.local`), if present.
 *
 * This exists so `node src/cli/main.ts …` behaves exactly like the npm scripts,
 * which additionally pass `--env-file-if-exists=.env`. Relying on that flag was a
 * trap: the documented commands did not load the file, so a provider key placed
 * in `oddsengine/.env` was silently invisible and the adapter reported an empty
 * key. Loading it here makes both invocation styles work.
 *
 * Real environment variables still win, so a container or CI that exports values
 * overrides the file.
 */
export function loadEngineEnvFiles(): { env: Record<string, string>; files: string[] } {
  const env: Record<string, string> = {};
  const files: string[] = [];

  for (const name of ENGINE_ENV_FILES) {
    const path = resolve(ENGINE_ROOT, name);
    if (!existsSync(path)) continue;
    Object.assign(env, parseEnvFile(path));
    files.push(path);
  }

  return { env, files };
}

/**
 * The environment the CLI should use: `oddsengine/.env`, overlaid by the real
 * process environment.
 */
export function resolveProcessEnv(base: Env = process.env): { env: Env; files: string[] } {
  const { env: fileEnv, files } = loadEngineEnvFiles();

  // A file value must not shadow a real environment variable.
  const merged: Env = { ...fileEnv };
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) merged[key] = value;
  }

  return { env: merged, files };
}

/* ── Supabase credentials, with a documented local-dev fallback ───────────── */

function resolveSupabaseCredentials(env: Env): Config['supabase'] {
  const url = readOptionalString(env, 'SUPABASE_URL');
  const key = readOptionalString(env, 'SUPABASE_SERVICE_ROLE_KEY');
  if (url && key) {
    return { url, serviceRoleKey: key, credentialSource: 'environment / oddsengine/.env' };
  }

  const fallbackFiles = readListAllowingEmpty(env, 'ODDS_ENV_FALLBACK_FILES', ['../.env']);
  if (fallbackFiles.length === 0) {
    throw new EnvError(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in oddsengine/.env ' +
        '(ODDS_ENV_FALLBACK_FILES is empty, so there is nowhere else to look).',
    );
  }

  for (const relative of fallbackFiles) {
    const path = isAbsolute(relative) ? relative : resolve(ENGINE_ROOT, relative);
    if (!existsSync(path)) continue;

    const fileEnv = parseEnvFile(path);
    const fUrl = readOptionalString(fileEnv, 'SUPABASE_URL');
    const fKey = readOptionalString(fileEnv, 'SUPABASE_SERVICE_ROLE_KEY');
    if (fUrl && fKey) {
      return { url: fUrl, serviceRoleKey: fKey, credentialSource: path };
    }
  }

  throw new EnvError(
    'No Supabase credentials found. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in ' +
      'oddsengine/.env, or make sure ODDS_ENV_FALLBACK_FILES points at a file that has them.',
  );
}

/* ── Assembly ────────────────────────────────────────────────────────────── */

/**
 * @param env   Process environment (injected in tests).
 * @param overrides Optional per-run overrides from the CLI, e.g. --provider=mock.
 */
export function loadConfig(
  env: Env = process.env,
  overrides: Partial<Pick<Config['providers'], 'enabled' | 'pricingProvider' | 'pricingBookmaker'>> & {
    dryRun?: boolean;
    logLevel?: LogLevel;
  } = {},
): Config {
  const supabase = resolveSupabaseCredentials(env);

  // Providers -----------------------------------------------------------------
  const enabled = (overrides.enabled ?? readList(env, 'ENABLED_PROVIDERS', ['mock']))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (enabled.length === 0) {
    throw new EnvError('ENABLED_PROVIDERS is empty — enable at least one provider (for example "mock")');
  }
  if (new Set(enabled).size !== enabled.length) {
    throw new EnvError(`ENABLED_PROVIDERS contains duplicates: ${enabled.join(', ')}`);
  }

  const mockMode = readBool(env, 'ODDS_MOCK_MODE', false);

  const pricingProvider = (
    overrides.pricingProvider ??
    readString(env, 'PRICING_PROVIDER', enabled[0] as string)
  )
    .trim()
    .toLowerCase();

  if (!enabled.includes(pricingProvider)) {
    throw new EnvError(
      `PRICING_PROVIDER "${pricingProvider}" is not in ENABLED_PROVIDERS (${enabled.join(', ')}). ` +
        'The pricing source must be enabled, otherwise nothing would be published.',
    );
  }

  let pricingBookmaker = overrides.pricingBookmaker ?? readOptionalString(env, 'PRICING_BOOKMAKER');
  if (pricingBookmaker !== null && pricingBookmaker.trim() === '') pricingBookmaker = null;

  // Polling -------------------------------------------------------------------
  const liveRaw = readInt(env, 'LIVE_POLL_INTERVAL_MS', 3_000, 0, 3_600_000);
  const prematchRaw = readInt(env, 'PREMETCH_POLL_INTERVAL_MS', 1_800_000, 0, 86_400_000);

  if (liveRaw !== 0 && liveRaw < MIN_LIVE_POLL_MS) {
    throw new EnvError(
      `LIVE_POLL_INTERVAL_MS must be at least ${MIN_LIVE_POLL_MS} ms — polling faster than a ` +
        `provider refreshes does not make odds fresher, it only burns quota (got ${liveRaw})`,
    );
  }
  if (prematchRaw !== 0 && prematchRaw < MIN_PREMETCH_POLL_MS) {
    throw new EnvError(
      `PREMETCH_POLL_INTERVAL_MS must be at least ${MIN_PREMETCH_POLL_MS} ms (30 minutes) (got ${prematchRaw})`,
    );
  }

  const requestedConcurrency = readInt(env, 'MAX_CONCURRENCY', 8, 1, MAX_CONCURRENCY_CEILING);

  // Providers: The Odds API ----------------------------------------------------
  const theOddsApi: TheOddsApiConfig = {
    apiKey: readOptionalString(env, 'THE_ODDS_API_KEY'),
    baseUrl: readString(env, 'THE_ODDS_API_BASE_URL', 'https://api.the-odds-api.com').replace(/\/+$/, ''),
    ipv6BaseUrl: readString(env, 'THE_ODDS_API_IPV6_BASE_URL', 'https://ipv6-api.the-odds-api.com').replace(
      /\/+$/,
      '',
    ),
    useIpv6: readBool(env, 'THE_ODDS_API_USE_IPV6', false),
    useHeaderAuth: readBool(env, 'THE_ODDS_API_USE_HEADER_AUTH', true),
    regions: readList(env, 'THE_ODDS_API_REGIONS', ['uk']),
    markets: readList(env, 'THE_ODDS_API_MARKETS', ['h2h', 'spreads', 'totals']),
    sports: readList(env, 'THE_ODDS_API_SPORTS', []),
    bookmakers: readList(env, 'THE_ODDS_API_BOOKMAKERS', []),
    minQuota: readInt(env, 'THE_ODDS_API_MIN_QUOTA', 25, 0, 10_000_000),
    maxCreditsPerCycle: readInt(env, 'THE_ODDS_API_MAX_CREDITS_PER_CYCLE', 0, 0, 1_000_000),
  };

  return {
    supabase,
    providers: { enabled, pricingProvider, pricingBookmaker, mockMode },
    polling: {
      liveIntervalMs: liveRaw,
      prematchIntervalMs: prematchRaw,
      liveLookaheadMinutes: readInt(env, 'LIVE_LOOKAHEAD_MINUTES', 240, 1, 43_200),
      prematchLookaheadMinutes: readInt(env, 'PREMETCH_LOOKAHEAD_MINUTES', 10_080, 1, 129_600),
      liveMaxFixtures: readInt(env, 'LIVE_MAX_FIXTURES', 400, 1, 100_000),
      prematchMaxFixtures: readInt(env, 'PREMETCH_MAX_FIXTURES', 1_200, 1, 100_000),
      concurrency: Math.min(requestedConcurrency, MAX_CONCURRENCY_CEILING),
    },
    push: {
      enabled: readBool(env, 'PROVIDER_PUSH_ENABLED', false),
      debounceMs: readInt(env, 'PUSH_DEBOUNCE_MS', 250, 0, 60_000),
      reconcileIntervalMs: readInt(env, 'PUSH_RECONCILE_INTERVAL_MS', 60_000, 0, 3_600_000),
    },
    http: {
      timeoutMs: readInt(env, 'REQUEST_TIMEOUT_MS', 8_000, 250, 120_000),
      maxRetries: readInt(env, 'MAX_RETRIES', 3, 0, 10),
      retryBaseDelayMs: readInt(env, 'RETRY_BASE_DELAY_MS', 500, 10, 60_000),
      retryMaxDelayMs: readInt(env, 'RETRY_MAX_DELAY_MS', 15_000, 10, 300_000),
      rateLimitPerMinute: readInt(env, 'RATE_LIMIT_REQUESTS_PER_MINUTE', 120, 0, 6_000),
      writeBatchSize: readInt(env, 'WRITE_BATCH_SIZE', 500, 1, 5_000),
    },
    changeDetection: {
      heartbeatSeconds: readInt(env, 'QUOTE_HEARTBEAT_SECONDS', 15, 0, 3_600),
      staleAfterSeconds: readInt(env, 'STALE_AFTER_SECONDS', 180, 5, 86_400),
      publishMaxStalenessSeconds: readInt(env, 'PUBLISH_MAX_STALENESS_SECONDS', 0, 0, 86_400),
    },
    history: { enabled: readBool(env, 'ODDS_HISTORY_ENABLED', true) },
    mapping: {
      autoMapUnknownMarkets: readBool(env, 'AUTO_MAP_UNKNOWN_MARKETS', true),
      autoCreateMarketTypes: readBool(env, 'AUTO_CREATE_MARKET_TYPES', true),
      includeOutrights: readBool(env, 'INCLUDE_OUTRIGHTS', false),
      fixtureMatchWindowHours: readInt(env, 'FIXTURE_MATCH_WINDOW_HOURS', 36, 1, 720),
    },
    logging: {
      level: overrides.logLevel ?? readLogLevel(env),
      format: readLogFormat(env),
    },
    runtime: {
      dryRun: overrides.dryRun ?? readBool(env, 'DRY_RUN', false),
      shutdownGraceMs: readInt(env, 'SHUTDOWN_GRACE_MS', 10_000, 0, 120_000),
    },
    providers_: { theOddsApi },
  };
}

/**
 * Safe-to-log summary. Checks presence of secrets, never their contents.
 */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    supabaseUrl: config.supabase.url,
    supabaseCredentialsFrom: config.supabase.credentialSource,
    serviceRoleKeyPresent: config.supabase.serviceRoleKey.length > 0,
    enabledProviders: config.providers.enabled,
    pricingProvider: config.providers.pricingProvider,
    pricingBookmaker: config.providers.pricingBookmaker ?? '(all bookmakers)',
    mockMode: config.providers.mockMode,
    livePollMs: config.polling.liveIntervalMs,
    prematchPollMs: config.polling.prematchIntervalMs,
    pushEnabled: config.push.enabled,
    pushReconcileMs: config.push.reconcileIntervalMs,
    concurrency: config.polling.concurrency,
    requestTimeoutMs: config.http.timeoutMs,
    rateLimitPerMinute: config.http.rateLimitPerMinute,
    writeBatchSize: config.http.writeBatchSize,
    historyEnabled: config.history.enabled,
    dryRun: config.runtime.dryRun,
    theOddsApi: {
      keyPresent: Boolean(config.providers_.theOddsApi.apiKey),
      regions: config.providers_.theOddsApi.regions,
      markets: config.providers_.theOddsApi.markets,
      sports: config.providers_.theOddsApi.sports.length ? config.providers_.theOddsApi.sports : '(all in-season)',
    },
  };
}
