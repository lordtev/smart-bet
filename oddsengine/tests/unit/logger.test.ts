/**
 * Logging is the only way an operator finds out what the engine did, so it has
 * to be structured, level-filtered, and incapable of printing a secret.
 */
import { describe, expect, it } from 'vitest';
import { clearSecrets, createLogger, redact, registerSecret, silentLogger } from '../../src/logging/logger.ts';

function capture() {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

describe('logger', () => {
  it('emits one JSON object per line in json mode', () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: 'info', format: 'json', sink });

    log.info('cycle complete', { fixtures: 2, changed: 5 });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string);
    expect(record).toMatchObject({ level: 'info', msg: 'cycle complete', fixtures: 2, changed: 5 });
    expect(typeof record.ts).toBe('string');
  });

  it('filters below the configured level', () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: 'warn', format: 'json', sink });

    log.debug('ignored');
    log.info('ignored');
    log.warn('kept');
    log.error('kept');

    expect(lines).toHaveLength(2);
  });

  it('merges child fields into every line', () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: 'info', format: 'json', sink }).child({ provider: 'mock', worker: 'live' });

    log.info('starting', { intervalMs: 3000 });

    expect(JSON.parse(lines[0] as string)).toMatchObject({
      provider: 'mock',
      worker: 'live',
      intervalMs: 3000,
    });
  });

  it('pretty mode keeps the same fields readable', () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: 'info', format: 'pretty', sink });

    log.info('cycle complete', { fixtures: 2, note: 'hello world' });

    expect(lines[0]).toContain('cycle complete');
    expect(lines[0]).toContain('fixtures=2');
    expect(lines[0]).toContain('note="hello world"');
  });

  it('serialises an Error passed as a field instead of printing [object Object]', () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: 'info', format: 'json', sink });

    log.error('failed', { error: new Error('boom') });

    const record = JSON.parse(lines[0] as string);
    expect(record.error).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('survives a field that cannot be serialised', () => {
    const { lines, sink } = capture();
    const log = createLogger({ level: 'info', format: 'json', sink });

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => log.info('circular', { circular })).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('never prints a registered secret', () => {
    clearSecrets();
    registerSecret('provider-api-key-value-123');

    const { lines, sink } = capture();
    const log = createLogger({ level: 'info', format: 'json', sink });

    log.error('request failed', { detail: 'used key provider-api-key-value-123', error: new Error('key provider-api-key-value-123 rejected') });

    expect(lines[0]).not.toContain('provider-api-key-value-123');
    expect(lines[0]).toContain('[redacted]');

    clearSecrets();
  });

  it('ignores secrets that are too short to redact safely', () => {
    clearSecrets();
    registerSecret('abc');
    expect(redact('abc def')).toBe('abc def');
    clearSecrets();
  });
});

describe('redact', () => {
  it('removes credential query parameters from any string', () => {
    expect(redact('https://api.test/v4/sports?apiKey=secret123&markets=h2h')).toBe(
      'https://api.test/v4/sports?apiKey=[redacted]&markets=h2h',
    );
    expect(redact('https://api.test/x?x-api-key=topsecret')).toContain('[redacted]');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('cycle complete fixtures=12')).toBe('cycle complete fixtures=12');
  });
});

describe('silentLogger', () => {
  it('prints nothing at any level', () => {
    const log = silentLogger();
    expect(() => {
      log.trace('a');
      log.debug('b');
      log.info('c');
      log.warn('d');
      log.error('e');
    }).not.toThrow();
  });
});
