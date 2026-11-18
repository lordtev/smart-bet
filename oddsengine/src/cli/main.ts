#!/usr/bin/env node
/**
 * oddsengine CLI
 * -----------------------------------------------------------------------------
 * Everything the operator needs, runnable from the `oddsengine` directory with
 * the website stopped:
 *
 *   node --env-file-if-exists=.env src/cli/main.ts <command> [flags]
 *
 * Commands
 *   all              run the live and prematch workers together (production shape)
 *   live             run only the live worker
 *   prematch         run only the prematch worker
 *   once             run a single cycle per provider and exit
 *   scan             fetch and map, print what *would* be written, write nothing
 *   doctor           check configuration, connectivity, schema and health
 *   publish          publish the pricing source's current quotes, then exit
 *
 * Flags
 *   --provider=<key>[,<key>]   restrict to these providers (must be enabled)
 *   --mode=live|prematch|both  mode for `once` and `scan` (default both)
 *   --dry-run                  compute everything, write nothing
 *   --log-level=<level>        trace|debug|info|warn|error
 *   --json                     force JSON log output
 *   --help                     this text
 */

import { loadConfig, describeConfig, resolveProcessEnv, type Config, type LogLevel } from '../config.ts';
import { adapterContextFor, createRuntime, initProviders, type Runtime } from '../bootstrap.ts';
import { tableExists } from '../db/client.ts';
import { formatInterval, installShutdownHandlers, runWorker, syncSources } from '../workers/worker.ts';
import type { CycleMode, CycleStats } from '../engine.ts';

const HELP = `
SMARTBET odds engine

Usage:
  node src/cli/main.ts <command> [flags]

Commands:
  all                     Run live + prematch workers together (production shape)
  live                    Run only the live worker
  prematch                Run only the prematch worker
  once                    Run one cycle per provider, then exit
  scan                    Dry run: fetch, map and report. Touches no odds.
  doctor                  Check config, database, schema and provider health
  sports [--probe]        List the provider's competitions; --probe counts their fixtures (free)
  publish                 Publish the pricing source's current quotes, then exit

Flags:
  --provider=<a,b>        Restrict to these providers (must be in ENABLED_PROVIDERS)
  --mode=live|prematch|both   Mode for 'once' and 'scan' (default: both)
  --dry-run               Compute everything, write nothing
  --log-level=<level>     trace | debug | info | warn | error
  --json                  Force JSON log lines
  --probe                 With 'sports': ask the provider how many fixtures each sport holds
  --help                  Show this help

Examples:
  node src/cli/main.ts once --provider=mock --dry-run        # safest first run
  node src/cli/main.ts doctor                                # is everything wired up?
  node src/cli/main.ts once --provider=mock                  # write to the database
  node src/cli/main.ts live                                  # start the live worker
`.trim();

type ParsedArgs = {
  command: string;
  providers: string[] | null;
  mode: CycleMode | 'both';
  dryRun: boolean | null;
  logLevel: LogLevel | null;
  json: boolean;
  help: boolean;
  /** With 'sports': also probe each feed for its fixture count. */
  probe: boolean;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    command: 'help',
    providers: null,
    mode: 'both',
    dryRun: null,
    logLevel: null,
    json: false,
    help: false,
    probe: false,
  };

  for (const raw of argv) {
    if (!raw.startsWith('-')) {
      args.command = raw;
      continue;
    }

    const [flag, value] = raw.includes('=') ? raw.split(/=(.*)/s) : [raw, undefined];

    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--provider':
      case '--providers':
        args.providers = (value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
        break;
      case '--mode': {
        const mode = (value ?? '').trim().toLowerCase();
        if (mode !== 'live' && mode !== 'prematch' && mode !== 'both') {
          throw new Error(`--mode must be live, prematch or both (got "${value ?? ''}")`);
        }
        args.mode = mode;
        break;
      }
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--no-dry-run':
        args.dryRun = false;
        break;
      case '--log-level': {
        const level = (value ?? '').trim().toLowerCase();
        if (!['trace', 'debug', 'info', 'warn', 'error'].includes(level)) {
          throw new Error(`--log-level must be trace, debug, info, warn or error (got "${value ?? ''}")`);
        }
        args.logLevel = level as LogLevel;
        break;
      }
      case '--json':
        args.json = true;
        break;
      case '--probe':
        args.probe = true;
        break;
      default:
        throw new Error(`unknown flag "${flag}" - run with --help`);
    }
  }

  return args;
}

