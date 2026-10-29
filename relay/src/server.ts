import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  encodeRelayFrame,
  MAX_RELAY_FRAME_BYTES,
  MAX_RELAY_MEMBERS,
  readClientFrame,
  signedCloseBytes,
  signedCreateBytes,
  type ClientFrame,
  type RelayFrame,
  type RelayRefusal,
} from '../../src/core/collaboration/relay/relay-wire.ts';
import type { RelayConfig } from './config.ts';
import { entriesAfter } from './room-file.ts';
import { createAddressBuckets, createBucket, type Bucket, type Rate } from './rate.ts';
import { openRoomStore, type Room, type RoomStore, type Staging } from './rooms.ts';
import type { StoredRecord } from './room-file.ts';
import { createSendQueue, type SendQueue } from './send-queue.ts';
import { verifierOf } from './signature.ts';

export interface RelayTimings {
  readonly helloMilliseconds: number;
  readonly heartbeatMilliseconds: number;
  readonly sweepMilliseconds: number;
  readonly closeMilliseconds: number;
}

export interface SendLimits {
  readonly highWaterBytes: number;
  readonly maxQueuedBytes: number;
}

export interface RelayServerOptions {
  readonly config: RelayConfig;
  readonly now?: () => number;
  readonly timings?: RelayTimings;
  readonly sending?: SendLimits;
}

export interface RunningRelay {
  readonly port: number;
  readonly close: () => Promise<void>;
}

interface Member {
  readonly socket: WebSocket;
  readonly address: string;
  readonly frames: Bucket;
  readonly queue: SendQueue;
  staging: Staging | null;
  state: MemberState;
  alive: boolean;
  helloTimer: NodeJS.Timeout | undefined;
}

interface Seat {
  readonly place: Place;
  readonly number: number;
}

type MemberState =
  | { readonly phase: 'waiting' | 'joining' }
  | { readonly phase: 'in'; readonly seat: Seat }
  | { readonly phase: 'gone'; readonly seat: Seat | null };

interface Place {
  readonly room: Room;
  readonly members: Map<number, Member>;
  nextMember: number;
}

const MILLISECONDS_PER_DAY = 86_400_000;
const SECONDS_PER_MINUTE = 60;
const SEND_HIGH_WATER_BYTES = 8_388_608;
const MAX_TRACKED_ADDRESSES = 4_096;
const FRAME_RATE: Rate = { perSecond: 256, burst: 1_024 };
const CLOSE_REFUSED = 1008;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_NORMAL = 1000;
const UPGRADE_REQUIRED = 426;
const FORWARDED_FOR = 'x-forwarded-for';
const DEFAULT_TIMINGS: RelayTimings = {
  helloMilliseconds: 8_192,
  heartbeatMilliseconds: 16_384,
  sweepMilliseconds: 3_600_000,
  closeMilliseconds: 4_096,
};

