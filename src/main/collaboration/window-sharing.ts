import { isPort } from '../../core/collaboration/ports';
import {
  tokenDigestOf,
  type Introduction,
  type JoinSecret,
} from '../../core/collaboration/secure/link';
import { sharingIdOf } from '../../core/collaboration/succession';
import { success, type Result } from '../../core/result';
import type { CollaborationEvent, Sharing } from '../../preload/bridge-contract';
import { systemRandomBytes } from './aes-gcm';
import { findPlans, type Mdns, type NearbyPlan } from './discovery';
import { connectAsGuest, isHostAddress } from './guest-client';
import { startGuestSession, type GuestSession } from './guest-session';
import type { ListenFailure } from './host-server';
import { startHosting, type Hosting } from './hosting';
import type { StartTimer } from './secure-connection';
import { startSuccession, type Succession, type SuccessionCandidate } from './succession-driver';

export interface WindowContext {
  readonly tell: (event: CollaborationEvent) => void;
  readonly startTimer: StartTimer;
  readonly mdns: () => Mdns;
  readonly addresses: () => readonly string[];
  readonly instance: () => string;
}

export interface PlanNames {
  readonly planName: string;
  readonly hostName: string;
}

export type WindowState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'hosting';
      readonly hosting: Hosting;
      readonly identity: Introduction;
    }
  | { readonly kind: 'guest'; readonly session: GuestSession; readonly identity: Introduction }
  | {
      readonly kind: 'searching';
      readonly succession: Succession;
      readonly attempts: Set<GuestSession>;
      readonly identity: Introduction;
      readonly planKey: Uint8Array;
    };

export interface WindowSharing {
  readonly state: () => WindowState;
  readonly host: (
    names: PlanNames,
    identity: Introduction,
    port: number,
  ) => Promise<Result<Sharing, ListenFailure>>;
  readonly join: (
    target: { address: string; port: number; code: string },
    identity: Introduction,
  ) => void;
  readonly succeed: (
    queue: readonly SuccessionCandidate[],
    names: PlanNames,
    port: number,
    knownTokens: ReadonlyMap<string, string>,
  ) => boolean;
  readonly stop: () => Promise<void>;
}