function loadCliConfig(args: ParsedArgs): Config {
  const overrides: Parameters<typeof loadConfig>[1] = {};

  if (args.providers && args.providers.length > 0) {
    overrides.enabled = args.providers;
  }
  if (args.dryRun !== null) {
    overrides.dryRun = args.dryRun;
  }
  if (args.logLevel) {
    overrides.logLevel = args.logLevel;
  }

  const config = loadConfig(resolveProcessEnv().env, overrides);

  // A restricted --provider list must still honour the pricing provider rule.
  if (args.providers && !args.providers.includes(config.providers.pricingProvider)) {
    const first = args.providers[0] as string;
    config.providers.pricingProvider = first;
    config.providers.pricingBookmaker = null;
  }

  if (args.json) config.logging.format = 'json';

  return config;
}

/* -- Commands -------------------------------------------------------------- */

/* -- Schema gate ----------------------------------------------------------- */

/** Every table the engine needs, in the order a human would add them. */
const REQUIRED_TABLES = [
  'sports',
  'leagues',
  'teams',
  'events',
  'market_types',
  'markets',
  'selections',
  'odds_history',
  'odds_sources',
  'odds_source_links',
  'odds_market_rules',
  'odds_quotes',
  'odds_history_rules',
  'odds_source_health',
  'odds_worker_runs',
];

const MIGRATION_HINT =
  'Run supabase/migrations/20260101000700_odds_engine.sql and then ' +
  'supabase/migrations/20260101000800_odds_market_rules.sql in the Supabase SQL Editor.';

/**
 * Canonical market families the seed migration adds to `market_types`. `doctor`
 * reports how many of them are present, which distinguishes "schema applied" from
 * "seed applied" — a distinction that matters, because without the seed every
 * provider market is unknown and gets auto-mapped to an `EXT_…` code.
 */
const ENGINE_MARKET_TYPE_CODES = [
  'SPREADS',
  'MATCH_WINNER_LAY',
  'WINNER_LAY',
  'HALF_TIME_FULL_TIME',
  'TEAM_TOTAL',
  'CORNERS_1X2',
  'TO_QUALIFY',
  'PLAYER_POINTS',
  'PLAYER_REBOUNDS',
  'PLAYER_ASSISTS',
  'PLAYER_THREES',
  'PLAYER_ANYTIME_GOALSCORER',
  'PLAYER_SHOTS_ON_TARGET',
];

/**
 * Fail fast, with the actual instruction, when the database has not been
 * migrated. Without this, the first symptom is a raw PostgREST error from deep
 * inside a cycle, which tells an operator nothing useful.
 */
async function assertSchema(runtime: Runtime): Promise<void> {
  const missing: string[] = [];
  for (const table of REQUIRED_TABLES) {
    if (!(await tableExists(runtime.db, table))) missing.push(table);
  }

  if (missing.length > 0) {
    throw new Error(`the database is not migrated yet - missing table(s): ${missing.join(', ')}. ${MIGRATION_HINT}`);
  }
}

