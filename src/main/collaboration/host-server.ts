import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { MAX_SEALED_FRAME_BYTES } from '../../core/collaboration/secure/channel';
import {
  generateJoinCode,
  WRONG_CODES_BEFORE_NEW_CODE,
} from '../../core/collaboration/secure/join-code';
import {
  PLAN_KEY_BYTES,
  tokenDigestOf,
  type HostSecrets,
  type Introduction,
} from '../../core/collaboration/secure/link';
import {
  MAX_DEPARTED_PARTICIPANTS,
  MAX_OPEN_HANDSHAKES,
  MAX_PARTICIPANTS,
  MAX_PORT_ATTEMPTS,
} from '../../core/limits';
import { LAST_PORT } from '../../core/collaboration/ports';
import { failure, success, type Result } from '../../core/result';
import { isPrivateAddress } from './private-addresses';
import {
  acceptGuest,
  type ConnectionEnd,
  type SecureConnection,
  type StartTimer,
} from './secure-connection';
import { watchHeartbeat } from './heartbeat';

export interface Peer {
  readonly number: number;
  readonly send: (message: Uint8Array) => ReturnType<SecureConnection['send']>;
  readonly remove: () => void;
}

export interface HostServerEvents {
  readonly joined: (peer: Peer, introduction: Introduction) => void;
  readonly message: (peer: Peer, message: Uint8Array) => void;
  readonly left: (peer: Peer, reason: ConnectionEnd) => void;
  readonly codeChanged: (code: string) => void;
  readonly planKeyChanged: (planKey: Uint8Array) => void;
}

export interface HostServer {
  readonly port: number;
  readonly code: () => string;
  readonly planKey: () => Uint8Array;
  readonly close: () => Promise<void>;
}

export type ListenFailure = 'NO_FREE_PORT' | 'LISTEN_FAILED';

interface ServerOptions {
  readonly port: number;
  readonly planKey: Uint8Array | null;
  readonly knownTokens: ReadonlyMap<string, string>;
  readonly events: HostServerEvents;
  readonly startTimer: StartTimer;
  readonly randomBytes: (count: number) => Uint8Array;
}

const ALL_ADDRESSES = '::';
const ALL_IPV4_ADDRESSES = '0.0.0.0';
const PORT_IN_USE = 'EADDRINUSE';
const NO_IPV6 = 'EAFNOSUPPORT';
const UPGRADE_REQUIRED = 426;
const NORMAL_CLOSE = 1_000;
export const WRONG_CODE_CLOSE = 4_001;
export const CODE_REPLACED_CLOSE = 4_002;
export const WRONG_KEY_CLOSE = 4_003;
export const IDENTITY_TAKEN_CLOSE = 4_004;
export const REMOVED_CLOSE = 4_005;
export const HOST_LEFT_CLOSE = 4_006;
export const CLOSE_GRACE_MILLISECONDS = 1_024;
const MAX_CONNECTIONS = MAX_PARTICIPANTS + MAX_OPEN_HANDSHAKES;
const MAX_KNOWN_TOKENS = MAX_PARTICIPANTS + MAX_DEPARTED_PARTICIPANTS;

/** Starts the server of a shared plan on the chosen port or the next free one, on every private network, IPv4 and IPv6, accepting only guests from a private address who prove they know the code. */
export async function startHostServer(
  options: ServerOptions,
): Promise<Result<HostServer, ListenFailure>> {
  const http = createServer((_request, response) => {
    response.writeHead(UPGRADE_REQUIRED).end();
  });
  http.on('connection', (socket: Socket) => {
    if (!isPrivateAddress(socket.remoteAddress ?? '')) {
      socket.destroy();
    }
  });
  const listened = await listenFrom(http, options.port);
  if (!listened.ok) {
    return listened;
  }
  const sockets = new WebSocketServer({
    server: http,
    maxPayload: MAX_SEALED_FRAME_BYTES,
    perMessageDeflate: false,
  });
  const guests = guestCounter(options);
  sockets.on('connection', (socket) => {
    guests.accept(socket, sockets.clients.size);
  });
  return success({
    port: listened.value,
    code: guests.code,
    planKey: guests.planKey,
    close: () => closeServer(sockets, http, options.startTimer),
  });
}

