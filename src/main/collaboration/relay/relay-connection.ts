import { getCACertificates } from 'node:tls';
import { WebSocket, type RawData } from 'ws';
import {
  OFFLINE_AFTER_MILLISECONDS,
  reconnectDelay,
} from '../../../core/collaboration/reconnection';
import {
  createRelayAssembler,
  openRelayPresence,
  sealRelayMessage,
  sealRelayPresence,
  type OpenedPresence,
  type RecordRefusal,
  type RelayCrypto,
  type SealRefusal,
} from '../../../core/collaboration/relay/relay-envelope';
import type { RelayKeys } from '../../../core/collaboration/relay/relay-keys';
import {
  hostLabelOf,
  relayUrlOf,
  type RelayAddress,
} from '../../../core/collaboration/relay/relay-link';
import type { RelayDelivery, RelayOutgoing } from '../../../core/collaboration/relay/relay-member';
import {
  encodeClientFrame,
  MAX_RELAY_FRAME_BYTES,
  readRelayFrame,
  signedCloseBytes,
  signedCreateBytes,
  type ClientFrame,
  type RelayFrame,
  type RelayRefusal,
} from '../../../core/collaboration/relay/relay-wire';
import { MAX_HANDSHAKE_MILLISECONDS } from '../../../core/limits';
import { isOneOf } from '../../../core/one-of';
import { failure, success, type Result } from '../../../core/result';
import { watchHeartbeat } from '../heartbeat';
import { bytesOf } from '../host-server';
import type { StartTimer } from '../secure-connection';

export type RelayEnd = RelayRefusal | 'CLOSED' | 'UNREACHABLE' | 'UNTRUSTED';

export type RelaySessionEvent =
  | { readonly kind: 'connected'; readonly member: number; readonly members: readonly number[] }
  | { readonly kind: 'delivery'; readonly delivery: RelayDelivery }
  | { readonly kind: 'caughtUp' }
  | { readonly kind: 'presence'; readonly member: number; readonly presence: OpenedPresence }
  | { readonly kind: 'joined' | 'left'; readonly member: number }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'ended'; readonly reason: RelayEnd };

export interface RelaySessionOptions {
  readonly address: RelayAddress;
  readonly keys: RelayKeys;
  readonly creates: boolean;
  readonly keepTrying: boolean;
  readonly crypto: RelayCrypto;
  readonly startTimer: StartTimer;
  readonly tell: (event: RelaySessionEvent) => void;
}

export interface RelaySession {
  readonly send: (outgoing: RelayOutgoing) => Result<void, SealRefusal | 'NOT_OPEN'>;
  readonly closeRoom: () => Promise<Result<void, 'READ_ONLY' | 'NOT_OPEN' | RelayEnd>>;
  readonly close: () => void;
}

const RETRIED_ENDS = [
  'RELAY_FULL',
  'RELAY_FAILED',
  'TOO_MANY',
  'TOO_FAST',
  'STALE',
  'UNREACHABLE',
] as const satisfies readonly RelayEnd[];
const LOST_RECORDS: readonly RecordRefusal[] = ['TOO_MANY', 'TOO_LARGE'];
const CERTIFICATE_ERRORS: ReadonlySet<string> = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const WS_ERROR_PREFIX = 'WS_ERR_';
const CLOSE_NORMAL = 1000;

let authorities: readonly string[] | null = null;

/** Gives the certificates a relay may be signed by: those Node carries and those of the system, so that a relay behind a company's own authority is trusted as a browser would trust it. */
function certificateAuthorities(): readonly string[] {
  authorities ??= [...getCACertificates('default'), ...getCACertificates('system')];
  return authorities;
}

/** Tells why a socket to the relay failed: a certificate this computer does not trust, a broken protocol, or a network that does not reach it. */
export function endOfError(error: Error): RelayEnd {
  const code: unknown = Reflect.get(error, 'code');
  if (typeof code !== 'string') {
    return 'UNREACHABLE';
  }
  if (CERTIFICATE_ERRORS.has(code)) {
    return 'UNTRUSTED';
  }
  return code.startsWith(WS_ERROR_PREFIX) ? 'MALFORMED' : 'UNREACHABLE';
}