async function commandOnce(
  runtime: Runtime,
  providers: readonly string[],
  modes: readonly CycleMode[],
  signal: AbortSignal,
): Promise<{ stats: CycleStats[]; initFailed: Array<{ key: string; error: string }> }> {
  const { config, log } = runtime;

  await assertSchema(runtime);

  // Initialise before anything else: adapters validate credentials and warm
  // caches here, and a cycle must never start without it.
  const init = await initProviders({
    providers: runtime.providers.filter((provider) => providers.includes(provider.key)),
    contextFor: (provider) => adapterContextFor(runtime, log.child({ provider: provider.key }), signal),
    log,
  });

  // Only sources that actually initialised are synced, so `odds_sources`
  // reflects what can run — a provider that failed init is disabled rather than
  // left looking enabled in the database.
  const sourceRows = await syncSources(config, init.ready, runtime.sources, log);
  const results: CycleStats[] = [];

  for (const provider of init.ready) {
    const source = sourceRows.get(provider.key);
    if (!source) continue;

    for (const mode of modes) {
      if (mode === 'live' && !provider.supportsLive) continue;
      if (mode === 'prematch' && !provider.supportsPrematch) continue;

      if (config.runtime.dryRun) {
        log.warn('dry run: nothing will be written', { provider: provider.key, mode });
      }

      const outcome = await runWorker({
        engine: runtime.engine,
        provider,
        source,
        mode,
        intervalMs: 1,
        log,
        signal,
        once: true,
        adapterContext: (childLog, adapterSignal) => adapterContextFor(runtime, childLog, adapterSignal),
      });

      if (outcome.lastStats) results.push(outcome.lastStats);
    }
  }

  return { stats: results, initFailed: init.failed };
}

async function commandScan(
  runtime: Runtime,
  providers: readonly string[],
  modes: readonly CycleMode[],
  signal: AbortSignal,
): Promise<{ initFailed: Array<{ key: string; error: string }> }> {
  const { config, log } = runtime;

  // A scan must never write. Force it, whatever the environment said.
  config.runtime.dryRun = true;

  const { stats, initFailed } = await commandOnce(runtime, providers, modes, signal);

  log.info('scan summary', {
    providers: providers.join(', '),
    cycles: stats.length,
    fixtures: stats.reduce((sum, entry) => sum + entry.fixturesFetched, 0),
    canonicalMarkets: stats.reduce((sum, entry) => sum + entry.canonicalMarkets, 0),
    outcomes: stats.reduce((sum, entry) => sum + entry.outcomesOut, 0),
    quotesThatWouldBeWritten: stats.reduce((sum, entry) => sum + entry.quotesPrepared, 0),
    rejectedPrices: stats.reduce((sum, entry) => sum + entry.rejectedPrices, 0),
    unknownMarkets: stats.reduce((sum, entry) => sum + entry.unknownMarkets, 0),
    wroteNothing: true,
  });

  for (const entry of stats) {
    log.info('scan detail', {
      provider: entry.provider,
      mode: entry.mode,
      ok: entry.ok,
      error: entry.error,
      fixtures: entry.fixturesFetched,
      providerMarkets: entry.providerMarkets,
      canonicalMarkets: entry.canonicalMarkets,
      outcomesIn: entry.outcomesIn,
      outcomesOut: entry.outcomesOut,
      unknownMarkets: entry.unknownMarkets,
      rejectedPrices: entry.rejectedPrices,
    });
  }

  return { initFailed };
}

