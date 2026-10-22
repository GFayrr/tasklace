import { SUCCESSION_TURN_MILLISECONDS } from '../../core/collaboration/succession';
import type { Endpoint } from '../../core/collaboration/participants';
import type { NearbyPlan } from './discovery';
import type { StartTimer } from './secure-connection';

export interface SuccessionCandidate {
  readonly participantId: string;
  readonly rank: number;
  readonly endpoint: Endpoint | null;
}

export interface SuccessionOptions {
  readonly queue: readonly SuccessionCandidate[];
  readonly me: string;
  readonly sharingId: string;
  readonly startTimer: StartTimer;
  readonly watchHosts: (heard: (plans: readonly NearbyPlan[]) => void) => () => void;
  readonly attempt: (addresses: readonly string[], port: number) => void;
  readonly host: (() => Promise<boolean>) | null;
}

export interface Succession {
  readonly stop: () => void;
}

/** Looks for the next host of a plan whose host left: tries any host of the plan heard nearby, and gives each candidate its turn, trying where it could host, or hosting on this window's turn, a failure leaving the next turn to come. */
export function startSuccession(options: SuccessionOptions): Succession {
  const tried = new Set<string>();
  let isStopped = false;
  /** Tries the hosts of the plan heard on the network, each once. */
  const heard = (plans: readonly NearbyPlan[]): void => {
    for (const plan of plans) {
      if (!isStopped && plan.sharingId === options.sharingId && !tried.has(plan.key)) {
        tried.add(plan.key);
        options.attempt(plan.addresses, plan.port);
      }
    }
  };
  /** Gives a candidate its turn: this window hosts, another is tried where it said it could host. */
  const turn = (candidate: SuccessionCandidate): void => {
    if (isStopped) {
      return;
    }
    if (candidate.participantId === options.me) {
      if (options.host !== null) {
        void hostOrLetPass(options.host);
      }
      return;
    }
    if (candidate.endpoint !== null) {
      options.attempt(candidate.endpoint.addresses, candidate.endpoint.port);
    }
  };
  /** Hosts the plan, stopping the succession once hosting, and logging a failure so that the next turn comes. */
  const hostOrLetPass = async (host: () => Promise<boolean>): Promise<void> => {
    if (await host()) {
      stop();
      return;
    }
    console.warn('This window could not host the shared plan; the next one in turn will.');
  };
  const timers = options.queue.map((candidate, index) =>
    options.startTimer(index * SUCCESSION_TURN_MILLISECONDS, () => {
      turn(candidate);
    }),
  );
  const stopWatching = options.watchHosts(heard);
  /** Stops every turn still to come and the listening. */
  const stop = (): void => {
    isStopped = true;
    timers.forEach((stopTimer) => {
      stopTimer();
    });
    stopWatching();
  };
  return { stop };
}
