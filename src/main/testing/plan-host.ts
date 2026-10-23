import { createServer } from 'node:net';
import { expect } from 'vitest';
import {
  encodeMessage,
  readMessage,
  type CollaborationMessage,
} from '../../core/collaboration/messages';
import { requireParticipantId, type ParticipantId } from '../../core/collaboration/participants';
import { createHost } from '../../core/collaboration/sync';
import type { SharedSession } from '../../core/shared/shared-session';
import { systemRandomBytes } from '../collaboration/aes-gcm';
import { startHostServer, type Peer } from '../collaboration/host-server';

export const LOOPBACK = '127.0.0.1';
const HOUR_MILLISECONDS = 3_600_000;

/** Gives a clock that moves an hour each time it is read, so that the limits of a host on how fast connections come never stop a test that opens many on purpose. */
export function spacedClock(): () => number {
  let time = 0;
  return () => {
    time += HOUR_MILLISECONDS;
    return time;
  };
}
const HOST = requireParticipantId('host');
const POLL_MILLISECONDS = 5;

/** Finds a port nobody listens on, by letting the system choose one and freeing it. */
export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      probe.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });
}

/** Waits until a condition holds, checking at each turn of the event loop. */
export async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
  }
}

/** Reads a message that a test expects to be well formed. */
export function messageOf(bytes: Uint8Array): CollaborationMessage {
  const read = readMessage(bytes);
  if (!read.ok) {
    throw new Error(read.error);
  }
  return read.value;
}

/** Starts a real host server on a free port that shares a session, merging what its guests send and passing it on, each guest being let edit when told so, and recording the refusals it reports. */
export async function startPlanHost(
  session: SharedSession,
  options: { readonly planKey: Uint8Array | null; readonly letEdit: boolean },
) {
  const peers = new Map<ParticipantId, Peer>();
  const ids = new Map<number, ParticipantId>();
  const refusals: string[] = [];
  const host = createHost({
    session,
    roster: null,
    tokenDigest: null,
    hostId: HOST,
    name: 'Camille',
    send: ({ to, message }) => {
      peers.get(to)?.send(encodeMessage(message));
    },
    report: (event) => {
      if (event.kind === 'refused') {
        refusals.push(event.reason);
      }
    },
  });
  const started = await startHostServer({
    port: await freePort(),
    planKey: options.planKey,
    knownTokens: new Map(),
    startTimer: () => () => undefined,
    randomBytes: systemRandomBytes,
    identity: null,
    now: spacedClock(),
    events: {
      joined: (peer, introduction) => {
        const id = introduction.participantId;
        peers.set(id, peer);
        ids.set(peer.number, id);
        expect(host.connect(id, introduction.name, null, null).ok).toBe(true);
        if (options.letEdit) {
          expect(host.setRight(id, true).ok).toBe(true);
        }
      },
      message: (peer, bytes) => {
        const from = ids.get(peer.number);
        if (from !== undefined) {
          host.receive(from, messageOf(bytes));
        }
      },
      left: (peer) => {
        const id = ids.get(peer.number);
        if (id !== undefined && peers.get(id) === peer) {
          peers.delete(id);
          host.disconnect(id);
        }
      },
      codeChanged: () => undefined,
    },
  });
  if (!started.ok) {
    throw new Error(started.error);
  }
  return { server: started.value, refusals };
}
