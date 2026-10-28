import type { RelayCrypto } from '../../core/collaboration/relay/relay-envelope';
import type { RelayKeys } from '../../core/collaboration/relay/relay-keys';
import { readRelayLog } from '../../core/collaboration/relay/relay-log';
import { createRelayMember, type RelayMember } from '../../core/collaboration/relay/relay-member';
import { openSharedSessionFromState, type SharedSession } from '../../core/shared/shared-session';
import { aesGcm, systemRandomBytes } from '../collaboration/aes-gcm';
import { startRelaySession, type RelaySession } from '../collaboration/relay/relay-connection';
import type { StartTimer } from '../collaboration/secure-connection';
import { zlibCompressor } from '../zlib-compressor';
import { LOOPBACK, until } from './plan-host';

export interface RelayTeamMember {
  readonly session: SharedSession;
  readonly member: RelayMember;
  readonly connection: RelaySession;
  readonly isCaughtUp: () => boolean;
  readonly isSettled: () => boolean;
  readonly snapshotsSent: () => number;
  readonly problems: readonly string[];
  readonly leave: () => void;
}

export interface RelayTeamOptions {
  readonly port: number;
  readonly session: SharedSession;
  readonly keys: RelayKeys;
  readonly creates: boolean;
}

export const RELAY_TEST_CRYPTO: RelayCrypto = {
  aead: aesGcm,
  compression: zlibCompressor,
  randomBytes: systemRandomBytes,
};

/** Runs the waits of a session as they are, so that coming back and the heartbeat work as in the application. */
export const realTimer: StartTimer = (milliseconds, onEnd) => {
  const timer = setTimeout(onEnd, milliseconds);
  return () => {
    clearTimeout(timer);
  };
};

/** Follows the plan of a session through a relay as the page and the main process do, the creator sharing the whole plan once in, noting every refusal, loss or end, and telling once the relay passed back all it sent. */
export function joinThroughRelay(options: RelayTeamOptions): RelayTeamMember {
  const { session, keys, creates } = options;
  const problems: string[] = [];
  let caughtUp = false;
  let shared = !creates;
  const unsettled = new Set<string>();
  let snapshots = 0;
  let connection: RelaySession | null = null;
  const member = createRelayMember({
    session,
    canEdit: keys.sign !== null,
    bytesSinceSnapshot: 0,
    randomBytes: systemRandomBytes,
    send: (outgoing) => {
      if (outgoing.kind === 'message') {
        unsettled.add(Buffer.from(outgoing.message.messageId).toString('hex'));
        snapshots += outgoing.message.kind === 'snapshot' ? 1 : 0;
      }
      const sent = connection?.send(outgoing);
      if (sent?.ok !== true) {
        problems.push(`not sent ${sent?.error ?? 'NO_CONNECTION'}`);
      }
    },
    report: (event) => {
      if (event.kind === 'refused') {
        problems.push(`refused ${event.reason}`);
      }
      if (event.kind === 'unsharedChanges') {
        problems.push(event.kind);
      }
    },
  });
  connection = startRelaySession({
    address: { host: LOOPBACK, port: options.port, path: '/' },
    keys,
    creates,
    keepTrying: false,
    crypto: RELAY_TEST_CRYPTO,
    startTimer: realTimer,
    tell: (event) => {
      switch (event.kind) {
        case 'delivery':
          unsettled.delete(Buffer.from(event.delivery.messageId).toString('hex'));
          member.receive(event.delivery);
          return;
        case 'caughtUp':
          if (!shared) {
            shared = true;
            member.shareWholePlan();
          }
          member.caughtUp();
          caughtUp = true;
          return;
        case 'presence':
          member.presence(event.member, event.presence);
          return;
        case 'left':
          member.left(event.member);
          return;
        case 'reconnecting':
        case 'offline':
          member.disconnected();
          problems.push(event.kind);
          return;
        case 'ended':
          member.disconnected();
          problems.push(`ended ${event.reason}`);
          return;
        default:
      }
    },
  });
  const opened = connection;
  return {
    session,
    member,
    connection: opened,
    isCaughtUp: () => caughtUp,
    isSettled: () => caughtUp && unsettled.size === 0,
    snapshotsSent: () => snapshots,
    problems,
    leave: () => {
      member.stop();
      opened.close();
    },
  };
}

/** Joins a room of a relay of this computer as a newcomer would, gathering every message it holds until caught up, and opens the plan they make as the application opens a joined plan. */
export async function newcomerPlan(
  port: number,
  keys: RelayKeys,
): Promise<{ readonly session: SharedSession; readonly problems: readonly string[] }> {
  const messages: Uint8Array[] = [];
  const problems: string[] = [];
  let caughtUp = false;
  const connection = startRelaySession({
    address: { host: LOOPBACK, port, path: '/' },
    keys,
    creates: false,
    keepTrying: false,
    crypto: RELAY_TEST_CRYPTO,
    startTimer: realTimer,
    tell: (event) => {
      if (event.kind === 'delivery') {
        messages.push(event.delivery.bytes);
      } else if (event.kind === 'caughtUp') {
        caughtUp = true;
      } else if (event.kind === 'reconnecting' || event.kind === 'offline') {
        problems.push(event.kind);
      } else if (event.kind === 'ended') {
        problems.push(`ended ${event.reason}`);
      }
    },
  });
  try {
    await until(() => caughtUp);
  } finally {
    connection.close();
  }
  const read = readRelayLog(messages);
  if (!read.ok) {
    throw new Error(`The log of the relay did not read: ${JSON.stringify(read.error)}`);
  }
  const opened = openSharedSessionFromState(read.value.state);
  if (!opened.ok) {
    throw new Error(`The plan of the relay did not open: ${JSON.stringify(opened.error)}`);
  }
  return { session: opened.value, problems };
}
