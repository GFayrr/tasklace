import type { TokenDigest } from '../../core/collaboration/secure/token-digest';
import type { ParticipantId } from '../../core/collaboration/participants';
import { isPort } from '../../core/collaboration/ports';
import {
  tokenDigestOf,
  type Introduction,
  type JoinSecret,
  type PlanKey,
} from '../../core/collaboration/secure/link';
import type { JoinCode } from '../../core/collaboration/secure/join-code';
import { isOlder } from '../../core/collaboration/roster';
import { sharingIdOf } from '../../core/collaboration/succession';
import { success, type Result } from '../../core/result';
import type { CollaborationEvent, KnownToken, Sharing } from '../../preload/bridge-contract';
import { findPlans, type Mdns, type NearbyPlan } from './discovery';
import { connectAsGuest } from './guest-client';
import { startGuestSession, type GuestSession } from './guest-session';
import type { ListenFailure } from './host-server';
import { startHosting, type Hosting } from './hosting';
import { isPrivateAddress } from './private-addresses';
import type { StartTimer } from './secure-connection';
import { startSuccession, type Succession, type SuccessionCandidate } from './succession-driver';

export interface WindowContext {
  readonly tell: (event: CollaborationEvent) => void;
  readonly startTimer: StartTimer;
  readonly now: () => number;
  readonly mdns: () => Mdns;
  readonly addresses: () => readonly string[];
  readonly instance: () => string;
  readonly randomBytes: (count: number) => Uint8Array;
}

export type WindowStateView =
  | Exclude<WindowState, { readonly kind: 'searching' }>
  | (Omit<Extract<WindowState, { readonly kind: 'searching' }>, 'attempts'> & {
      readonly attempts: ReadonlySet<GuestSession>;
    });

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
      readonly takenOver: TakenOver | null;
    }
  | { readonly kind: 'guest'; readonly session: GuestSession; readonly identity: Introduction }
  | {
      readonly kind: 'searching';
      readonly succession: Succession;
      readonly attempts: Set<GuestSession>;
      readonly identity: Introduction;
      readonly planKey: PlanKey;
    };

export interface TakenOver {
  readonly people: readonly KnownToken[];
  readonly rank: number;
}

export interface WindowSharing {
  readonly state: () => WindowStateView;
  readonly host: (
    names: PlanNames,
    identity: Introduction,
    port: number,
  ) => Promise<Result<Sharing, ListenFailure>>;
  readonly join: (
    target: { address: string; port: number; code: JoinCode },
    identity: Introduction,
  ) => void;
  readonly succeed: (
    queue: readonly SuccessionCandidate[],
    names: PlanNames,
    port: number,
    knownPeople: readonly KnownToken[],
  ) => boolean;
  readonly stop: () => Promise<void>;
}

