import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { MAX_SEALED_FRAME_BYTES } from '../../core/collaboration/secure/channel';
import {
  generateJoinCode,
  WRONG_CODES_BEFORE_NEW_CODE,
} from '../../core/collaboration/secure/join-code';
import type { Introduction } from '../../core/collaboration/secure/link';
import { MAX_OPEN_HANDSHAKES, MAX_PARTICIPANTS, MAX_PORT_ATTEMPTS } from '../../core/limits';
import { LAST_PORT } from '../../core/collaboration/ports';
import { failure, success, type Result } from '../../core/result';
import { isPrivateAddress } from './private-addresses';
import {
  acceptGuest,
  type ConnectionEnd,
  type SecureConnection,
  type StartTimer,
} from './secure-connection';

export interface Peer {
  readonly number: number;
  readonly send: (message: Uint8Array) => ReturnType<SecureConnection['send']>;
  readonly close: () => void;
}

export interface HostServerEvents {
  readonly joined: (peer: Peer, introduction: Introduction) => void;
  readonly message: (peer: Peer, message: Uint8Array) => void;
  readonly left: (peer: Peer, reason: ConnectionEnd) => void;
  readonly codeChanged: (code: string) => void;
}

export interface HostServer {
  readonly port: number;
  readonly code: () => string;
  readonly close: () => Promise<void>;
}

export type ListenFailure = 'NO_FREE_PORT' | 'LISTEN_FAILED';

interface ServerOptions {
  readonly port: number;
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
const MAX_CONNECTIONS = MAX_PARTICIPANTS + MAX_OPEN_HANDSHAKES;

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
    close: () => closeServer(sockets, http),
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

/** Keeps the code and counts the guests: those still opening their connection, and the wrong codes that make the host draw a new one. */
function guestCounter(options: ServerOptions) {
  let code = generateJoinCode(options.randomBytes);
  let wrongCodes = 0;
  let opening = 0;
  let nextNumber = 1;
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
  return {
    code: () => code,
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
      attachGuest(socket, nextNumber, code, options, {
        joined: doneOpening,
        ended: doneOpening,
        wrongCode: countWrongCode,
      });
      nextNumber += 1;
    },
  };
}

/** Runs the secure connection of one guest over its socket and tells the host who joined, what it sent and when it left. */
function attachGuest(
  socket: WebSocket,
  number: number,
  code: string,
  options: ServerOptions,
  counting: {
    readonly joined: () => void;
    readonly ended: () => void;
    readonly wrongCode: () => boolean;
  },
): void {
  let hasJoined = false;
  const connection: SecureConnection = acceptGuest({
    code,
    startTimer: options.startTimer,
    randomBytes: options.randomBytes,
    wire: {
      send: (bytes) => {
        socket.send(bytes);
      },
      close: (reason) => {
        socket.close(closeCodeOf(reason, counting.wrongCode));
      },
    },
    events: {
      message: (message) => {
        options.events.message(peer, message);
      },
      ended: (reason) => {
        counting.ended();
        if (hasJoined) {
          options.events.left(peer, reason);
        }
      },
    },
    joined: (introduction) => {
      hasJoined = true;
      counting.joined();
      options.events.joined(peer, introduction);
    },
  });
  const peer: Peer = { number, send: connection.send, close: connection.close };
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
}

/** Gives the close code that tells a guest why the host ended its connection: a wrong code, counted, or the last wrong code before a new one was drawn. */
function closeCodeOf(reason: ConnectionEnd, countWrongCode: () => boolean): number {
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

/** Stops the server: closes every connection, then stops listening. */
function closeServer(sockets: WebSocketServer, http: Server): Promise<void> {
  for (const socket of sockets.clients) {
    socket.terminate();
  }
  return new Promise((resolve) => {
    sockets.close(() => {
      http.close(() => {
        resolve();
      });
      http.closeAllConnections();
    });
  });
}
