import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { freePort, LOOPBACK, spacedClock, until } from '../testing/plan-host';
import { systemRandomBytes } from './aes-gcm';
import { CLOSE_GRACE_MILLISECONDS, startHostServer } from './host-server';
import type { StartTimer } from './secure-connection';

const UPGRADE_REQUEST = [
  'GET / HTTP/1.1',
  'Host: 127.0.0.1',
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
  '',
  '',
].join('\r\n');

/** Builds a timer the test fires by hand, recording each one started. */
function manualTimers() {
  const started: { readonly milliseconds: number; readonly fire: () => void }[] = [];
  /** Records a timer without starting it. */
  const startTimer: StartTimer = (milliseconds, onEnd) => {
    started.push({ milliseconds, fire: onEnd });
    return () => undefined;
  };
  return { started, startTimer };
}

describe('closing the server of a shared plan', () => {
  it('cuts a guest that never answers the close once the grace delay is over', async () => {
    const timers = manualTimers();
    const started = await startHostServer({
      port: await freePort(),
      planKey: null,
      knownDigests: new Map(),
      startTimer: timers.startTimer,
      randomBytes: systemRandomBytes,
      now: spacedClock(),
      identity: null,
      events: {
        joined: () => undefined,
        message: () => undefined,
        left: () => undefined,
        codeChanged: () => undefined,
      },
    });
    if (!started.ok) {
      throw new Error(started.error);
    }
    const silent = connect(started.value.port, LOOPBACK);
    let answer = '';
    let isCut = false;
    silent.on('data', (data) => {
      answer += data.toString('latin1');
    });
    silent.on('close', () => {
      isCut = true;
    });
    silent.write(UPGRADE_REQUEST);
    await until(() => answer.startsWith('HTTP/1.1 101'));
    let isClosed = false;
    const closing = started.value.close().then(() => {
      isClosed = true;
    });
    await until(() =>
      timers.started.some((timer) => timer.milliseconds === CLOSE_GRACE_MILLISECONDS),
    );
    expect([isClosed, isCut]).toEqual([false, false]);
    timers.started.find((timer) => timer.milliseconds === CLOSE_GRACE_MILLISECONDS)?.fire();
    await closing;
    await until(() => isCut);
    expect([isClosed, isCut]).toEqual([true, true]);
  });
});