/** Runs what one window shares or joined: hosting a plan, joining a host, looking for the next host once the host left, and giving way to an older host of the same plan, each step telling the page. */
export function createWindowSharing(context: WindowContext): WindowSharing {
  let state: WindowState = { kind: 'idle' };
  /** Reads what the window does now, which may have changed while waiting. */
  const stateNow = (): WindowState => state;
  /** Hosts the plan with a key and a rank, giving way to an older host of the same plan once one is heard, the caller making it what the window does. */
  const startHostingAs = (
    names: PlanNames,
    options: {
      readonly port: number;
      readonly planKey: Uint8Array | null;
      readonly knownTokens: ReadonlyMap<string, string>;
      readonly rank: number;
    },
  ): Promise<Result<Hosting, ListenFailure>> =>
    startHosting({
      ...options,
      ...names,
      instance: context.instance(),
      startTimer: context.startTimer,
      mdns: context.mdns,
      tell: context.tell,
      olderHost: (older, planKey) => {
        void giveWay(older, planKey);
      },
    });
  /** Describes the plan a window hosts for the page, with the digest of the token of its host. */
  const sharingOf = (hosting: Hosting, identity: Introduction): Sharing => ({
    code: hosting.server.code(),
    port: hosting.server.port,
    addresses: context.addresses(),
    tokenDigest: tokenDigestOf(identity.token),
  });
  /** Joins a host with a secret, following what the connection tells. */
  const joinWith = (
    target: { readonly address: string; readonly port: number; readonly secret: JoinSecret },
    identity: Introduction,
    tell: (session: GuestSession, event: CollaborationEvent) => void,
  ): GuestSession => {
    const session: GuestSession = startGuestSession({
      ...target,
      introduction: identity,
      startTimer: context.startTimer,
      connect: (options) => connectAsGuest({ ...options, randomBytes: systemRandomBytes }),
      tell: (event) => {
        tell(session, event);
      },
      ended: () => {
        if (state.kind === 'searching') {
          state.attempts.delete(session);
        } else if (state.kind === 'guest' && state.session === session) {
          state = { kind: 'idle' };
        }
      },
    });
    return session;
  };
  /** Passes to the page what the session the window follows tells, and nothing of another. */
  const tellIfFollowed = (session: GuestSession, event: CollaborationEvent): void => {
    if (state.kind === 'guest' && state.session === session) {
      context.tell(event);
    }
  };
  /** Takes the first connection that opens while searching as the one the window follows, closing the other attempts and the search. */
  const tellOrAdopt = (session: GuestSession, event: CollaborationEvent): void => {
    if (state.kind !== 'searching') {
      tellIfFollowed(session, event);
      return;
    }
    if (event.kind !== 'connected') {
      return;
    }
    state.succession.stop();
    state.attempts.forEach((other) => {
      if (other !== session) {
        other.close();
      }
    });
    state = { kind: 'guest', session, identity: state.identity };
    context.tell(event);
  };
  /** Starts a search for the next host with a key, the given queue of candidates and, when this window may host, the names it announces, giving how to try a host found otherwise. */
  const search = (
    planKey: Uint8Array,
    identity: Introduction,
    queue: readonly SuccessionCandidate[],
    hosting: {
      readonly names: PlanNames;
      readonly port: number;
      readonly knownTokens: ReadonlyMap<string, string>;
    } | null,
  ): ((addresses: readonly string[], port: number) => void) => {
    const attempts = new Set<GuestSession>();
    /** Tries to join a host at a few addresses with the key, each one valid. */
    const attempt = (addresses: readonly string[], port: number): void => {
      for (const address of addresses.filter((each) => isHostAddress(each) && isPort(port))) {
        attempts.add(
          joinWith({ address, port, secret: { kind: 'key', key: planKey } }, identity, tellOrAdopt),
        );
      }
    };
    /** Hosts the plan with the key on this window's turn, giving it up when another connection was taken meanwhile. */
    const hostHere = async (place: NonNullable<typeof hosting>, rank: number): Promise<boolean> => {
      const hosted = await startHostingAs(place.names, {
        port: place.port,
        planKey,
        knownTokens: place.knownTokens,
        rank,
      });
      if (!hosted.ok) {
        console.warn(`The shared plan could not be hosted here: ${hosted.error}.`);
        return false;
      }
      const now = stateNow();
      if (now.kind !== 'searching' || now.attempts !== attempts) {
        await hosted.value.stop();
        return true;
      }
      attempts.forEach((other) => {
        other.close();
      });
      state = { kind: 'hosting', hosting: hosted.value, identity };
      context.tell({ kind: 'becameHost', sharing: sharingOf(hosted.value, identity) });
      return true;
    };
    const me = queue.find((candidate) => candidate.participantId === identity.participantId);
    const succession = startSuccession({
      queue,
      me: identity.participantId,
      sharingId: sharingIdOf(planKey),
      startTimer: context.startTimer,
      watchHosts: (heard) => watchSafely(context, heard),
      attempt,
      host: hosting === null || me === undefined ? null : () => hostHere(hosting, me.rank),
    });
    state = { kind: 'searching', succession, attempts, identity, planKey };
    return attempt;
  };
  /** Stops hosting for an older host of the same plan, which the guests of this window then find too, and joins it with the key. */
  const giveWay = async (older: NearbyPlan, planKey: Uint8Array): Promise<void> => {
    if (state.kind !== 'hosting') {
      return;
    }
    const { hosting, identity } = state;
    const attempt = search(planKey, identity, [], null);
    context.tell({ kind: 'yielded' });
    attempt(older.addresses, older.port);
    await hosting.stop();
  };

  /** Stops whatever the window does now. */
  const stopCurrent = async (): Promise<void> => {
    const current = state;
    state = { kind: 'idle' };
    if (current.kind === 'guest') {
      current.session.close();
    }
    if (current.kind === 'searching') {
      current.succession.stop();
      current.attempts.forEach((session) => {
        session.close();
      });
    }
    if (current.kind === 'hosting') {
      await current.hosting.stop();
    }
  };
  return {
    state: () => state,
    host: async (names, identity, port) => {
      const hosted = await startHostingAs(names, {
        port,
        planKey: null,
        knownTokens: new Map(),
        rank: 0,
      });
      if (!hosted.ok) {
        return hosted;
      }
      state = { kind: 'hosting', hosting: hosted.value, identity };
      return success(sharingOf(hosted.value, identity));
    },
    join: (target, identity) => {
      const session = joinWith(
        { address: target.address, port: target.port, secret: { kind: 'code', code: target.code } },
        identity,
        tellIfFollowed,
      );
      state = { kind: 'guest', session, identity };
    },
    succeed: (queue, names, port, knownTokens) => {
      if (state.kind !== 'guest' && state.kind !== 'searching') {
        return false;
      }
      const planKey = state.kind === 'guest' ? state.session.planKey() : state.planKey;
      if (planKey === null) {
        return false;
      }
      const { identity } = state;
      void stopCurrent();
      search(planKey, identity, queue, { names, port, knownTokens });
      return true;
    },
    stop: stopCurrent,
  };
}

/** Listens for the hosts announced nearby, a network that refuses mDNS being only logged since the addresses of the candidates are tried too. */
function watchSafely(
  context: WindowContext,
  heard: (plans: readonly NearbyPlan[]) => void,
): () => void {
  try {
    return findPlans(context.mdns(), heard);
  } catch (error) {
    console.warn('The shared plan could not look for its next host on the network:', error);
    return () => undefined;
  }
}
