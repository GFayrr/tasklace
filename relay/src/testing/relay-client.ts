import { WebSocket, type ClientOptions } from 'ws';
import type { RelayKeys } from '../../../src/core/collaboration/relay/relay-keys';
import {
  encodeClientFrame,
  readRelayFrame,
  signedCloseBytes,
  signedCreateBytes,
  type ClientFrame,
  type RelayFrame,
} from '../../../src/core/collaboration/relay/relay-wire';
import { readConfig, type RelayConfig } from '../config.ts';

export interface TestClient {
  readonly socket: WebSocket;
  readonly send: (frame: ClientFrame) => void;
  readonly next: () => Promise<RelayFrame | 'UNSUPPORTED_VERSION' | null>;
  readonly closed: Promise<number>;
  readonly received: () => readonly (RelayFrame | 'UNSUPPORTED_VERSION' | null)[];
}

const WAIT_MILLISECONDS = 5_000;

/** Gives the settings of a relay listening on a free port of this computer and keeping its rooms in a folder. */
export function testConfig(folder: string, environment: Record<string, string> = {}): RelayConfig {
  const read = readConfig({ RELAY_PORT: '0', RELAY_DATA_DIR: folder, ...environment });
  if (!read.ok) {
    throw new Error(read.problem);
  }
  return read.config;
}

/** Connects to a relay of this computer, reading every frame it sends and waiting for them one by one. */
export async function connectTo(port: number, options: ClientOptions = {}): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/plans`, options);
  const frames: (RelayFrame | 'UNSUPPORTED_VERSION' | null)[] = [];
  let read = 0;
  let wake: (() => void) | null = null;
  socket.on('message', (data: Buffer) => {
    frames.push(readRelayFrame(new Uint8Array(data)));
    wake?.();
  });
  const closed = new Promise<number>((resolve) => {
    socket.on('close', (code) => {
      resolve(code);
      wake?.();
    });
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    send: (frame) => {
      socket.send(encodeClientFrame(frame));
    },
    next: async () => {
      const deadline = Date.now() + WAIT_MILLISECONDS;
      while (read >= frames.length) {
        if (socket.readyState === socket.CLOSED || Date.now() > deadline) {
          throw new Error(`No frame came after ${JSON.stringify(frames)}.`);
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, WAIT_MILLISECONDS);
        });
      }
      read += 1;
      return frames[read - 1] ?? null;
    },
    closed,
    received: () => frames,
  };
}

/** Gives the frame that creates the room of some keys, signed by them. */
export function createFrame(keys: RelayKeys): ClientFrame {
  return {
    type: 'create',
    roomId: keys.roomId,
    verifyKey: keys.verifyKey,
    signature: signed(keys, signedCreateBytes(keys.roomId, keys.verifyKey)),
  };
}

/** Gives the frame that closes the room of some keys for good, signed by them. */
export function closeFrame(keys: RelayKeys): ClientFrame {
  return { type: 'close', signature: signed(keys, signedCloseBytes(keys.roomId)) };
}

/** Signs bytes with keys that may sign. */
function signed(keys: RelayKeys, bytes: Uint8Array): Uint8Array {
  if (keys.sign === null) {
    throw new Error('These keys cannot sign.');
  }
  return keys.sign(bytes);
}
