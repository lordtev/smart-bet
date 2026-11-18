/**
 * Structured logging
 * ─────────────────────────────────────────────────────────────────────────────
 * One logging shape for the whole engine: `{ ts, level, msg, ...fields }`.
 * `pretty` prints for a terminal, `json` prints one object per line for a log
 * collector. Both carry the same fields, so nothing is lost by switching.
 *
 * Secrets: `redact()` is applied to every field value that could hold a URL or
 * a header, and the logger also scrubs a set of registered secret strings
 * (provider API keys, the service-role key) from any string it prints. That way
 * a key that ends up in an error message from the HTTP stack cannot leak into
 * logs or a crash report.
 */

import type { LogFormat, LogLevel } from '../config.ts';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export type LogFields = Record<string, unknown>;

export type Logger = {
  trace: (msg: string, fields?: LogFields) => void;
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
  /** A logger that automatically adds these fields to every line. */
  child: (fields: LogFields) => Logger;
  level: LogLevel;
};

/** Strings that must never appear in output. Values shorter than 8 chars are
 *  ignored because redacting them would mangle ordinary log text. */
const secrets = new Set<string>();

export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function clearSecrets(): void {
  secrets.clear();
}

const REDACTED_QUERY_PARAMS = ['apikey', 'api_key', 'x-api-key', 'access_token', 'token', 'key'];

/** Replace known secrets and credential-bearing query parameters in a string. */
export function redact(input: string): string {
  let out = input;

  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
  }

  // Belt and braces: any credential-looking query parameter, even one we do not
  // know about yet.
  for (const param of REDACTED_QUERY_PARAMS) {
    const re = new RegExp(`([?&]${param}=)[^&\\s"']+`, 'gi');
    out = out.replace(re, '$1[redacted]');
  }

  return out;
}

/**
 * Deep-copy a field value with secrets scrubbed.
 *
 * The `seen` set makes a circular field log as `[circular]` instead of blowing
 * the stack — an error object that refers to itself must not be able to kill a
 * log call and, with it, the cycle that was trying to report a failure.
 */
function redactValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redact(value);

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const mapped = value.map((entry) => redactValue(entry, seen));
    seen.delete(value);
    return mapped;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redact(value.message),
      ...(value.stack ? { stack: redact(value.stack) } : {}),
    };
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(entry, seen);
    }
    seen.delete(value);
    return out;
  }

  return value;
}

function formatPretty(level: LogLevel, msg: string, fields: LogFields): string {
  const time = new Date().toISOString().slice(11, 23);
  const label = level.toUpperCase().padEnd(5);

  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (v === null) {
      parts.push(`${k}=null`);
    } else if (typeof v === 'string') {
      parts.push(/[\s"']/.test(v) ? `${k}="${v}"` : `${k}=${v}`);
    } else if (typeof v === 'object') {
      let text: string;
      try {
        text = JSON.stringify(v);
      } catch {
        text = '[unserialisable]';
      }
      parts.push(`${k}=${text}`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }

  const suffix = parts.length ? ` ${parts.join(' ')}` : '';
  return `${time} ${label} ${msg}${suffix}`;
}

export type LoggerOptions = {
  level: LogLevel;
  format: LogFormat;
  /** Injected in tests. */
  sink?: (line: string) => void;
  /** Base fields merged into every record (e.g. the provider key, the worker). */
  base?: LogFields;
};

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const base = options.base ?? {};
  const emit = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const write = (level: LogLevel, msg: string, fields: LogFields): void => {
    if (LEVEL_ORDER[level] < threshold) return;

    const merged = redactValue({ ...base, ...fields }) as LogFields;

    if (options.format === 'json') {
      const record = { ts: new Date().toISOString(), level, msg: redact(msg), ...merged };
      let line: string;
      try {
        line = JSON.stringify(record);
      } catch {
        line = JSON.stringify({ ts: record.ts, level, msg: record.msg, logError: 'unserialisable fields' });
      }
      emit(line);
    } else {
      emit(formatPretty(level, redact(msg), merged));
    }
  };

  const logger: Logger = {
    level: options.level,
    trace: (m, f) => write('trace', m, f ?? {}),
    debug: (m, f) => write('debug', m, f ?? {}),
    info: (m, f) => write('info', m, f ?? {}),
    warn: (m, f) => write('warn', m, f ?? {}),
    error: (m, f) => write('error', m, f ?? {}),
    child: (fields) =>
      createLogger({ ...options, base: { ...base, ...fields }, ...(options.sink ? { sink: options.sink } : {}) }),
  };

  return logger;
}

/** A logger that throws away everything. Used in unit tests. */
export function silentLogger(): Logger {
  return createLogger({ level: 'error', format: 'json', sink: () => {} });
}
