#!/usr/bin/env node
/**
 * Purge placeholder fixtures from the catalogue.
 *
 * WHY THIS IS A SCRIPT AND NOT A DELETE STATEMENT
 * -----------------------------------------------
 * Three kinds of placeholder data accumulate in this project, and one of them
 * cannot simply be deleted:
 *
 *   mock    fixtures created by the mock provider (league slug `mock_league`)
 *           plus debris from integration-test runs (`__oe_test`). Nothing
 *           references them — safe to delete.
 *
 *   demo    the original placeholder catalogue from
 *           `20260101000200_seed_demo_catalogue.sql`, recognisable by
 *           `events.external_id = 'm1' … 'm12'`. Some of these fixtures are
 *           referenced by `bet_legs`, and `bet_legs.event_id` deliberately has no
 *           ON DELETE CASCADE: a settled or pending bet must keep pointing at the
 *           fixture it was placed on. Those fixtures are RETIRED (status
 *           'finished', markets 'closed') instead of deleted, which removes them
 *           from the site while preserving the audit trail.
 *
 * Deleting an event cascades to its markets, selections, odds_quotes,
 * odds_history rows and provider links, so one delete per fixture is enough.
 * Booking-code legs cascade too, which is fine for placeholder data but means a
 * shared booking code loses those legs — check the report if that matters.
 *
 * Usage:
 *   node scripts/purge-placeholder-data.mjs --dry-run            # report only
 *   node scripts/purge-placeholder-data.mjs --scope=mock         # mock + test debris
 *   node scripts/purge-placeholder-data.mjs --scope=demo         # original demo catalogue
 *   node scripts/purge-placeholder-data.mjs --scope=all
 *
 * Flags:
 *   --scope=mock|demo|all   what to remove (default: mock)
 *   --dry-run               report, change nothing
 *   --no-retire             skip bet-referenced fixtures instead of retiring them
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ── Credentials: oddsengine/.env first, then the website's .env ─────────── */

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function credentials() {
  for (const env of [process.env, readEnvFile(resolve(ROOT, '.env')), readEnvFile(resolve(ROOT, '../.env'))]) {
    if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
      return { url: env.SUPABASE_URL.replace(/\/+$/, ''), key: env.SUPABASE_SERVICE_ROLE_KEY };
    }
  }
  throw new Error('No Supabase credentials. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in oddsengine/.env');
}

const { url, key } = credentials();

const HEADERS = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'User-Agent': 'smartbet-oddsengine/1.0 (purge)',
};

/* ── Arguments ──────────────────────────────────────────────────────────── */

function arg(name, fallback) {
  const hit = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const scope = arg('scope', 'mock');
const dryRun = process.argv.includes('--dry-run');
const retireBlocked = !process.argv.includes('--no-retire');

if (!['mock', 'demo', 'all'].includes(scope)) {
  console.error(`--scope must be mock, demo or all (got "${scope}")`);
  process.exit(2);
}

/* ── REST helpers ───────────────────────────────────────────────────────── */

async function get(path) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'User-Agent': HEADERS['User-Agent'] },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

async function del(path) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: { ...HEADERS, Prefer: 'return=representation' },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DELETE ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