/** Starts a relay that keeps the encrypted records of each room and passes them to its members, checking every record against the key the room was created with, within its quotas. */
export async function startRelayServer(options: RelayServerOptions): Promise<RunningRelay> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const timings = options.timings ?? DEFAULT_TIMINGS;
  const places = new Map<string, Place>();
  const members = new Set<Member>();
  const perAddress = new Map<string, number>();
  const admit = createAddressBuckets(
    {
      perSecond: config.connectionsPerMinutePerAddress / SECONDS_PER_MINUTE,
      burst: config.connectionsPerMinutePerAddress,
    },
    MAX_TRACKED_ADDRESSES,
    now,
  );
  const sending = options.sending ?? {
    highWaterBytes: SEND_HIGH_WATER_BYTES,
    maxQueuedBytes: 2 * config.maxRoomBytes + MAX_RELAY_FRAME_BYTES,
  };
  const store: RoomStore = await openRoomStore({
    directory: config.dataDirectory,
    limits: {
      maxRooms: config.maxRooms,
      maxRoomBytes: config.maxRoomBytes,
      maxStoredBytes: config.maxStoredBytes,
      expiryMilliseconds: config.roomExpiryDays * MILLISECONDS_PER_DAY,
    },
    now,
    roomFailed: (room) => {
      places.get(room.name)?.members.forEach((member) => {
        refuse(member, 'RELAY_FAILED');
      });
    },
  });
  const http = await serverOf(config);
  const sockets = new WebSocketServer({
    server: http,
    maxPayload: MAX_RELAY_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: false,
  });

  /** Sends what waits for a member as fast as its connection takes it, so that a member catching up on a large room never holds it all in memory twice. */
  const pump = (member: Member): void => {
    while (
      !member.queue.isEmpty() &&
      member.socket.readyState === member.socket.OPEN &&
      member.socket.bufferedAmount < sending.highWaterBytes
    ) {
      const frame = member.queue.next();
      if (frame !== undefined) {
        member.socket.send(encodeRelayFrame(frame), (error) => {
          afterSend(member, error);
        });
      }
    }
  };
  /** Sends more once a frame left, or cuts a connection that could not send it. */
  const afterSend = (member: Member, error: Error | null | undefined): void => {
    if (error === undefined || error === null) {
      pump(member);
      return;
    }
    console.warn('A frame could not be sent to a member of a room:', error.message);
    member.socket.terminate();
  };
  /** Adds a frame to what waits for a member, cutting a member so slow that more than two whole rooms wait for it, as it will catch up once back. */
  const enqueue = (member: Member, frame: RelayFrame): void => {
    keepUp(member, member.queue.push(frame));
  };
  /** Adds the presence of another member to what waits for a member, a presence still waiting being replaced by the newer one so that a flood of presences never piles up. */
  const enqueuePresence = (member: Member, from: number, bytes: Uint8Array): void => {
    keepUp(member, member.queue.pushPresence(from, bytes));
  };
  /** Sends what waits for a member, or cuts it when more waits than the relay keeps for one member. */
  const keepUp = (member: Member, fits: boolean): void => {
    if (!fits) {
      console.warn('A member of a room fell too far behind and was cut.');
      member.socket.terminate();
      return;
    }
    pump(member);
  };
  /** Tells a member why the relay refuses it and closes its connection. */
  const refuse = (member: Member, reason: RelayRefusal): void => {
    if (member.state.phase === 'gone') {
      return;
    }
    member.state = { phase: 'gone', seat: seatOf(member) };
    member.staging?.cancel();
    member.staging = null;
    member.queue.clear();
    sendNow(member.socket, { type: 'refused', reason });
    member.socket.close(CLOSE_REFUSED);
  };
  /** Lets a member into a room it opened or created: its number, the key of the room and who is in, then every record after the one it already has, then that it caught up. */
  const enter = (member: Member, room: Room, since: number): void => {
    const place = places.get(room.name) ?? {
      room,
      members: new Map<number, Member>(),
      nextMember: 1,
    };
    places.set(room.name, place);
    if (member.state.phase !== 'joining') {
      leavePlace(place, member, null);
      return;
    }
    if (place.members.size >= MAX_RELAY_MEMBERS) {
      leavePlace(place, member, null);
      refuse(member, 'ROOM_FULL');
      return;
    }
    const others = [...place.members.keys()];
    const number = place.nextMember;
    place.nextMember += 1;
    member.state = { phase: 'in', seat: { place, number } };
    enqueue(member, {
      type: 'welcome',
      member: number,
      verifyKey: room.verifyKey,
      members: others,
    });
    place.members.forEach((other) => {
      enqueue(other, { type: 'joined', member: number });
    });
    place.members.set(number, member);
    entriesAfter(room.entries, since).forEach((entry) => {
      enqueue(member, { type: 'record', seq: entry.seq, record: entry.record });
    });
    enqueue(member, { type: 'caughtUp' });
  };
  /** Takes a member out of a room under the number it had there, if it had one, telling the others, and lets the store forget the room once nobody holds it. */
  const leavePlace = (place: Place, member: Member, number: number | null): void => {
    if (number !== null && place.members.get(number) === member) {
      place.members.delete(number);
      place.members.forEach((other) => {
        enqueue(other, { type: 'left', member: number });
      });
    }
    if (place.members.size === 0 && places.get(place.room.name) === place) {
      places.delete(place.room.name);
    }
    store.release(place.room).catch((error: unknown) => {
      console.error(`The room ${place.room.name} could not be released:`, error);
    });
  };
  /** Opens or creates the room a member asks for, refusing it when the room is not there, already there, or the relay cannot hold it. */
  const join = async (member: Member, frame: ClientFrame): Promise<void> => {
    member.state = { phase: 'joining' };
    clearTimeout(member.helloTimer);
    try {
      const room = await roomFor(frame);
      if (typeof room === 'string') {
        refuse(member, room);
        return;
      }
      enter(member, room, frame.type === 'hello' ? frame.since : 0);
    } catch (error) {
      console.error('A room could not be opened:', error);
      refuse(member, 'RELAY_FAILED');
    }
  };
  /** Gives the room a frame opens or creates, or why it cannot. */
  const roomFor = async (frame: ClientFrame): Promise<Room | RelayRefusal> => {
    if (frame.type === 'hello') {
      return (await store.open(frame.roomId)) ?? 'NO_ROOM';
    }
    if (frame.type !== 'create') {
      return 'MALFORMED';
    }
    const verify = verifierOf(frame.verifyKey);
    const signed = signedCreateBytes(frame.roomId, frame.verifyKey);
    return verify?.(signed, frame.signature) === true
      ? store.create(frame.roomId, frame.verifyKey)
      : 'BAD_SIGNATURE';
  };
  /** Takes a chunk a member sent into the message it is sending, and once the message is whole and written, passes its records to every member then in the room, its author included so that it knows the message is kept. */
  const append = (member: Member, { place }: Seat, record: Uint8Array): void => {
    const staging = member.staging ?? store.stage(place.room);
    const taken = staging.take(record);
    member.staging = taken === null ? staging : null;
    if (taken === null) {
      return;
    }
    if (typeof taken === 'string') {
      refuse(member, taken);
      return;
    }
    void taken.then((stored) => {
      if (stored !== null) {
        passOn(place.room.name, stored);
      }
    });
  };
  /** Passes records just written to the members in their room now, who may have come in while they were written. */
  const passOn = (name: string, stored: readonly StoredRecord[]): void => {
    places.get(name)?.members.forEach((other) => {
      stored.forEach((entry) => {
        enqueue(other, { type: 'record', seq: entry.seq, record: entry.record });
      });
    });
  };
  /** Closes a room for good when its key signed it, telling every member. */
  const closeRoom = async (
    member: Member,
    { place }: Seat,
    signature: Uint8Array,
  ): Promise<void> => {
    if (!place.room.verify(signedCloseBytes(place.room.roomId), signature)) {
      refuse(member, 'BAD_SIGNATURE');
      return;
    }
    try {
      await store.remove(place.room);
    } catch (error) {
      console.error(`The room ${place.room.name} could not be removed:`, error);
      place.members.forEach((other) => {
        refuse(other, 'RELAY_FAILED');
      });
      return;
    }
    places.delete(place.room.name);
    place.members.forEach((other) => {
      other.state = { phase: 'gone', seat: seatOf(other) };
      sendNow(other.socket, { type: 'closed' });
      other.socket.close(CLOSE_NORMAL);
    });
  };
  /** Acts on a frame a member sent, by what it may do at this point. */
  const act = (member: Member, frame: ClientFrame): void => {
    const { state } = member;
    if (state.phase === 'waiting') {
      void join(member, frame);
      return;
    }
    if (state.phase !== 'in') {
      refuse(member, 'MALFORMED');
      return;
    }
    switch (frame.type) {
      case 'append':
        append(member, state.seat, frame.record);
        return;
      case 'presence':
        state.seat.place.members.forEach((other) => {
          if (other !== member) {
            enqueuePresence(other, state.seat.number, frame.bytes);
          }
        });
        return;
      case 'close':
        void closeRoom(member, state.seat, frame.signature);
        return;
      default:
        refuse(member, 'MALFORMED');
    }
  };
  /** Reads a frame a member sent, refusing text, another version, bytes that are not a frame and a member sending too fast. */
  const receive = (member: Member, data: RawData, isBinary: boolean): void => {
    member.alive = true;
    if (member.state.phase === 'gone') {
      return;
    }
    if (!member.frames()) {
      refuse(member, 'TOO_FAST');
      return;
    }
    const frame = isBinary ? readClientFrame(bytesOf(data)) : null;
    if (frame === 'UNSUPPORTED_VERSION') {
      refuse(member, frame);
      return;
    }
    if (frame === null) {
      refuse(member, 'MALFORMED');
      return;
    }
    act(member, frame);
  };
  /** Forgets a member whose connection closed or that the relay stops for. */
  const forget = (member: Member): void => {
    clearTimeout(member.helloTimer);
    const seat = seatOf(member);
    member.state = { phase: 'gone', seat: null };
    member.staging?.cancel();
    member.staging = null;
    members.delete(member);
    const count = (perAddress.get(member.address) ?? 1) - 1;
    if (count === 0) {
      perAddress.delete(member.address);
    } else {
      perAddress.set(member.address, count);
    }
    if (seat !== null) {
      leavePlace(seat.place, member, seat.number);
    }
  };
  /** Takes a new connection, refusing it beyond the connections of the relay, of one address, or how fast an address may connect. */
  const accept = (socket: WebSocket, request: IncomingMessage): void => {
    const address = addressOf(request, config.trustProxy);
    const member: Member = {
      socket,
      address,
      frames: createBucket(FRAME_RATE, now),
      queue: createSendQueue(sending.maxQueuedBytes),
      staging: null,
      state: { phase: 'waiting' },
      alive: true,
      helloTimer: undefined,
    };
    members.add(member);
    perAddress.set(address, (perAddress.get(address) ?? 0) + 1);
    socket.on('message', (data, isBinary) => {
      receive(member, data, isBinary);
    });
    socket.on('pong', () => {
      member.alive = true;
    });
    socket.on('error', (error) => {
      console.warn('A connection to the relay failed:', error.message);
    });
    socket.on('close', () => {
      forget(member);
    });
    const refusal = admissionRefusal(address);
    if (refusal !== null) {
      refuse(member, refusal);
      return;
    }
    member.helloTimer = setTimeout(() => {
      if (member.state.phase === 'waiting') {
        refuse(member, 'MALFORMED');
      }
    }, timings.helloMilliseconds);
  };
  /** Tells why a new connection from an address cannot stay, or null when it can. */
  const admissionRefusal = (address: string): RelayRefusal | null => {
    if (members.size > config.maxConnections) {
      return 'RELAY_FULL';
    }
    if ((perAddress.get(address) ?? 0) > config.maxConnectionsPerAddress) {
      return 'TOO_MANY';
    }
    return admit(address) ? null : 'TOO_FAST';
  };
  /** Pings every connection and cuts the ones that did not answer since the last ping, as when a computer was switched off. */
  const beat = (): void => {
    members.forEach((member) => {
      if (!member.alive) {
        member.socket.terminate();
        return;
      }
      member.alive = false;
      member.socket.ping();
    });
  };
  /** Removes the rooms nobody opened for longer than the relay keeps them. */
  const sweep = (): void => {
    store
      .expire()
      .then((count) => {
        if (count > 0) {
          console.info(`${String(count)} rooms nobody opened for a long time were removed.`);
        }
      })
      .catch((error: unknown) => {
        console.error('The rooms nobody opens could not be removed:', error);
      });
  };

  sockets.on('connection', accept);
  sockets.on('error', (error) => {
    console.error('The relay failed:', error);
  });
  http.on('request', (_request, response) => {
    response.writeHead(UPGRADE_REQUIRED, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('This address is a Tasklace relay.\n');
  });
  const port = await listen(http, config);
  const heartbeat = setInterval(beat, timings.heartbeatMilliseconds);
  const sweeping = setInterval(sweep, timings.sweepMilliseconds);
  sweep();
  return {
    port,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(sweeping);
      members.forEach((member) => {
        member.socket.close(CLOSE_GOING_AWAY);
      });
      const cut = setTimeout(() => {
        members.forEach((member) => {
          member.socket.terminate();
        });
        http.closeAllConnections();
      }, timings.closeMilliseconds);
      await new Promise<void>((resolve) => {
        sockets.close(() => {
          http.close(() => {
            resolve();
          });
        });
      });
      clearTimeout(cut);
      [...members].forEach(forget);
      await store.settle();
    },
  };
}

