import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PORT_ATTEMPTS } from '../../core/limits';
import { failure } from '../../core/result';
import { systemRandomBytes } from './aes-gcm';
import { LAST_PORT, startHostServer } from './host-server';

const listening = vi.hoisted(() => ({
  outcomes: [] as (string | Error | null)[],
  calls: [] as { port: number; host: string }[],
}));

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  createServer: () => {
    const server = new EventEmitter();
    return Object.assign(server, {
      listen: (where: { port: number; host: string }) => {
        listening.calls.push(where);
        const outcome = listening.outcomes.shift() ?? null;
        queueMicrotask(() => {
          if (outcome === null) {
            server.emit('listening');
            return;
          }
          server.emit(
            'error',
            typeof outcome === 'string'
              ? Object.assign(new Error(outcome), { code: outcome })
              : outcome,
          );
        });
        return server;
      },
      close: (done: () => void) => {
        done();
      },
      closeAllConnections: () => undefined,
    });
  },
}));

/** Starts a host whose listening follows the outcomes given. */
function start(port: number, outcomes: (string | Error | null)[]) {
  listening.outcomes = outcomes;
  listening.calls = [];
  return startHostServer({
    port,
    startTimer: () => () => undefined,
    randomBytes: systemRandomBytes,
    events: {
      joined: () => undefined,
      message: () => undefined,
      left: () => undefined,
      codeChanged: () => undefined,
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the listening of the host', () => {
  it('listens on IPv4 alone when the system has no IPv6', async () => {
    const started = await start(47_313, ['EAFNOSUPPORT', null]);
    expect([started.ok && started.value.port, listening.calls]).toEqual([
      47_313,
      [
        { port: 47_313, host: '::' },
        { port: 47_313, host: '0.0.0.0' },
      ],
    ]);
    if (started.ok) {
      await started.value.close();
    }
  });

  it('gives up after trying as many ports as allowed, never past the last port', async () => {
    expect(
      await start(
        47_313,
        Array.from({ length: MAX_PORT_ATTEMPTS }, () => 'EADDRINUSE'),
      ),
    ).toEqual(failure('NO_FREE_PORT'));
    expect(listening.calls.map((call) => call.port)).toEqual(
      Array.from({ length: MAX_PORT_ATTEMPTS }, (_unused, index) => 47_313 + index),
    );
    expect(await start(LAST_PORT - 1, ['EADDRINUSE', 'EADDRINUSE'])).toEqual(
      failure('NO_FREE_PORT'),
    );
    expect(listening.calls.map((call) => call.port)).toEqual([LAST_PORT - 1, LAST_PORT]);
  });

  it('stops on any other error and logs it, with its message when it has no code', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await start(47_313, ['EACCES'])).toEqual(failure('LISTEN_FAILED'));
    expect(await start(47_313, [new Error('No network')])).toEqual(failure('LISTEN_FAILED'));
    expect(errors.mock.calls).toEqual([
      ['The shared plan could not listen on port 47313: EACCES'],
      ['The shared plan could not listen on port 47313: No network'],
    ]);
  });
});