async function patch(path, body) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...HEADERS, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`PATCH ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

const chunk = (items, size = 100) => {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
};

/* ── Choose the fixtures ────────────────────────────────────────────────── */

const MOCK_LEAGUE_SLUGS = ['mock_league', '__oe_test'];

async function main() {
  console.log(`Target: ${url}${dryRun ? '   [DRY RUN — nothing will change]' : ''}`);
  console.log(`Scope : ${scope}\n`);

  const events = await get(
    'events?select=id,name,external_id,status,league_id,leagues(slug,name),starts_at&order=starts_at',
  );

  const candidates = events.filter((event) => {
    const slug = event.leagues?.slug ?? '';
    const isMock = MOCK_LEAGUE_SLUGS.includes(slug);
    // The original demo catalogue is the only data with a 'm<n>' external id.
    const isDemo = /^m\d+$/.test(event.external_id ?? '');

    if (scope === 'mock') return isMock;
    if (scope === 'demo') return isDemo;
    return isMock || isDemo;
  });

  if (candidates.length === 0) {
    console.log('Nothing to do — no matching fixtures were found.');
    return;
  }

  // Which of them are referenced by a bet? Those must not be deleted.
  const legs = await get('bet_legs?select=bet_id,event_id');
  const referenced = new Map();
  for (const leg of legs) {
    const list = referenced.get(leg.event_id) ?? new Set();
    list.add(leg.bet_id);
    referenced.set(leg.event_id, list);
  }

  const toDelete = [];
  const toRetire = [];
  const skipped = [];

  for (const event of candidates) {
    const bets = referenced.get(event.id);
    if (!bets) {
      toDelete.push(event);
    } else if (retireBlocked) {
      toRetire.push({ event, bets: [...bets] });
    } else {
      skipped.push({ event, bets: [...bets] });
    }
  }

  const group = (list) => {
    const out = {};
    for (const entry of list) {
      const label = entry.leagues?.slug ?? (entry.event?.leagues?.slug ?? '?');
      out[label] = (out[label] ?? 0) + 1;
    }
    return out;
  };

  console.log('DELETE:');
  if (toDelete.length === 0) console.log('  (none)');
  for (const [label, count] of Object.entries(group(toDelete))) {
    console.log(`  ${String(count).padStart(3)} fixture(s) in ${label}`);
  }

  console.log('\nRETIRE (referenced by a bet — de-listed, not deleted):');
  if (toRetire.length === 0) console.log('  (none)');
  for (const entry of toRetire) {
    console.log(
      `  ${entry.event.name}  (${entry.event.leagues?.slug})  ← ${entry.bets.length} bet(s): ${entry.bets
        .map((id) => id.slice(0, 8))
        .join(', ')}`,
    );
  }

  if (skipped.length > 0) {
    console.log('\nSKIPPED (--no-retire):');
    for (const entry of skipped) console.log(`  ${entry.event.name}  ← ${entry.bets.length} bet(s)`);
  }

  if (toDelete.length === 0 && toRetire.length === 0) {
    console.log('\nNothing to change.');
    return;
  }

  if (dryRun) {
    console.log('\n[dry-run] nothing was changed. Re-run without --dry-run to apply.');
    return;
  }

  /* ── Apply ────────────────────────────────────────────────────────────── */

  // Delete first: one DELETE per fixture, and the cascade handles markets,
  // selections, quotes, history and provider links.
  for (const batch of chunk(toDelete.map((event) => event.id))) {
    await del(`events?id=in.(${batch.join(',')})`);
  }
  console.log(`\nDeleted ${toDelete.length} fixture(s) and everything hanging off them.`);

  for (const entry of toRetire) {
    await patch(`events?id=eq.${entry.event.id}`, { status: 'finished' });
    // Close the markets too, so nothing can be bet even by a stale client.
    await patch(`markets?event_id=eq.${entry.event.id}`, { status: 'closed' });
  }
  if (toRetire.length > 0) {
    console.log(`Retired ${toRetire.length} bet-referenced fixture(s): status 'finished', markets 'closed'.`);
  }

  /* ── Tidy up leagues that no longer hold any fixture ─────────────────── */

  const remaining = await get('events?select=league_id');
  const usedLeagues = new Set(remaining.map((event) => event.league_id));

  const touchedLeagues = [...new Set(candidates.map((event) => event.league_id))].filter(
    (id) => !usedLeagues.has(id),
  );

  for (const batch of chunk(touchedLeagues)) {
    await del(`leagues?id=in.(${batch.join(',')})`);
  }
  if (touchedLeagues.length > 0) {
    console.log(`Removed ${touchedLeagues.length} now-empty league(s).`);
  }

  console.log('\nDone. Check the result with: node src/cli/main.ts doctor');
}

try {
  await main();
} catch (error) {
  console.error(`\nPurge failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
