/**
 * Shutdown handling.
 *
 * `installShutdownHandlers` is the only thing standing between `Ctrl-C` and a
 * half-written batch, so its contract is worth pinning: it aborts the controller,
 * it is idempotent against a second signal, and `dispose()` really removes the
 * listeners (otherwise a test process, or a second run in the same process, would
 * accumulate handlers).
 *
 * The process-exit paths are not exercised here — a test cannot let itself be
 * killed — but everything up to that boundary is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdownHandlers } from '../../src/workers/worker.ts';
import { silentLogger } from '../../src/logging/logger.ts';

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length > 0) disposers.pop()?.();
});

function install(graceMs = 10_000) {
  const controller = new AbortController();
  const handles = installShutdownHandlers(controller, silentLogger(), graceMs);
  disposers.push(handles.dispose);
  return { controller, ...handles };
}

describe('installShutdownHandlers', () => {
  it('registers SIGINT and SIGTERM listeners', () => {
    const before = {
      int: process.listenerCount('SIGINT'),
      term: process.listenerCount('SIGTERM'),
    };

    install();

    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
  });

  it('aborts the controller when a signal arrives', () => {
    const { controller } = install();

    expect(controller.signal.aborted).toBe(false);
    process.emit('SIGINT', 'SIGINT');

    expect(controller.signal.aborted).toBe(true);
  });

  it('resolves whenAborted once a signal arrives', async () => {
    const { whenAborted } = install();

    let resolved = false;
    void whenAborted.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    process.emit('SIGTERM', 'SIGTERM');
    await whenAborted;

    expect(resolved).toBe(true);
  });

  it('removes its listeners on dispose', () => {
    const before = process.listenerCount('SIGINT');
    const { dispose } = install();

    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    dispose();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('does not abort anything after dispose', () => {
    const { controller, dispose } = install();
    dispose();

    process.emit('SIGINT', 'SIGINT');

    // The listener is gone, so nothing aborted. (Other handlers in the process
    // could in theory react, which is why we assert on our own controller only.)
    expect(controller.signal.aborted).toBe(false);
  });

  it('exits the process on a second signal, so a stuck shutdown cannot hang a deploy', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    try {
      const { controller } = install();

      // First signal: cooperative.
      process.emit('SIGINT', 'SIGINT');
      expect(controller.signal.aborted).toBe(true);
      expect(exit).not.toHaveBeenCalled();

      // Second signal: give up.
      expect(() => process.emit('SIGINT', 'SIGINT')).toThrow(/process\.exit\(130\)/);
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      exit.mockRestore();
    }
  });
});
