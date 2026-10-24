import { requireParticipantId } from '../../core/collaboration/participants';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NearbyPlan } from './discovery';
import { startSuccession, type SuccessionCandidate } from './succession-driver';

const SHARING = 'a'.repeat(32);
const ENDPOINT = { addresses: ['192.168.1.30'], port: 47_313 };
const QUEUE: readonly SuccessionCandidate[] = [
  { participantId: requireParticipantId('lea'), rank: 1, endpoint: ENDPOINT },
  { participantId: requireParticipantId('me'), rank: 2, endpoint: null },
  { participantId: requireParticipantId('noah'), rank: 3, endpoint: null },
];

afterEach(() => {
  vi.restoreAllMocks();
});

/** Builds a plan heard on the network. */
function heardPlan(key: string, sharingId = SHARING): NearbyPlan {
  return {
    key,
    instance: key,
    planName: 'Thesis',
    hostName: 'Léa',
    sharingId,
    rank: 1,
    addresses: ['192.168.1.40'],
    port: 47_314,
  };
}

/** Runs a succession on timers and a network the test drives by hand. */
function succession(hosts: boolean[] = [true]) {
  const timers: { milliseconds: number; onEnd: () => void; stopped: boolean }[] = [];
  const attempts: [readonly string[], number][] = [];
  let listener: ((plans: readonly NearbyPlan[]) => void) | null = null;
  let watching = true;
  const host = vi.fn(() => Promise.resolve(hosts.shift() ?? false));
  const started = startSuccession({
    queue: QUEUE,
    me: requireParticipantId('me'),
    sharingId: SHARING,
    startTimer: (milliseconds, onEnd) => {
      const timer = { milliseconds, onEnd, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
    watchHosts: (heard) => {
      listener = heard;
      return () => {
        watching = false;
      };
    },
    attempt: (addresses, port) => attempts.push([addresses, port]),
    host,
  });
  /** Fires the turn that starts after a time. */
  const fire = (milliseconds: number): void => {
    timers.find((timer) => timer.milliseconds === milliseconds && !timer.stopped)?.onEnd();
  };
  return {
    started,
    timers,
    attempts,
    host,
    fire,
    hear: (plans: readonly NearbyPlan[]) => listener?.(plans),
    isWatching: () => watching,
  };
}

describe('the search for the next host', () => {
  it('gives each candidate its turn, fifteen seconds apart, trying where an older one said it could host', () => {
    const search = succession();
    expect(search.timers.map((timer) => timer.milliseconds)).toEqual([0, 15_000, 30_000]);
    search.fire(0);
    expect(search.attempts).toEqual([[ENDPOINT.addresses, ENDPOINT.port]]);
  });

  it('hosts on its own turn, then stops every turn left and the listening', async () => {
    const search = succession([true]);
    search.fire(15_000);
    await Promise.resolve();
    await Promise.resolve();
    expect([
      search.host.mock.calls.length,
      search.timers.every((timer) => timer.stopped),
      search.isWatching(),
    ]).toEqual([1, true, false]);
  });

  it('lets the next turn come when it cannot host, telling it in the log', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const search = succession([false]);
    search.fire(15_000);
    await Promise.resolve();
    await Promise.resolve();
    expect([search.timers[2]?.stopped, search.isWatching(), warnings.mock.calls]).toEqual([
      false,
      true,
      [['This window could not host the shared plan; it keeps looking for the next host.']],
    ]);
  });

  it('logs a failure while hosting on its own turn, the search going on', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search = succession();
    const failed = new Error('hosting broke');
    search.host.mockImplementationOnce(() => Promise.reject(failed));
    search.fire(15_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect([search.isWatching(), errors.mock.calls]).toEqual([
      true,
      [['This window failed while trying to host the shared plan:', failed]],
    ]);
  });

  it('tries each host of the plan heard on the network once, ignoring other plans and anything once stopped', () => {
    const search = succession();
    search.hear([heardPlan('one'), heardPlan('other', 'b'.repeat(32))]);
    search.hear([heardPlan('one'), heardPlan('two')]);
    search.started.stop();
    search.hear([heardPlan('three')]);
    search.fire(0);
    expect(search.attempts).toEqual([
      [['192.168.1.40'], 47_314],
      [['192.168.1.40'], 47_314],
    ]);
  });

  it('lets its own turn pass when this window cannot host', () => {
    const timers: (() => void)[] = [];
    const attempt = vi.fn();
    startSuccession({
      queue: QUEUE,
      me: requireParticipantId('me'),
      sharingId: SHARING,
      startTimer: (_milliseconds, onEnd) => {
        timers.push(onEnd);
        return () => undefined;
      },
      watchHosts: () => () => undefined,
      attempt,
      host: null,
    });
    timers[1]?.();
    expect(attempt.mock.calls).toEqual([]);
  });

  it('skips a candidate that said nowhere to try', () => {
    const search = succession();
    search.fire(30_000);
    expect([search.attempts, search.host.mock.calls]).toEqual([[], []]);
  });
});
