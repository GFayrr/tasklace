import { describe, expect, it, vi } from 'vitest';
import { requireParticipantId } from '../../core/collaboration/participants';
import type { JoinSecret } from '../../core/collaboration/secure/link';
import { success } from '../../core/result';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import type { GuestEnd, GuestOptions } from './guest-client';
import { startGuestSession } from './guest-session';

const KEY = new Uint8Array(32).fill(5);
const INTRODUCTION = {
  participantId: requireParticipantId('lea'),
  name: 'Léa',
  token: 'ab'.repeat(32),
  endpoint: { addresses: [], port: 47_313 },
};

/** Builds a session on fake connections and timers the test drives by hand, joining with the code unless another secret is given. */
function session(secret: JoinSecret = { kind: 'code', code: 'K7Q4MZ' }) {
  const connections: {
    secret: JoinSecret;
    events: GuestOptions['events'];
    closed: number;
    sent: Uint8Array[];
    asked: number;
  }[] = [];
  const timers: { milliseconds: number; onEnd: () => void; stopped: boolean }[] = [];
  const told: CollaborationEvent[] = [];
  const ended = vi.fn();
  const started = startGuestSession({
    address: '127.0.0.1',
    port: 47_313,
    secret,
    introduction: INTRODUCTION,
    startTimer: (milliseconds, onEnd) => {
      const timer = { milliseconds, onEnd, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
    connect: (options) => {
      const connection = {
        secret: options.secret,
        events: options.events,
        closed: 0,
        sent: [] as Uint8Array[],
        asked: 0,
      };
      connections.push(connection);
      return {
        send: (message) => {
          connection.sent.push(message);
          return success(null);
        },
        askIdentity: () => {
          connection.asked += 1;
        },
        close: () => {
          connection.closed += 1;
        },
      };
    },
    tell: (event) => told.push(event),
    ended,
  });
  /** Gives the latest connection, failing the test when there is none. */
  const latest = () => {
    const connection = connections.at(-1);
    if (connection === undefined) {
      throw new Error('No connection');
    }
    return connection;
  };
  /** Fires the timers still running that last the given time. */
  const fire = (milliseconds: number): void => {
    timers
      .filter((timer) => !timer.stopped && timer.milliseconds === milliseconds)
      .forEach((timer) => {
        timer.stopped = true;
        timer.onEnd();
      });
  };
  /** Opens the latest connection and gives it the key of the plan, as a host does. */
  const admit = (): void => {
    latest().events.opened();
    latest().events.planKey(KEY);
  };
  /** Ends the latest connection for a reason. */
  const lose = (reason: GuestEnd): void => {
    latest().events.ended(reason);
  };
  return { session: started, connections, timers, told, ended, latest, fire, admit, lose };
}

describe('a window joined to a host', () => {
  it('joins with the code, passes what the host sends and sends through the connection', () => {
    const guest = session();
    guest.admit();
    guest.latest().events.message(Uint8Array.of(1));
    expect(guest.session.send(Uint8Array.of(2))).toEqual(success(null));
    expect([guest.connections.map((each) => each.secret), guest.told, guest.latest().sent]).toEqual(
      [
        [{ kind: 'code', code: 'K7Q4MZ' }],
        [{ kind: 'connected' }, { kind: 'hostMessage', message: Uint8Array.of(1) }],
        [Uint8Array.of(2)],
      ],
    );
  });

  it('comes back with the key after a lost connection, waiting longer each time, and says when nobody answers', () => {
    const guest = session();
    guest.admit();
    guest.lose('WIRE_CLOSED');
    expect(
      guest.timers.filter((timer) => !timer.stopped).map((timer) => timer.milliseconds),
    ).toEqual([15_000, 1_000]);
    guest.fire(1_000);
    expect(guest.latest().secret).toEqual({ kind: 'key', key: KEY });
    guest.lose('UNREACHABLE');
    guest.fire(2_000);
    guest.lose('TIMEOUT');
    guest.fire(15_000);
    guest.fire(4_000);
    guest.latest().events.opened();
    expect([guest.connections.length, guest.told, guest.ended.mock.calls]).toEqual([
      4,
      [{ kind: 'connected' }, { kind: 'reconnecting' }, { kind: 'offline' }, { kind: 'connected' }],
      [],
    ]);
    expect(guest.timers.every((timer) => timer.stopped)).toBe(true);
    guest.lose('BROKEN');
    expect(
      guest.timers.filter((timer) => !timer.stopped).map((timer) => timer.milliseconds),
    ).toEqual([15_000, 1_000]);
  });

  it.each([
    'WRONG_CODE',
    'CODE_REPLACED',
    'WRONG_KEY',
    'IDENTITY_TAKEN',
    'NOT_PRIVATE',
    'UNSUPPORTED_VERSION',
    'MALFORMED',
    'INVALID_SHARE',
    'INVALID_INTRODUCTION',
  ] as const)('ends for good on %s, even once in', (reason) => {
    const guest = session();
    guest.admit();
    guest.lose(reason);
    expect([guest.told.at(-1), guest.ended.mock.calls.length, guest.connections.length]).toEqual([
      { kind: 'ended', reason },
      1,
      1,
    ]);
  });

  it('ends for good when the connection ends before it opened, or before the host gave the key', () => {
    const before = session();
    before.lose('UNREACHABLE');
    const withoutKey = session();
    withoutKey.latest().events.opened();
    withoutKey.lose('WIRE_CLOSED');
    expect([before.told, withoutKey.told.at(-1)]).toEqual([
      [{ kind: 'ended', reason: 'UNREACHABLE' }],
      { kind: 'ended', reason: 'WIRE_CLOSED' },
    ]);
  });

  it('keeps trying a host it joins with the key until it answers, as when looking for the next host', () => {
    const search = session({ kind: 'key', key: KEY });
    search.lose('UNREACHABLE');
    search.fire(1_000);
    search.lose('WIRE_CLOSED');
    search.fire(2_000);
    search.admit();
    expect([
      search.told,
      search.connections.map((each) => each.secret),
      search.ended.mock.calls,
    ]).toEqual([
      [{ kind: 'reconnecting' }, { kind: 'connected' }],
      [
        { kind: 'key', key: KEY },
        { kind: 'key', key: KEY },
        { kind: 'key', key: KEY },
      ],
      [],
    ]);
  });

  it('stops when the page leaves, ignoring what a closed or older connection tells afterwards', () => {
    const guest = session();
    guest.admit();
    guest.lose('WIRE_CLOSED');
    guest.fire(1_000);
    guest.connections[0]?.events.ended('BROKEN');
    expect(guest.told).toEqual([{ kind: 'connected' }, { kind: 'reconnecting' }]);
    guest.session.close();
    guest.lose('CLOSED');
    expect([
      guest.latest().closed,
      guest.timers.every((timer) => timer.stopped),
      guest.told.length,
      guest.ended.mock.calls,
    ]).toEqual([1, true, 2, []]);
  });
});