/** Gives the place and number a member holds in a room, in it or gone from it, or null when it never got in. */
function seatOf(member: Member): Seat | null {
  const { state } = member;
  return state.phase === 'in' || state.phase === 'gone' ? state.seat : null;
}

/** Makes the web server the relay listens on, with the certificate of its settings when it has one. */
async function serverOf(config: RelayConfig): Promise<Server> {
  if (config.tls === null) {
    return createHttpServer();
  }
  const [cert, key] = await Promise.all([
    readFile(config.tls.certificateFile),
    readFile(config.tls.keyFile),
  ]);
  return createHttpsServer({ cert, key });
}

/** Listens on the address and port of the settings, giving the port actually taken. */
async function listen(http: Server, config: RelayConfig): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const bound = http.address();
  return typeof bound === 'object' && bound !== null ? bound.port : config.port;
}

/** Gives the address a connection comes from, the last one a proxy in front of the relay added when the settings trust it. */
function addressOf(request: IncomingMessage, trustProxy: boolean): string {
  const forwarded = request.headers[FORWARDED_FOR];
  const last = typeof forwarded === 'string' ? forwarded.split(',').at(-1)?.trim() : undefined;
  if (trustProxy && last !== undefined && last !== '') {
    return last;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

/** Gives the bytes of a frame received, copied into their own memory. */
function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data));
  }
  return new Uint8Array(data);
}

/** Sends a frame at once to a connection still open, ahead of what waits. */
function sendNow(socket: WebSocket, frame: RelayFrame): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(encodeRelayFrame(frame));
  }
}