async function commandWorkers(
  runtime: Runtime,
  providers: readonly string[],
  modes: readonly CycleMode[],
  signal: AbortSignal,
): Promise<void> {
  const { config, log } = runtime;

  await assertSchema(runtime);

  // Initialise once per provider, before any loop starts. A provider that cannot
  // initialise (bad key, unreachable host) is excluded rather than retried on
  // every cycle, and its source row is left disabled instead of pretending.
  const init = await initProviders({
    providers: runtime.providers.filter((provider) => providers.includes(provider.key)),
    contextFor: (provider) => adapterContextFor(runtime, log.child({ provider: provider.key }), signal),
    log,
  });

  const sourceRows = await syncSources(config, init.ready, runtime.sources, log);

  const loops: Promise<unknown>[] = [];

  for (const provider of init.ready) {
    const source = sourceRows.get(provider.key);
    if (!source) continue;

    for (const mode of modes) {
      if (mode === 'live' && !provider.supportsLive) continue;
      if (mode === 'prematch' && !provider.supportsPrematch) continue;

      const intervalMs = mode === 'live' ? config.polling.liveIntervalMs : config.polling.prematchIntervalMs;

      log.info('scheduling worker', {
        provider: provider.key,
        mode,
        interval: formatInterval(intervalMs),
      });

      loops.push(
        runWorker({
          engine: runtime.engine,
          provider,
          source,
          mode,
          intervalMs,
          log,
          signal,
          adapterContext: (childLog, adapterSignal) => adapterContextFor(runtime, childLog, adapterSignal),
          push: {
            enabled: config.push.enabled,
            debounceMs: config.push.debounceMs,
            reconcileIntervalMs: config.push.reconcileIntervalMs,
          },
        }),
      );
    }
  }

  if (loops.length === 0) {
    const reasons = init.failed.map((entry) => `${entry.key}: ${entry.error}`).join('; ');
    throw new Error(
      'no worker could be started — check ENABLED_PROVIDERS, --provider and --mode' +
        (reasons ? ` (providers that failed to initialise: ${reasons})` : ''),
    );
  }

  await Promise.all(loops);
  log.info('all workers stopped');
}

async function commandPublish(runtime: Runtime): Promise<void> {
  const { config, log } = runtime;
  await assertSchema(runtime);

  const init = await initProviders({
    providers: runtime.providers,
    contextFor: (provider) => adapterContextFor(runtime, log.child({ provider: provider.key }), new AbortController().signal),
    log,
  });

  const sourceRows = await syncSources(config, init.ready, runtime.sources, log);
  const pricingKey = config.providers.pricingProvider;

  // Say what actually went wrong. Without this the failure surfaces as
  // "source X is not the pricing source", which describes the symptom of an
  // init failure rather than its cause.
  const initFailure = init.failed.find((entry) => entry.key === pricingKey);
  if (initFailure) {
    throw new Error(`the pricing provider "${pricingKey}" could not initialise: ${initFailure.error}`);
  }

  const source = sourceRows.get(pricingKey);

  if (!source) throw new Error(`pricing provider "${pricingKey}" has no odds source row`);

  const result = await runtime.quotes.publishPrices({
    sourceId: source.id,
    maxStalenessSeconds: config.changeDetection.publishMaxStalenessSeconds,
  });

  log.info('published', {
    source: pricingKey,
    pricesUpdated: result.prices_updated,
    statusesUpdated: result.statuses_updated,
    publishedAt: result.published_at,
  });
}