/** Listens on the first free port from the chosen one, trying all addresses then IPv4 alone when the system has no IPv6. */
async function listenFrom(http: Server, firstPort: number): Promise<Result<number, ListenFailure>> {
  const lastPort = Math.min(firstPort + MAX_PORT_ATTEMPTS - 1, LAST_PORT);
  for (let port = firstPort; port <= lastPort; port += 1) {
    const outcome = await listenOn(http, port, ALL_ADDRESSES);
    const retried = outcome === NO_IPV6 ? await listenOn(http, port, ALL_IPV4_ADDRESSES) : outcome;
    if (retried === null) {
      return success(port);
    }
    if (retried !== PORT_IN_USE) {
      console.error(`The shared plan could not listen on port ${String(port)}: ${retried}`);
      return failure('LISTEN_FAILED');
    }
  }
  return failure('NO_FREE_PORT');
}

/** Listens on one port and address, giving null once listening or the code of the error that stopped it. */
function listenOn(http: Server, port: number, host: string): Promise<string | null> {
  return new Promise((resolve) => {
    /** Gives the code of the error that stopped the listening. */
    const onError = (error: Error): void => {
      http.off('listening', onListening);
      resolve(String(Reflect.get(error, 'code') ?? error.message));
    };
    /** Tells that the server listens. */
    const onListening = (): void => {
      http.off('error', onError);
      resolve(null);
    };
    http.once('error', onError);
    http.once('listening', onListening);
    http.listen({ port, host });
  });
}

/** Keeps the code and the key of the plan and counts the guests: those opening their connection, the wrong codes that draw a new code, the token digest of each identifier, known from a previous host or first seen, and the identifiers removed. */
function guestCounter(options: ServerOptions) {
  let code = generateJoinCode(options.randomBytes);
  let planKey = options.planKey ?? options.randomBytes(PLAN_KEY_BYTES);
  let wrongCodes = 0;
  let opening = 0;
  let nextNumber = 1;
  const tokens = new Map<string, string>(options.knownTokens);
  const removed = new Set<string>();
  const admitted = new Map<SecureConnection, string>();
  /** Counts a wrong code, drawing a new code once too many were typed, and tells whether it did. */
  const countWrongCode = (): boolean => {
    wrongCodes += 1;
    if (wrongCodes < WRONG_CODES_BEFORE_NEW_CODE) {
      return false;
    }
    wrongCodes = 0;
    code = generateJoinCode(options.randomBytes);
    options.events.codeChanged(code);
    return true;
  };
  /** Tells whether a guest may come in as the person who first came with its identifier, refusing an identifier removed by the host and, once the tokens remembered reach their limit, any new identifier, so that no token is ever forgotten. */
  const isSamePerson = (introduction: Introduction): boolean => {
    if (removed.has(introduction.participantId)) {
      return false;
    }
    const digest = tokenDigestOf(introduction.token);
    const known = tokens.get(introduction.participantId);
    if (known !== undefined) {
      return known === digest;
    }
    if (tokens.size >= MAX_KNOWN_TOKENS) {
      return false;
    }
    tokens.set(introduction.participantId, digest);
    return true;
  };
  /** Gives an admitted guest the key of the plan, closing a connection that cannot carry it. */
  const givePlanKey = (connection: SecureConnection): void => {
    const sent = connection.sendPlanKey(planKey);
    if (!sent.ok) {
      console.warn(`The key of the shared plan could not be sent: ${sent.error}.`);
      connection.close();
    }
  };
  /** Removes a guest for good: its identifier is refused from now on and a new key of the plan goes to the guests still in, so that the key it holds no longer opens a connection. */
  const removeGuest = (connection: SecureConnection): void => {
    const id = admitted.get(connection);
    admitted.delete(connection);
    if (id === undefined) {
      return;
    }
    removed.add(id);
    planKey = options.randomBytes(PLAN_KEY_BYTES);
    options.events.planKeyChanged(planKey);
    admitted.forEach((_id, other) => {
      givePlanKey(other);
    });
  };
  return {
    code: () => code,
    planKey: () => planKey,
    accept: (socket: WebSocket, connections: number): void => {
      if (opening >= MAX_OPEN_HANDSHAKES || connections > MAX_CONNECTIONS) {
        socket.terminate();
        return;
      }
      opening += 1;
      let isOpening = true;
      /** Stops counting the guest among those opening their connection. */
      const doneOpening = (): void => {
        if (isOpening) {
          isOpening = false;
          opening -= 1;
        }
      };
      attachGuest(socket, nextNumber, { code, planKey }, options, {
        joined: (connection, introduction) => {
          doneOpening();
          if (!isSamePerson(introduction)) {
            return false;
          }
          admitted.set(connection, introduction.participantId);
          givePlanKey(connection);
          return true;
        },
        ended: (connection) => {
          doneOpening();
          admitted.delete(connection);
        },
        removed: removeGuest,
        wrongCode: countWrongCode,
      });
      nextNumber += 1;
    },
  };
}

