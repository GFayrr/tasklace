import { extname } from 'node:path';
import { readRelayLink } from '../core/collaboration/relay/relay-link';
import { MAX_WAITING_OUTSIDE_FILES } from '../core/limits';
import { success } from '../core/result';
import { IPC_CHANNELS, type OutsideRequest } from '../preload/bridge-contract';
import { handleChannel } from './ipc-channels';
import type { TrustCheck } from './ipc-trust';
import { isStoredPath } from './stored-files';

export type ReceivedRequest =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'link'; readonly link: string }
  | { readonly kind: 'unreadable'; readonly what: 'file' | 'link' };

export interface OutsideRequests {
  readonly receive: (argv: readonly string[]) => void;
  readonly answer: (assertTrusted: TrustCheck, notify: () => void) => void;
  readonly takeFile: (id: number) => string | null;
}

const PROJECT_EXTENSION = '.tasklace';
const LINK_START = 'tasklace:';
const PROGRAM_ARGUMENTS = 1;

/** Reads the project file or link Tasklace was started with from its last argument, put after the separator that keeps it from being an option, ignoring anything else and logging, without its text, what looked like one but cannot be used. */
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
  if (extname(value).toLowerCase() !== PROJECT_EXTENSION) {
    return null;
  }
  if (isStoredPath(value)) {
    return { kind: 'file', path: value };
  }
  console.warn('Tasklace was started with a project file whose path it cannot use.');
  return { kind: 'unreadable', what: 'file' };
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
        return success({ kind: 'file', id: nextId } satisfies OutsideRequest);
      });
    },
    takeFile: (id) => {
      const path = files.get(id) ?? null;
      files.delete(id);
      return path;
    },
  };
}