async function commandSports(runtime: Runtime, providerKey: string, probe: boolean): Promise<number> {
  const { log } = runtime;
  const provider = runtime.providerFor(providerKey);

  if (!provider.listSports) {
    log.error('this provider does not expose a sport list', { provider: providerKey });
    return 1;
  }

  const controller = new AbortController();
  const init = await initProviders({
    providers: [provider],
    contextFor: (entry) => adapterContextFor(runtime, log.child({ provider: entry.key }), controller.signal),
    log,
  });

  if (init.failed.length > 0) {
    log.error('provider could not initialise', { error: init.failed[0]?.error });
    return 1;
  }

  // The same window the prematch worker uses, so "how many fixtures" means the
  // same thing here as it will in production.
  const spanMs = runtime.config.polling.prematchLookaheadMinutes * 60_000;
  const probeWindow = { from: new Date(), to: new Date(Date.now() + spanMs) };

  log.info(probe ? 'probing each sport for fixtures (free endpoint)' : 'listing in-season sports', {
    provider: providerKey,
    windowDays: Math.round(spanMs / 86_400_000),
  });

  const sports = await provider.listSports(
    adapterContextFor(runtime, log.child({ provider: providerKey }), controller.signal),
    probe ? { probeWindow } : undefined,
  );

  const configured = runtime.config.providers_.theOddsApi.sports;
  const usingAll = configured.length === 0;

  for (const sport of sports) {
    const selected = usingAll || configured.includes(sport.key);
    log.info(`${selected ? '*' : ' '} ${sport.group} / ${sport.title}`, {
      key: sport.key,
      ...(sport.hasOutrights ? { outrights: true } : {}),
      ...(sport.eventCount === undefined ? {} : { fixtures: sport.eventCount < 0 ? '?' : sport.eventCount }),
    });
  }

  const withFixtures = sports
    .filter((sport) => (sport.eventCount ?? 0) > 0)
    .sort((a, b) => (b.eventCount ?? 0) - (a.eventCount ?? 0));

  log.info('summary', {
    sports: sports.length,
    currentlyEnabled: usingAll ? 'ALL of them (the sport list is empty)' : configured.join(', '),
    creditsPerSportPerCycle: sports[0]?.estimatedCredits ?? null,
  });

  if (probe) {
    const totalCredits = withFixtures.reduce((sum, sport) => sum + (sport.estimatedCredits ?? 0), 0);
    const top10 = withFixtures.slice(0, 10);
    const remaining = provider.getUsage().quotaRemaining ?? null;

    log.info('probe result', {
      sportsWithFixtures: withFixtures.length,
      fixturesAvailable: withFixtures.reduce((sum, sport) => sum + (sport.eventCount ?? 0), 0),
      creditsForAllPerCycle: totalCredits,
      creditsForTop10PerCycle: top10.reduce((sum, sport) => sum + (sport.estimatedCredits ?? 0), 0),
      quotaRemaining: remaining,
    });

    // Ready to paste, so choosing is copy-and-trim rather than typing keys.
    log.info('suggested THE_ODDS_API_SPORTS (every sport with fixtures, most first)', {
      value: withFixtures.map((sport) => sport.key).join(','),
    });

    if (remaining !== null && totalCredits > remaining) {
      log.warn('enabling all of these would cost more than your remaining quota in one cycle', {
        creditsForAllPerCycle: totalCredits,
        quotaRemaining: remaining,
      });
    }
  } else {
    log.info('hint', { next: 'add --probe to see how many fixtures each sport holds (free call)' });
  }

  return 0;
}

