import { tokenDigestOf, type Introduction } from '../../core/collaboration/secure/link';
import { sharingIdOf, shouldYield } from '../../core/collaboration/succession';
import { failure, success, type Result } from '../../core/result';
import type { CollaborationEvent } from '../../preload/bridge-contract';
import { announcePlan, findPlans, serviceNameOf, type Mdns, type NearbyPlan } from './discovery';
import { startHostServer, type HostServer, type ListenFailure, type Peer } from './host-server';
import type { StartTimer } from './secure-connection';

export interface HostingOptions {
  readonly port: number;
  readonly planKey: Uint8Array | null;
  readonly knownTokens: ReadonlyMap<string, string>;
  readonly identity: Introduction;
  readonly rank: number;
  readonly planName: string;
  readonly hostName: string;
  readonly instance: string;
  readonly startTimer: StartTimer;
  readonly now: () => number;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly mdns: () => Mdns;
  readonly tell: (event: CollaborationEvent) => void;
  readonly olderHost: (host: NearbyPlan, planKey: Uint8Array) => void;
}

export interface Hosting {
  readonly server: HostServer;
  readonly peers: Map<number, Peer>;
  readonly stop: () => Promise<void>;
}

/** Hosts a shared plan: starts the server, passes to the page what happens to its guests, announces the plan with the identifier of its key and its rank, and tells of each older host of the same plan heard. */
export async function startHosting(
  options: HostingOptions,
): Promise<Result<Hosting, ListenFailure>> {
  const peers = new Map<number, Peer>();
  const started = await startHostServer({
    port: options.port,
    planKey: options.planKey,
    knownTokens: options.knownTokens,
    identity: options.identity,
    startTimer: options.startTimer,
    randomBytes: options.randomBytes,
    now: options.now,
    events: {
      joined: (peer, introduction) => {
        peers.set(peer.number, peer);
        options.tell({
          kind: 'peerJoined',
          peer: peer.number,
          participantId: introduction.participantId,
          name: introduction.name,
          endpoint: introduction.endpoint,
          tokenDigest: tokenDigestOf(introduction.token),
        });
      },
      message: (peer, message) => {
        options.tell({ kind: 'peerMessage', peer: peer.number, message });
      },
      left: (peer) => {
        peers.delete(peer.number);
        options.tell({ kind: 'peerLeft', peer: peer.number });
      },
      codeChanged: (code) => {
        options.tell({ kind: 'codeChanged', code });
      },
    },
  });
  if (!started.ok) {
    return failure(started.error);
  }
  const server = started.value;
  const announcement = announceSafely(options, server.port, server.planKey());
  const stopWatching = watchOlderHosts(options, server);
  return success({
    server,
    peers,
    stop: async () => {
      stopWatching();
      await announcement();
      await server.close();
    },
  });
}

/** Announces the plan nearby, a network that refuses mDNS being only logged since people can still type the address. */
function announceSafely(
  options: HostingOptions,
  port: number,
  planKey: Uint8Array,
): () => Promise<void> {
  try {
    return announcePlan(options.mdns(), {
      instance: options.instance,
      port,
      planName: options.planName,
      hostName: options.hostName,
      sharingId: sharingIdOf(planKey),
      rank: options.rank,
    });
  } catch (error) {
    console.warn('The shared plan could not be announced on the network:', error);
    return () => Promise.resolve();
  }
}

/** Listens for another host of the same plan, telling once of each older one heard so that this host may give way, a network that refuses mDNS being only logged. */
function watchOlderHosts(options: HostingOptions, server: HostServer): () => void {
  const me = { id: serviceNameOf(options.instance), rank: options.rank };
  const told = new Set<string>();
  try {
    return findPlans(options.mdns(), (plans) => {
      const sharingId = sharingIdOf(server.planKey());
      const older = plans.filter(
        (plan) =>
          plan.sharingId === sharingId &&
          plan.instance !== me.id &&
          !told.has(plan.key) &&
          shouldYield(me, { id: plan.instance, rank: plan.rank }),
      );
      for (const plan of older) {
        told.add(plan.key);
        options.olderHost(plan, server.planKey());
      }
    });
  } catch (error) {
    console.warn('The shared plan could not look for other hosts on the network:', error);
    return () => undefined;
  }
}