/** Keeps a window in a plan shared through a relay: creates or opens its room, seals what the page sends, opens what the relay passes on and comes back from the last record it has after a lost connection, until a refusal or the page ends it. */
export function startRelaySession(options: RelaySessionOptions): RelaySession {
  const { keys, crypto, startTimer, tell } = options;
  const relay = hostLabelOf(options.address);
  const creation = options.creates ? creationOf(keys) : null;
  let assembler = createRelayAssembler(keys, crypto);
  let socket: WebSocket | null = null;
  let isIn = false;
  let wasIn = false;
  let isStopped = false;
  let since = 0;
  let member = 0;
  let attempts = 0;
  let stopRetry: (() => void) | null = null;
  let stopOffline: (() => void) | null = null;
  let closing: ((result: Result<void, RelayEnd>) => void) | null = null;
  /** Stops waiting to try again and to say that nobody answers. */
  const stopTimers = (): void => {
    stopRetry?.();
    stopOffline?.();
    stopRetry = null;
    stopOffline = null;
  };
  /** Ends the session for good, telling the page why. */
  const endForGood = (reason: RelayEnd): void => {
    isStopped = true;
    stopTimers();
    console.warn(`The plan shared through the relay ${relay} stopped: ${reason}.`);
    tell({ kind: 'ended', reason });
  };
  /** Waits before trying again, telling the page the first time the connection is lost and again once nobody answered for a while. */
  const retryLater = (): void => {
    if (stopOffline === null) {
      tell({ kind: 'reconnecting' });
      stopOffline = startTimer(OFFLINE_AFTER_MILLISECONDS, () => {
        tell({ kind: 'offline' });
      });
    }
    stopRetry = startTimer(reconnectDelay(attempts), () => {
      stopRetry = null;
      attempts += 1;
      connect();
    });
  };
  /** Drops a socket that failed, then tries again when the failure may pass and the room was reached once or the window keeps trying, or ends for good. */
  const fail = (current: WebSocket, reason: RelayEnd): void => {
    if (current !== socket || isStopped) {
      return;
    }
    socket = null;
    isIn = false;
    current.terminate();
    closing?.(failure(reason));
    closing = null;
    if (isOneOf(RETRIED_ENDS, reason) && (wasIn || options.keepTrying)) {
      retryLater();
      return;
    }
    endForGood(reason);
  };
  /** Gives the frame that lets this window in: the signed creation of the room the first time it creates one, or a hello after the last record it has. */
  const opening = (): ClientFrame =>
    creation === null || wasIn ? { type: 'hello', roomId: keys.roomId, since } : creation;
  /** Takes a record the relay passed on, handing the page each message once all its chunks are in, and counting a record as had only once it joined its message or will never open. */
  const take = (current: WebSocket, seq: number, record: Uint8Array): void => {
    if (seq <= since) {
      return;
    }
    const taken = assembler.take(seq, record);
    if (!taken.ok) {
      setAside(current, seq, taken.error);
      return;
    }
    since = seq;
    if (taken.value !== null) {
      tell({ kind: 'delivery', delivery: { ...taken.value, settled: assembler.settled() } });
    }
  };
  /** Sets aside a record that did not join its message: a record the room did not sign is ignored, one that does not open is counted as had since no retry would open it, and one dropped for lack of room makes the window come back from the first record. */
  const setAside = (current: WebSocket, seq: number, refusal: RecordRefusal): void => {
    console.warn(`A record of the shared plan was set aside: ${refusal}.`);
    if (refusal === 'UNREADABLE') {
      since = seq;
    }
    if (LOST_RECORDS.includes(refusal)) {
      since = 0;
      assembler = createRelayAssembler(keys, crypto);
      fail(current, 'UNREACHABLE');
    }
  };
  /** Acts on a frame the relay sent. */
  const receive = (current: WebSocket, frame: RelayFrame): void => {
    switch (frame.type) {
      case 'welcome':
        isIn = true;
        wasIn = true;
        member = frame.member;
        attempts = 0;
        stopTimers();
        tell({ kind: 'connected', member: frame.member, members: frame.members });
        return;
      case 'record':
        take(current, frame.seq, frame.record);
        return;
      case 'caughtUp':
        tell({ kind: 'caughtUp' });
        return;
      case 'presence':
        tellPresence(frame.member, frame.bytes);
        return;
      case 'joined':
      case 'left':
        tell({ kind: frame.type, member: frame.member });
        return;
      case 'refused':
        fail(current, frame.reason);
        return;
      case 'closed':
        closedOnRequest(current);
    }
  };
  /** Ends the session quietly once the relay closed the room this window asked to close, or as a room closed by someone else otherwise. */
  const closedOnRequest = (current: WebSocket): void => {
    if (closing === null) {
      fail(current, 'CLOSED');
      return;
    }
    closing(success(undefined));
    closing = null;
    stop();
  };
  /** Hands the page the presence of another member, setting aside one that does not open. */
  const tellPresence = (from: number, bytes: Uint8Array): void => {
    const presence = openRelayPresence(keys, from, bytes, crypto);
    if (presence === null) {
      console.warn('A presence in the shared plan did not open and was set aside.');
      return;
    }
    tell({ kind: 'presence', member: from, presence });
  };
  /** Opens a socket to the relay, lets this window in once open and follows what the relay sends. */
  const connect = (): void => {
    const current = new WebSocket(relayUrlOf(options.address), {
      ca: [...certificateAuthorities()],
      maxPayload: MAX_RELAY_FRAME_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: MAX_HANDSHAKE_MILLISECONDS,
    });
    socket = current;
    current.on('open', () => {
      watchHeartbeat(current, startTimer);
      current.send(encodeClientFrame(opening()));
    });
    current.on('message', (data: RawData, isBinary: boolean) => {
      if (current !== socket) {
        return;
      }
      const frame = isBinary ? readRelayFrame(bytesOf(data)) : null;
      if (frame === null || frame === 'UNSUPPORTED_VERSION') {
        fail(current, frame ?? 'MALFORMED');
        return;
      }
      receive(current, frame);
    });
    current.on('error', (error) => {
      console.warn(`The connection to the relay ${relay} failed:`, error);
      fail(current, endOfError(error));
    });
    current.on('close', () => {
      fail(current, 'UNREACHABLE');
    });
  };
  /** Sends a frame to the relay once this window is in. */
  const sendFrame = (frame: ClientFrame): Result<void, 'NOT_OPEN'> => {
    if (!isIn || socket === null) {
      return failure('NOT_OPEN');
    }
    socket.send(encodeClientFrame(frame));
    return success(undefined);
  };
  /** Stops the session for good without telling the page, closing its socket. */
  const stop = (): void => {
    isStopped = true;
    isIn = false;
    stopTimers();
    socket?.close(CLOSE_NORMAL);
    socket = null;
  };
  /** Asks the relay to close the room for good and waits for its answer, a relay that does not answer in time counting as not reached. */
  const closeRoom = async (signature: Uint8Array): Promise<Result<void, 'NOT_OPEN' | RelayEnd>> => {
    const sent = sendFrame({ type: 'close', signature });
    if (!sent.ok) {
      return sent;
    }
    const { promise, resolve } = Promise.withResolvers<Result<void, RelayEnd>>();
    closing = resolve;
    const stopWaiting = startTimer(MAX_HANDSHAKE_MILLISECONDS, () => {
      closing = null;
      resolve(failure('UNREACHABLE'));
    });
    const answer = await promise;
    stopWaiting();
    return answer;
  };
  connect();
  return {
    send: (outgoing) => {
      if (!isIn) {
        return failure('NOT_OPEN');
      }
      if (outgoing.kind === 'presence') {
        const sealed = sealRelayPresence(keys, member, outgoing.bytes, crypto);
        return sealed.ok ? sendFrame({ type: 'presence', bytes: sealed.value }) : sealed;
      }
      const sealed = sealRelayMessage(keys, { ...outgoing.message, seen: since }, crypto);
      if (!sealed.ok) {
        return sealed;
      }
      sealed.value.forEach((record) => sendFrame({ type: 'append', record }));
      return success(undefined);
    },
    closeRoom: () =>
      keys.sign === null
        ? Promise.resolve(failure('READ_ONLY'))
        : closeRoom(keys.sign(signedCloseBytes(keys.roomId))),
    close: stop,
  };
}

/** Gives the signed frame that creates the room of some keys, throwing for keys that cannot sign since only the link that edits a plan creates its room. */
function creationOf(keys: RelayKeys): ClientFrame {
  if (keys.sign === null) {
    throw new Error('Only the link that edits a plan can create its room.');
  }
  return {
    type: 'create',
    roomId: keys.roomId,
    verifyKey: keys.verifyKey,
    signature: keys.sign(signedCreateBytes(keys.roomId, keys.verifyKey)),
  };
}