async function commandDoctor(runtime: Runtime): Promise<number> {
  const { config, log } = runtime;
  const problems: string[] = [];

  log.info('configuration', describeConfig(config));

  // 1. Database reachable?
  try {
    const { error } = await runtime.db.from('sports').select('id', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    log.info('database reachable', { url: config.supabase.url });
  } catch (error) {
    problems.push(`database unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. Schema present?
  const missingTables: string[] = [];
  for (const table of REQUIRED_TABLES) {
    // A GET, not a HEAD: on this PostgREST version a HEAD against a missing
    // table reports success, which would make this check meaningless.
    if (!(await tableExists(runtime.db, table))) missingTables.push(table);
  }
  if (missingTables.length > 0) {
    problems.push(
      `missing tables: ${missingTables.join(', ')} - run supabase/migrations/20260101000700_odds_engine.sql and 20260101000800_odds_market_rules.sql`,
    );
  } else {
    log.info('schema present', { tables: REQUIRED_TABLES.length });
  }

  // 3. Functions present?
  const missingFunctions: string[] = [];
  for (const [name, args] of [
    ['odds_apply_quotes', { p_source_id: null, p_quotes: [] }],
    ['odds_publish_prices', { p_source_id: null, p_max_staleness_seconds: 0 }],
  ] as const) {
    const { error } = await runtime.db.rpc(name, args as never);
    // A "not the pricing source" / "unknown source" error means the function
    // exists and rejected bad input - which is exactly what we want to see.
    const message = error?.message ?? '';
    const exists = !/does not exist|Could not find the function/i.test(message);
    if (!exists) missingFunctions.push(name);
  }
  if (missingFunctions.length > 0) {
    problems.push(`missing database functions: ${missingFunctions.join(', ')}`);
  } else {
    log.info('database functions present');
  }

  // 4. Canonical key coverage.
  try {
    const [markets, selections] = await Promise.all([
      runtime.db.from('markets').select('id', { count: 'exact', head: true }).is('canonical_key', null),
      runtime.db.from('selections').select('id', { count: 'exact', head: true }).is('outcome_key', null),
    ]);

    if (markets.error || selections.error) {
      // Those columns only exist after the migration; report the real reason
      // rather than a misleading zero.
      const detail = (markets.error ?? selections.error)?.message ?? 'unknown error';
      problems.push(`could not measure canonical identity coverage (${detail})`);
    } else {
      const uncoveredMarkets = markets.count ?? 0;
      const uncoveredSelections = selections.count ?? 0;

      log.info('canonical identity coverage', {
        marketsWithoutCanonicalKey: uncoveredMarkets,
        selectionsWithoutOutcomeKey: uncoveredSelections,
      });

      if (uncoveredMarkets > 0 || uncoveredSelections > 0) {
        log.warn('some catalogue rows have no canonical identity', {
          marketsWithoutCanonicalKey: uncoveredMarkets,
          selectionsWithoutOutcomeKey: uncoveredSelections,
          effect: 'the engine creates canonical rows alongside them instead of adopting them',
        });
      }
    }
  } catch (error) {
    log.warn('could not check canonical coverage', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 5. Seed data from the second migration, and sources/health.
  try {
    const [ruleCount, newTypes, historyRules] = await Promise.all([
      runtime.db.from('odds_market_rules').select('id', { count: 'exact', head: true }),
      runtime.db.from('market_types').select('code', { count: 'exact', head: true }).in('code', ENGINE_MARKET_TYPE_CODES),
      runtime.db.from('odds_history_rules').select('market_type_id', { count: 'exact', head: true }),
    ]);

    log.info('seed data', {
      marketRules: ruleCount.count ?? 0,
      engineMarketTypes: `${newTypes.count ?? 0}/${ENGINE_MARKET_TYPE_CODES.length}`,
      historyRules: historyRules.count ?? 0,
    });

    if ((ruleCount.count ?? 0) === 0) {
      // The trap this guards against: with no rules, every provider market is
      // "unknown", so the engine auto-maps it to EXT_… and publishes under a
      // made-up name instead of MATCH_WINNER / OVER_UNDER.
      problems.push(
        'odds_market_rules is empty — every provider market would be auto-mapped to an EXT_… code. ' +
          'Run supabase/migrations/20260101000800_odds_market_rules.sql.',
      );
    }
  } catch (error) {
    log.warn('could not read seed data', { error: error instanceof Error ? error.message : String(error) });
  }

  // 5b. The database's pricing flag must agree with PRICING_PROVIDER.
  //     It can drift: a test suite has to take the flag to prove publishing, a
  //     manual SQL experiment can move it, and either can leave the book pointing
  //     at a source the engine is not even running. The next worker start repairs
  //     it, but an operator should not have to guess why prices stopped moving.
  try {
    const { data: pricingRows } = await runtime.db
      .from('odds_sources')
      .select('key, is_enabled')
      .eq('is_pricing_source', true);

    const pricing = (pricingRows ?? []) as Array<{ key: string; is_enabled: boolean }>;
    const expected = config.providers.pricingProvider;
    const actual = pricing[0]?.key ?? null;

    if (pricing.length === 0) {
      problems.push(
        `no odds source is flagged is_pricing_source, but PRICING_PROVIDER is "${expected}" — ` +
          'nothing would reach selections.odds. Start a worker (or run `once`) to re-sync from the environment.',
      );
    } else if (actual !== expected) {
      problems.push(
        `the database publishes from "${actual}" but PRICING_PROVIDER is "${expected}" — ` +
          'the next worker start re-syncs it, or run `once` to do it now.',
      );
    } else if (!pricing[0]?.is_enabled) {
      problems.push(`the pricing source "${actual}" is disabled — nothing would be published`);
    } else {
      log.info('pricing source matches configuration', { pricingSource: actual });
    }
  } catch (error) {
    log.warn('could not check the pricing source', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const snapshot = await runtime.health.snapshot();
    log.info('sources', { sources: snapshot.sources });
    log.info('health', { health: snapshot.health });
    log.info('queues', {
      unmappedMarkets: snapshot.unmappedMarkets,
      staleQuotes: snapshot.staleQuotes,
    });

    // A run still marked 'running' long after it started means the process died
    // without shutting down (power loss, SIGKILL, container eviction). Worth
    // surfacing: it is the only trace a hard kill leaves behind.
    const stuck = await runtime.db
      .from('odds_worker_runs')
      .select('id, worker, started_at', { count: 'exact' })
      .eq('status', 'running')
      .lt('started_at', new Date(Date.now() - 15 * 60_000).toISOString());

    if ((stuck.count ?? 0) > 0) {
      log.warn('worker runs left in progress (the process was killed without a clean shutdown)', {
        count: stuck.count,
        oldest: (stuck.data as Array<{ started_at: string }> | null)?.[0]?.started_at ?? null,
      });
    }
  } catch (error) {
    log.warn('could not read health', { error: error instanceof Error ? error.message : String(error) });
  }

  // 6. Provider credentials.
  for (const provider of runtime.providers) {
    try {
      await provider.init({
        log: log.child({ provider: provider.key }),
        signal: new AbortController().signal,
        http: runtime.http,
        now: () => new Date(),
      });
      log.info('provider initialised', { provider: provider.key, usage: provider.getUsage() });
    } catch (error) {
      problems.push(
        `provider ${provider.key} failed to initialise: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) log.error('doctor found a problem', { problem });
    return 1;
  }

  log.info('doctor: everything looks healthy');
  return 0;
}

/* -- Entry point ----------------------------------------------------------- */

async function main(): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}\n`);
    return 2;
  }

  if (args.help || args.command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  let config: Config;
  try {
    config = loadCliConfig(args);
  } catch (error) {
    process.stderr.write(`configuration error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const runtime = createRuntime(config);
  const providers = args.providers?.length ? args.providers : config.providers.enabled;

  const controller = new AbortController();
  const shutdown = installShutdownHandlers(controller, runtime.log, config.runtime.shutdownGraceMs);

  const modes: CycleMode[] =
    args.mode === 'both' ? ['live', 'prematch'] : [args.mode];

  try {
    switch (args.command) {
      case 'all':
        await commandWorkers(runtime, providers, ['live', 'prematch'], controller.signal);
        return 0;

      case 'live':
        await commandWorkers(runtime, providers, ['live'], controller.signal);
        return 0;

      case 'prematch':
        await commandWorkers(runtime, providers, ['prematch'], controller.signal);
        return 0;

      case 'once': {
        const { stats, initFailed } = await commandOnce(runtime, providers, modes, controller.signal);
        const cycleFailures = stats.filter((entry) => !entry.ok);
        // A provider that could not even initialise counts as a failure: exiting
        // 0 would tell a CI job or a cron watchdog that everything is fine.
        return cycleFailures.length > 0 || initFailed.length > 0 ? 1 : 0;
      }

      case 'scan': {
        const { initFailed } = await commandScan(runtime, providers, modes, controller.signal);
        return initFailed.length > 0 ? 1 : 0;
      }

      case 'sports':
        return await commandSports(runtime, providers[0] as string, args.probe);

      case 'doctor':
        return await commandDoctor(runtime);

      case 'publish':
        await commandPublish(runtime);
        return 0;

      default:
        process.stderr.write(`unknown command "${args.command}"\n\n${HELP}\n`);
        return 2;
    }
  } catch (error) {
    runtime.log.error('fatal', { error: error instanceof Error ? error.message : String(error) });
    return 1;
  } finally {
    // Release provider sockets/timers even when a command threw.
    await Promise.all(runtime.providers.map((provider) => provider.shutdown().catch(() => undefined)));
    shutdown.dispose();
  }
}

const exitCode = await main();
process.exitCode = exitCode;