/** Runs what one window shares or joined: hosting a plan, joining a host, looking for the next host once the host left, and giving way to an older host of the same plan, each step telling the page. */
export function createWindowSharing(context: WindowContext): WindowSharing {
  let state: WindowState = { kind: 'idle' };
  const probes = new Set<GuestSession>();
  /** Reads what the window does now, which may have changed while waiting. */
  const stateNow = (): WindowState => state;
  /** Hosts the plan with a key and a rank, giving way to an older host of the same plan once one is heard, the caller making it what the window does. */
  const startHostingAs = (
    names: PlanNames,
    options: {
      readonly port: number;
      readonly planKey: PlanKey | null;
      readonly knownTokens: ReadonlyMap<ParticipantId, TokenDigest>;
      readonly identity: Introduction;
      readonly rank: number;
    },
  ): Promise<Result<Hosting, ListenFailure>> =>
    startHosting({
      ...options,
      ...names,
      instance: context.instance(),
      startTimer: context.startTimer,
      now: context.now,
      randomBytes: context.randomBytes,
      mdns: context.mdns,
      tell: context.tell,
      olderHost: (older, planKey) => {
        giveWay(older, planKey);
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
    ended: (session: GuestSession) => void = forgetEnded,
    identified?: (session: GuestSession, host: Introduction | null) => void,
  ): GuestSession => {
    const session: GuestSession = startGuestSession({
      ...target,
      introduction: identity,
      startTimer: context.startTimer,
      connect: (options) => connectAsGuest({ ...options, randomBytes: context.randomBytes }),
      tell: (event) => {
        tell(session, event);
      },
      ended: () => {
        ended(session);
      },
      identity: (host) => {
        identified?.(session, host);
      },
    });
    return session;
  };
  /** Forgets a connection that ended for good: an attempt of the search, or the one the window follows. */
  const forgetEnded = (session: GuestSession): void => {
    if (state.kind === 'searching') {
      state.attempts.delete(session);
    } else if (state.kind === 'guest' && state.session === session) {
      state = { kind: 'idle' };
    }
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
  /** Starts a search for the next host with a key, the given queue of candidates, and the names and port this window announces if its turn comes. */
  const search = (
    planKey: PlanKey,
    identity: Introduction,
    queue: readonly SuccessionCandidate[],
    hosting: {
      readonly names: PlanNames;
      readonly port: number;
      readonly knownPeople: readonly KnownToken[];
    },
  ): void => {
    const attempts = new Set<GuestSession>();
    /** Tries to join a host with the key at the few private addresses it gave, never at a name or a public address that someone in the plan may have written. */
    const attempt = (addresses: readonly string[], port: number): void => {
      for (const address of addresses.filter((each) => isPrivateAddress(each) && isPort(port))) {
        attempts.add(
          joinWith({ address, port, secret: { kind: 'key', key: planKey } }, identity, tellOrAdopt),
        );
      }
    };
    /** Hosts the plan with the key on this window's turn, giving it up when another connection was taken meanwhile. */
    const hostHere = async (place: typeof hosting, rank: number): Promise<boolean> => {
      const hosted = await startHostingAs(place.names, {
        port: place.port,
        planKey,
        knownTokens: new Map(
          place.knownPeople.map(({ participantId, tokenDigest }) => [participantId, tokenDigest]),
        ),
        identity,
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
      const takenOver = { people: place.knownPeople, rank };
      state = { kind: 'hosting', hosting: hosted.value, identity, takenOver };
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
      host: me === undefined ? null : () => hostHere(hosting, me.rank),
    });
    state = { kind: 'searching', succession, attempts, identity, planKey };
  };
  /** Closes every attempt to join an older host but the one given. */
  const closeProbes = (kept: GuestSession | null): void => {
    probes.forEach((probe) => {
      if (probe !== kept) {
        probe.close();
      }
    });
    probes.clear();
  };
  /** Keeps trying to join an older host of the same plan with the key while hosting, and gives way only once that host proved who it is, since anyone holding the key can announce an older rank, the guests of this window then finding it too. */
  const giveWay = (older: NearbyPlan, planKey: PlanKey): void => {
    if (state.kind !== 'hosting') {
      return;
    }
    const { hosting, identity, takenOver } = state;
    if (takenOver === null) {
      console.warn('A host of the same plan claims to be older, but this window shared it first.');
      return;
    }
    const asked = new Set<GuestSession>();
    /** Asks an older host who it is once it sent the first message of the plan, by then knowing the right of this window, and logs a probe refused for good. */
    const tellProbe = (session: GuestSession, event: CollaborationEvent): void => {
      if (event.kind === 'ended' && probes.has(session)) {
        console.warn(`An older host of the shared plan could not be joined: ${event.reason}.`);
      }
      if (event.kind === 'hostMessage' && probes.has(session) && !asked.has(session)) {
        asked.add(session);
        session.askIdentity();
      }
      tellIfFollowed(session, event);
    };
    /** Follows the window into the older host once it proved who it is, or leaves a host that could not. */
    const identified = (session: GuestSession, host: Introduction | null): void => {
      if (state.kind !== 'hosting' || state.hosting !== hosting || !probes.has(session)) {
        return;
      }
      if (!provesOlder(host, takenOver, identity)) {
        console.warn('An older host of the shared plan could not prove who it is.');
        probes.delete(session);
        session.close();
        return;
      }
      closeProbes(session);
      state = { kind: 'guest', session, identity };
      context.tell({ kind: 'yielded' });
      context.tell({ kind: 'connected' });
      hosting.stop().catch((error: unknown) => {
        console.error('The plan given way could not stop being hosted here:', error);
      });
    };
    const port = older.port;
    for (const address of older.addresses.filter(
      (each) => isPrivateAddress(each) && isPort(port),
    )) {
      probes.add(
        joinWith(
          { address, port, secret: { kind: 'key', key: planKey } },
          identity,
          tellProbe,
          (session) => {
            probes.delete(session);
            forgetEnded(session);
          },
          identified,
        ),
      );
    }
  };

  /** Stops whatever the window does now. */
  const stopCurrent = async (): Promise<void> => {
    const current = state;
    state = { kind: 'idle' };
    closeProbes(null);
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
        identity,
        rank: 0,
      });
      if (!hosted.ok) {
        return hosted;
      }
      state = { kind: 'hosting', hosting: hosted.value, identity, takenOver: null };
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
    succeed: (queue, names, port, knownPeople) => {
      if (state.kind !== 'guest' && state.kind !== 'searching') {
        return false;
      }
      const planKey = state.kind === 'guest' ? state.session.planKey() : state.planKey;
      if (planKey === null) {
        return false;
      }
      const { identity } = state;
      void stopCurrent();
      search(planKey, identity, queue, { names, port, knownPeople });
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

/** Tells whether a host proved it is an older person of the plan allowed to edit: its token matches the digest this window knows for it, and it joined before this window. */
function provesOlder(
  host: Introduction | null,
  takenOver: TakenOver,
  identity: Introduction,
): boolean {
  const person = takenOver.people.find(
    ({ participantId }) => participantId === host?.participantId,
  );
  return (
    host !== null &&
    person !== undefined &&
    person.canEdit &&
    person.tokenDigest === tokenDigestOf(host.token) &&
    isOlder(
      { id: person.participantId, rank: person.rank },
      { id: identity.participantId, rank: takenOver.rank },
    )
  );
}