/** Runs the secure connection of one guest over its socket and tells the host who joined, what it sent and when it left, a guest claiming the identifier of another person being turned away. */
function attachGuest(
  socket: WebSocket,
  number: number,
  secrets: HostSecrets,
  options: ServerOptions,
  counting: {
    readonly joined: (connection: SecureConnection, introduction: Introduction) => boolean;
    readonly ended: (connection: SecureConnection) => void;
    readonly removed: (connection: SecureConnection) => void;
    readonly wrongCode: () => boolean;
  },
): void {
  let hasJoined = false;
  let refusal: number | null = null;
  const connection: SecureConnection = acceptGuest({
    secrets,
    startTimer: options.startTimer,
    randomBytes: options.randomBytes,
    wire: {
      send: (bytes) => {
        socket.send(bytes);
      },
      close: (reason) => {
        socket.close(refusal ?? closeCodeOf(reason, counting.wrongCode));
      },
    },
    events: {
      message: (message) => {
        options.events.message(peer, message);
      },
      planKey: null,
      ended: (reason) => {
        counting.ended(connection);
        if (hasJoined) {
          options.events.left(peer, reason);
        }
      },
    },
    joined: (introduction) => {
      if (!counting.joined(connection, introduction)) {
        refusal = IDENTITY_TAKEN_CLOSE;
        connection.close();
        return;
      }
      hasJoined = true;
      options.events.joined(peer, introduction);
    },
  });
  const peer: Peer = {
    number,
    send: connection.send,
    remove: () => {
      counting.removed(connection);
      refusal = REMOVED_CLOSE;
      connection.close();
    },
  };
  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      connection.close();
      return;
    }
    connection.receive(bytesOf(data));
  });
  socket.on('close', () => {
    connection.wireClosed();
  });
  socket.on('error', (error) => {
    console.warn(`A connection to the shared plan failed: ${error.message}`);
  });
  watchHeartbeat(socket, options.startTimer);
}

/** Gives the close code that tells a guest why the host ended its connection: a wrong code, counted, the last wrong code before a new one was drawn, or a key of the plan the host does not hold. */
function closeCodeOf(reason: ConnectionEnd, countWrongCode: () => boolean): number {
  if (reason === 'WRONG_KEY') {
    return WRONG_KEY_CLOSE;
  }
  if (reason !== 'WRONG_CODE') {
    return NORMAL_CLOSE;
  }
  return countWrongCode() ? CODE_REPLACED_CLOSE : WRONG_CODE_CLOSE;
}

/** Gives the bytes of a message received by ws, which may come as one buffer, several or an array buffer. */
export function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

/** Stops the server: tells every guest the host left so that one of them takes over, gives the guests a moment to read it, then ends what remains and stops listening. */
async function closeServer(
  sockets: WebSocketServer,
  http: Server,
  startTimer: StartTimer,
): Promise<void> {
  const leaving = [...sockets.clients].map(
    (socket) =>
      new Promise<void>((resolve) => {
        const stop = startTimer(CLOSE_GRACE_MILLISECONDS, () => {
          socket.terminate();
          resolve();
        });
        socket.once('close', () => {
          stop();
          resolve();
        });
        socket.close(HOST_LEFT_CLOSE);
      }),
  );
  await Promise.all(leaving);
  await new Promise<void>((resolve) => {
    sockets.close(() => {
      http.close(() => {
        resolve();
      });
      http.closeAllConnections();
    });
  });
}
