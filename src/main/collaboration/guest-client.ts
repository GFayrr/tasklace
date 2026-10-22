import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import { MAX_SEALED_FRAME_BYTES } from '../../core/collaboration/secure/channel';
import type { Introduction, JoinSecret } from '../../core/collaboration/secure/link';
import { isPort } from '../../core/collaboration/ports';
import { MAX_HANDSHAKE_MILLISECONDS } from '../../core/limits';
import {
  bytesOf,
  CODE_REPLACED_CLOSE,
  IDENTITY_TAKEN_CLOSE,
  REMOVED_CLOSE,
  HOST_LEFT_CLOSE,
  WRONG_CODE_CLOSE,
  WRONG_KEY_CLOSE,
} from './host-server';
import { isPrivateAddress } from './private-addresses';
import {
  connectToHost,
  type ConnectionEnd,
  type SecureConnection,
  type StartTimer,
} from './secure-connection';
import { watchHeartbeat } from './heartbeat';

export type GuestEnd =
  | ConnectionEnd
  | 'CODE_REPLACED'
  | 'IDENTITY_TAKEN'
  | 'REMOVED'
  | 'HOST_LEFT'
  | 'UNREACHABLE'
  | 'NOT_PRIVATE';

export interface GuestOptions {
  readonly address: string;
  readonly port: number;
  readonly secret: JoinSecret;
  readonly introduction: Introduction;
  readonly startTimer: StartTimer;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly events: {
    readonly opened: () => void;
    readonly message: (message: Uint8Array) => void;
    readonly planKey: (key: Uint8Array) => void;
    readonly ended: (reason: GuestEnd) => void;
  };
}

export interface GuestClient {
  readonly send: SecureConnection['send'];
  readonly close: () => void;
}

const HOST_NAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const IPV6 = 6;
const ZONE_SEPARATOR = '%';
const REFUSED_CODES: ReadonlyMap<number, GuestEnd> = new Map([
  [WRONG_CODE_CLOSE, 'WRONG_CODE'],
  [CODE_REPLACED_CLOSE, 'CODE_REPLACED'],
  [WRONG_KEY_CLOSE, 'WRONG_KEY'],
  [IDENTITY_TAKEN_CLOSE, 'IDENTITY_TAKEN'],
  [REMOVED_CLOSE, 'REMOVED'],
  [HOST_LEFT_CLOSE, 'HOST_LEFT'],
]);

/** Tells whether an address typed by a person or found on the network can name a host: an IP address, or a host name of letters, digits, hyphens and dots. */
export function isHostAddress(address: string): boolean {
  return isIP(withoutZone(address)) !== 0 || HOST_NAME_PATTERN.test(address);
}

/** Removes the zone of a local link from an address, as in fe80::1%eth0. */
function withoutZone(address: string): string {
  const at = address.indexOf(ZONE_SEPARATOR);
  return at === -1 ? address : address.slice(0, at);
}

/** Builds the address of the WebSocket of a host, an IPv6 address in brackets with its zone escaped. */
export function socketUrlOf(address: string, port: number): string {
  const host =
    isIP(withoutZone(address)) === IPV6 ? `[${address.replace(ZONE_SEPARATOR, '%25')}]` : address;
  return `ws://${host}:${String(port)}`;
}

/** Joins the host of a shared plan, refusing it unless it answers from a private address, then opens the secure connection with the join code or the key of the plan. */
export function connectAsGuest(options: GuestOptions): GuestClient {
  if (!isHostAddress(options.address) || !isPort(options.port)) {
    throw new RangeError(`Not a host address: ${options.address}:${String(options.port)}`);
  }
  const socket = new WebSocket(socketUrlOf(options.address, options.port), {
    maxPayload: MAX_SEALED_FRAME_BYTES,
    perMessageDeflate: false,
    handshakeTimeout: MAX_HANDSHAKE_MILLISECONDS,
  });
  let endReason: GuestEnd | null = null;
  const connection = connectToHost({
    secret: options.secret,
    introduction: options.introduction,
    startTimer: options.startTimer,
    randomBytes: options.randomBytes,
    wire: {
      send: (bytes) => {
        socket.send(bytes);
      },
      close: () => {
        socket.terminate();
      },
    },
    events: {
      message: options.events.message,
      planKey: options.events.planKey,
      ended: (reason) => {
        options.events.ended(endReason ?? reason);
      },
    },
    opened: options.events.opened,
  });
  /** Ends the connection for a reason told by the socket rather than found by the channel. */
  const endWith = (reason: GuestEnd): void => {
    endReason ??= reason;
    connection.close();
  };
  socket.on('open', () => {
    watchHeartbeat(socket, options.startTimer);
  });
  socket.on('upgrade', (response: IncomingMessage) => {
    if (!isPrivateAddress(response.socket.remoteAddress ?? '')) {
      endWith('NOT_PRIVATE');
    }
  });
  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      endWith('MALFORMED');
      return;
    }
    connection.receive(bytesOf(data));
  });
  socket.on('error', (error) => {
    console.warn(`The connection to the shared plan failed: ${error.message}`);
    endWith('UNREACHABLE');
  });
  socket.on('close', (code: number) => {
    const refused = REFUSED_CODES.get(code);
    if (refused !== undefined) {
      endWith(refused);
      return;
    }
    connection.wireClosed();
  });
  return { send: connection.send, close: connection.close };
}
