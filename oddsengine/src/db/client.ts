/**
 * Supabase client
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side only. The service-role key is read from the environment, never
 * logged, and never crosses into any bundle — this process is the only consumer.
 *
 * The custom fetch mirrors what the website's server client does, for one
 * concrete reason: the project uses the new `sb_secret_…` key format, and
 * Supabase rejects a secret key when the request looks like it came from a
 * browser. So we (a) send the key as `apikey`, (b) drop a redundant
 * `Authorization: Bearer <same key>` header, and (c) identify ourselves with a
 * non-browser User-Agent.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const CLIENT_USER_AGENT = 'smartbet-oddsengine/1.0 (node)';

function isNewSupabaseKey(value: string): boolean {
  return value.startsWith('sb_publishable_') || value.startsWith('sb_secret_');
}

function createEngineFetch(key: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined,
    );

    if (init?.headers) {
      new Headers(init.headers).forEach((value, headerKey) => headers.set(headerKey, value));
    }

    if (isNewSupabaseKey(key) && headers.get('authorization') === `Bearer ${key}`) {
      headers.delete('authorization');
    }

    headers.set('apikey', key);
    headers.set('user-agent', CLIENT_USER_AGENT);

    return fetch(input, { ...init, headers });
  };
}

export type EngineDb = SupabaseClient;

export function createSupabaseClient(url: string, serviceRoleKey: string): EngineDb {
  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: createEngineFetch(serviceRoleKey),
      headers: { 'user-agent': CLIENT_USER_AGENT },
    },
  });
}

/**
 * PostgREST returns errors as objects; this turns one into an Error with the
 * table/hint context attached so a failure names what broke.
 */
export function dbError(context: string, error: { message: string; details?: string | null; hint?: string | null; code?: string | null }): Error {
  const parts = [context, error.message];
  if (error.details) parts.push(`details: ${error.details}`);
  if (error.hint) parts.push(`hint: ${error.hint}`);
  if (error.code) parts.push(`code: ${error.code}`);
  return new Error(parts.join(' — '));
}

/** Throw if `error` is set. Returns the data otherwise. */
export function unwrap<T>(context: string, result: { data: T | null; error: unknown }): T {
  if (result.error) {
    throw dbError(context, result.error as { message: string });
  }
  return result.data as T;
}

/** Chunk an array so no single request exceeds the provider's payload limit. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const safeSize = Math.max(1, size);
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    out.push(items.slice(index, index + safeSize));
  }
  return out;
}

/**
 * Does this table actually exist?
 *
 * Deliberately a real GET rather than a `HEAD` with `count: 'exact'`: on the
 * PostgREST version this project runs, a HEAD request against a missing table
 * comes back with no error at all, which would make a schema check report
 * success against an empty database. A GET returns PGRST205 instead.
 */
export async function tableExists(db: EngineDb, table: string): Promise<boolean> {
  const { error } = await db.from(table).select('*').limit(1);
  if (!error) return true;
  return !isMissingTableError(error);
}

/** True when the error means "that table/relation is not exposed". */
export function isMissingTableError(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code === 'PGRST205' || error.code === '42P01') return true;
  return /could not find the table|does not exist/i.test(error.message ?? '');
}
