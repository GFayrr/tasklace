import { connect, createServer, type Server, type Socket } from 'node:net';
import { MAX_TASK_NAME_LENGTH } from '../../core/limits';
import { LOOPBACK } from './plan-host';

export interface TcpRelay {
  readonly port: number;
  readonly targetBytes: () => number;
  readonly clientBytes: () => number;
  readonly cut: () => void;
  readonly freeze: () => void;
  readonly tamper: () => void;
  readonly close: () => Promise<void>;
}

export interface TcpCuts {
  readonly afterTargetBytes?: number;
  readonly afterClientBytes?: number;
}

const LARGE_PLAN_SEED = 0x7a5c_1ace;
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const XORSHIFT_SHIFTS = [13, 17, 5] as const;

/** Starts a plain TCP relay between a client and a target chosen at each connection, which cuts every connection without a word, on demand or after some bytes either way, and can freeze or change the next byte of the target. */
export async function startTcpRelay(target: () => number, cuts: TcpCuts = {}): Promise<TcpRelay> {
  const sockets = new Set<Socket>();
  let targetBytes = 0;
  let clientBytes = 0;
  let cutAfterTargetBytes = cuts.afterTargetBytes ?? Number.POSITIVE_INFINITY;
  let cutAfterClientBytes = cuts.afterClientBytes ?? Number.POSITIVE_INFINITY;
  let frozen = false;
  let tampering = false;
  /** Destroys every connection passing through the relay. */
  const cut = (): void => {
    sockets.forEach((socket) => socket.destroy());
    sockets.clear();
  };
  const server: Server = createServer((clientSide) => {
    const targetSide = connect(target(), LOOPBACK);
    sockets.add(clientSide);
    sockets.add(targetSide);
    clientSide.on('data', (chunk: Buffer) => {
      if (!frozen) {
        targetSide.write(chunk);
      }
      clientBytes += chunk.length;
      if (clientBytes > cutAfterClientBytes) {
        cutAfterClientBytes = Number.POSITIVE_INFINITY;
        cut();
      }
    });
    targetSide.on('data', (chunk: Buffer) => {
      if (tampering && chunk.length > 0) {
        tampering = false;
        chunk[chunk.length - 1] = (chunk[chunk.length - 1] ?? 0) ^ 1;
      }
      if (!frozen) {
        clientSide.write(chunk);
      }
      targetBytes += chunk.length;
      if (targetBytes > cutAfterTargetBytes) {
        cutAfterTargetBytes = Number.POSITIVE_INFINITY;
        cut();
      }
    });
    clientSide.on('error', () => undefined);
    targetSide.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    targetBytes: () => targetBytes,
    clientBytes: () => clientBytes,
    cut,
    freeze: () => {
      frozen = true;
    },
    tamper: () => {
      tampering = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Writes names of the longest length from letters drawn with a fixed seed, so that the plan they fill hardly compresses. */
export function drawnNames(count: number): string[] {
  let state = LARGE_PLAN_SEED;
  const [left, right, last] = XORSHIFT_SHIFTS;
  /** Draws the next letter. */
  const letter = (): string => {
    state ^= state << left;
    state ^= state >>> right;
    state ^= state << last;
    return LETTERS[(state >>> 0) % LETTERS.length] ?? 'a';
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: MAX_TASK_NAME_LENGTH }, letter).join(''),
  );
}
