import type { TokenDigest } from '../../core/collaboration/secure/token-digest';
import type { ParticipantId } from '../../core/collaboration/participants';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { createAdmission, type Admission } from '../../core/collaboration/admission';
import { MAX_SEALED_FRAME_BYTES } from '../../core/collaboration/secure/channel';
import {
  generateJoinCode,
  WRONG_CODES_BEFORE_NEW_CODE,
  type JoinCode,
} from '../../core/collaboration/secure/join-code';
import {
  drawPlanKey,
  encodeIntroduction,
  tokenDigestOf,
  type HostSecrets,
  type Introduction,
  type PlanKey,
} from '../../core/collaboration/secure/link';
import {
  MAX_DEPARTED_PARTICIPANTS,
  MAX_OPEN_HANDSHAKES,
  MAX_PARTICIPANTS,
  MAX_PORT_ATTEMPTS,
  MAX_READ_ONLY_MESSAGE_BYTES,
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
  readonly sendCompressed: SecureConnection['sendCompressed'];
  readonly turnAway: () => void;
  readonly allowEditing: () => void;
}

export interface HostServerEvents {
  readonly joined: (peer: Peer, introduction: Introduction) => void;
  readonly message: (peer: Peer, message: Uint8Array) => void;
  readonly left: (peer: Peer, reason: ConnectionEnd) => void;
  readonly codeChanged: (code: JoinCode) => void;
}

export interface HostServer {
  readonly port: number;
  readonly code: () => JoinCode;
  readonly planKey: () => PlanKey;
  readonly forget: (ids: readonly ParticipantId[]) => void;
  readonly close: () => Promise<void>;
}

export type ListenFailure = 'NO_FREE_PORT' | 'LISTEN_FAILED';

type JoinAnswer = 'admitted' | 'identityTaken' | 'closed';

