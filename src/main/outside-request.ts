import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRelayLink } from '../core/collaboration/relay/relay-link';
import { MAX_WAITING_OUTSIDE_FILES } from '../core/limits';
import { success } from '../core/result';
import { IPC_CHANNELS, type OutsideRequest } from '../preload/bridge-contract';
import { handleChannel } from './ipc-channels';
import type { TrustCheck } from './ipc-trust';
import { isStoredPath } from './stored-files';

export type ReceivedRequest =
  | { readonly kind: 'file'; readonly path: string; readonly unopened: number }
  | { readonly kind: 'link'; readonly link: string }
  | { readonly kind: 'unreadable'; readonly what: 'file' | 'link' };

export interface OutsideRequests {
  readonly receive: (argv: readonly string[]) => void;
  readonly answer: (assertTrusted: TrustCheck, notify: () => void) => void;
  readonly takeFile: (id: number) => string | null;
}

const PROJECT_EXTENSION = '.tasklace';
const LINK_START = 'tasklace:';
const FILE_SCHEME = 'file:';
const FILE_ADDRESS_START = 'file://';
const ARGUMENTS_SEPARATOR = '--';
const PROGRAM_ARGUMENTS = 1;

/** Gives the path of a whole file address of this computer, as the Linux desktop passes a file, or null for an address that is malformed, relative or names another computer. */
function pathOfFileAddress(value: string): string | null {
  if (!value.toLowerCase().startsWith(FILE_ADDRESS_START)) {
    return null;
  }
  try {
    const address = new URL(value);
    return address.hostname === '' ? fileURLToPath(address) : null;
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) {
      return null;
    }
    throw error;
  }
}

/** Counts what came along with the last argument after the separator, as the Linux desktop passes every file chosen at once. */
function unopenedAlongside(argv: readonly string[]): number {
  const separator = argv.indexOf(ARGUMENTS_SEPARATOR);
  return separator === -1 ? 0 : Math.max(argv.length - separator - 2, 0);
}

/** Logs, without its text, a project file that cannot be used, and says so. */
function unreadableFile(): ReceivedRequest {
  console.warn('Tasklace was started with a project file whose path it cannot use.');
  return { kind: 'unreadable', what: 'file' };
}

/** Reads a last argument that is not a link as a project file, ignoring a file of another kind, and logging how many files came along with it. */
function readFileRequest(value: string, argv: readonly string[]): ReceivedRequest | null {
  const path = value.toLowerCase().startsWith(FILE_SCHEME) ? pathOfFileAddress(value) : value;
  if (path === null) {
    return unreadableFile();
  }
  if (extname(path).toLowerCase() !== PROJECT_EXTENSION) {
    return null;
  }
  if (!isStoredPath(path)) {
    return unreadableFile();
  }
  const unopened = unopenedAlongside(argv);
  if (unopened > 0) {
    console.warn(`Tasklace was started with ${String(unopened + 1)} files and opens the last one.`);
  }
  return { kind: 'file', path, unopened };
}

/** Reads the project file, as a path or a file address, or the link Tasklace was started with from its last argument, put after the separator that keeps it from being an option, ignoring anything else. */
export function readOutsideRequest(argv: readonly string[]): ReceivedRequest | null {
  const value = argv.length > PROGRAM_ARGUMENTS ? argv.at(-1) : undefined;
  if (value === undefined) {
    return null;
  }
  if (value.toLowerCase().startsWith(LINK_START)) {
    if (readRelayLink(value).ok) {
      return { kind: 'link', link: value.trim() };
    }
    console.warn('Tasklace was started with a link it cannot read.');
    return { kind: 'unreadable', what: 'link' };
  }
  return readFileRequest(value, argv);
}

/** Keeps the latest file or link Tasklace was started with from its first launch on until the page takes it, each file taken getting its own number under which its path stays in the main process. */
export function createOutsideRequests(): OutsideRequests {
  let waiting: ReceivedRequest | null = null;
  let tell: (() => void) | null = null;
  let nextId = 0;
  const files = new Map<number, string>();
  return {
    receive: (argv) => {
      const request = readOutsideRequest(argv);
      if (request !== null) {
        waiting = request;
        tell?.();
      }
    },
    answer: (assertTrusted, notify) => {
      tell = notify;
      handleChannel(assertTrusted, IPC_CHANNELS.takeOutsideRequest, () => {
        const taken = waiting;
        waiting = null;
        if (taken?.kind !== 'file') {
          return success(taken);
        }
        nextId += 1;
        files.set(nextId, taken.path);
        for (const id of [...files.keys()].slice(0, -MAX_WAITING_OUTSIDE_FILES)) {
          files.delete(id);
        }
        return success({
          kind: 'file',
          id: nextId,
          unopened: taken.unopened,
        } satisfies OutsideRequest);
      });
    },
    takeFile: (id) => {
      const path = files.get(id) ?? null;
      files.delete(id);
      return path;
    },
  };
}