interface ServerOptions {
  readonly port: number;
  readonly planKey: PlanKey | null;
  readonly knownDigests: ReadonlyMap<ParticipantId, TokenDigest>;
  readonly identity: Introduction | null;
  readonly events: HostServerEvents;
  readonly startTimer: StartTimer;
  readonly randomBytes: (count: number) => Uint8Array;
  readonly now: () => number;
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
export const TURNED_AWAY_CLOSE = 4_005;
export const TRY_LATER_CLOSE = 4_007;
export const HOST_LEFT_CLOSE = 4_006;
export const CLOSE_GRACE_MILLISECONDS = 1_024;
const MAX_CONNECTIONS = MAX_PARTICIPANTS + MAX_OPEN_HANDSHAKES;
const MAX_KNOWN_DIGESTS = MAX_PARTICIPANTS + MAX_DEPARTED_PARTICIPANTS;

/** Starts the server of a shared plan on the chosen port or the next free one, on every private network, IPv4 and IPv6, accepting only guests from a private address who prove they know the join code or the key of the plan. */
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
  sockets.on('error', (error) => {
    console.error('The server of the shared plan failed:', error);
  });
  sockets.on('connection', (socket, request) => {
    guests.accept(socket, sockets.clients.size, request.socket.remoteAddress ?? '');
  });
  return success({
    port: listened.value,
    code: guests.code,
    planKey: guests.planKey,
    forget: guests.forget,
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

/** Keeps the code and the key of the plan and counts the guests: those opening their connection, the wrong codes that draw a new code, the token digest of each identifier, known from a previous host or first seen, and the connection of each person. */
function guestCounter(options: ServerOptions) {
  let code = generateJoinCode(options.randomBytes);
  const planKey = options.planKey ?? drawPlanKey(options.randomBytes);
  let wrongCodes = 0;
  let opening = 0;
  let nextNumber = 1;
  const digests = new Map<ParticipantId, TokenDigest>(options.knownDigests);
  const admitted = new Map<string, SecureConnection>();
  const admission: Admission = createAdmission(options.now);
  const editors = new WeakSet<SecureConnection>();
  /** Tells a guest allowed to edit who hosts the plan, by its identifier and its token, so that a host it may give way to can check it, and logs any other guest asking. */
  const identify = (connection: SecureConnection, request: Uint8Array): void => {
    if (request.length !== 0 || options.identity === null || !editors.has(connection)) {
      console.warn('A guest not allowed to know who hosts the plan asked for it.');
      return;
    }
    const sent = connection.sendIdentity(encodeIntroduction(options.identity));
    if (!sent.ok) {
      console.warn(`Who hosts the plan could not be told to a guest: ${sent.error}.`);
    }
  };
  /** Counts a wrong code tried against the current code, drawing a new code once too many were typed, and tells whether the code tried is no longer the current one, a code replaced meanwhile counting for nothing. */
  const countWrongCode = (tried: string): boolean => {
    if (tried !== code) {
      return true;
    }
    wrongCodes += 1;
    if (wrongCodes < WRONG_CODES_BEFORE_NEW_CODE) {
      return false;
    }
    wrongCodes = 0;
    code = generateJoinCode(options.randomBytes);
    options.events.codeChanged(code);
    return true;
  };
  /** Tells whether a guest may come in as the person who first came with its identifier, refusing, once the digests remembered reach their limit, any new identifier, a digest being forgotten only once the list of the host forgot its person. */
  const isSamePerson = (introduction: Introduction): boolean => {
    const digest = tokenDigestOf(introduction.token);
    const known = digests.get(introduction.participantId);
    if (known !== undefined) {
      return known === digest;
    }
    if (digests.size >= MAX_KNOWN_DIGESTS) {
      return false;
    }
    digests.set(introduction.participantId, digest);
    return true;
  };
  /** Gives a guest the key of the plan, closing a connection that cannot carry it, and tells whether the key went. */
  const givePlanKey = (connection: SecureConnection): boolean => {
    const sent = connection.sendPlanKey(planKey);
    if (!sent.ok) {
      console.warn(`The key of the shared plan could not be sent: ${sent.error}.`);
      connection.close();
    }
    return sent.ok;
  };
  /** Admits a person on its new connection, closing the old one it came back from, which the host may not have seen end yet. */
  const admit = (connection: SecureConnection, id: string): void => {
    const previous = admitted.get(id);
    admitted.set(id, connection);
    previous?.close();
  };
  /** Forgets the connection a person was in on once it ends, unless that person already came back on another one. */
  const forget = (connection: SecureConnection, id: string | null): void => {
    if (id !== null && admitted.get(id) === connection) {
      admitted.delete(id);
    }
  };
  return {
    code: () => code,
    planKey: () => planKey,
    forget: (ids: readonly ParticipantId[]): void => {
      for (const id of ids) {
        if (!admitted.has(id)) {
          digests.delete(id);
        }
      }
    },
    accept: (socket: WebSocket, connections: number, address: string): void => {
      if (opening >= MAX_OPEN_HANDSHAKES || connections > MAX_CONNECTIONS) {
        socket.terminate();
        return;
      }
      if (!admission.admit(address)) {
        socket.close(TRY_LATER_CLOSE);
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
      const tried = code;
      attachGuest(socket, nextNumber, { code, planKey }, options, {
        joined: (connection, introduction) => {
          doneOpening();
          if (!isSamePerson(introduction)) {
            return 'identityTaken';
          }
          if (!givePlanKey(connection)) {
            return 'closed';
          }
          admission.joined(address);
          admit(connection, introduction.participantId);
          return 'admitted';
        },
        ended: (connection, id) => {
          doneOpening();
          forget(connection, id);
        },
        wrongCode: () => {
          admission.wrongCode(address);
          return countWrongCode(tried);
        },
        identify,
        allowEditing: (connection) => {
          editors.add(connection);
          connection.allowLargeMessages();
        },
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
    readonly joined: (connection: SecureConnection, introduction: Introduction) => JoinAnswer;
    readonly ended: (connection: SecureConnection, id: string | null) => void;
    readonly wrongCode: () => boolean;
    readonly identify: (connection: SecureConnection, request: Uint8Array) => void;
    readonly allowEditing: (connection: SecureConnection) => void;
  },
): void {
  let joinedAs: string | null = null;
  let refusal: number | null = null;
  const connection: SecureConnection = acceptGuest({
    secrets,
    messageLimit: MAX_READ_ONLY_MESSAGE_BYTES,
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
      identity: (request) => {
        counting.identify(connection, request);
      },
      ended: (reason) => {
        counting.ended(connection, joinedAs);
        if (joinedAs !== null) {
          options.events.left(peer, reason);
        }
      },
    },
    joined: (introduction) => {
      const answer = counting.joined(connection, introduction);
      if (answer === 'identityTaken') {
        refusal = IDENTITY_TAKEN_CLOSE;
        connection.close();
      }
      if (answer !== 'admitted') {
        return;
      }
      joinedAs = introduction.participantId;
      options.events.joined(peer, introduction);
    },
  });
  const peer: Peer = {
    number,
    send: connection.send,
    sendCompressed: connection.sendCompressed,
    turnAway: () => {
      refusal = TURNED_AWAY_CLOSE;
      connection.close();
    },
    allowEditing: () => {
      counting.allowEditing(connection);
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

/** Gives the close code that tells a guest why the host ended its connection: a wrong code, which is counted, the wrong code that made the host draw a new one, a key of the plan the host does not hold, or a normal end. */
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
