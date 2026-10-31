import { extname } from 'node:path';
import { readRelayLink } from '../core/collaboration/relay/relay-link';
import { success } from '../core/result';
import { IPC_CHANNELS, type OutsideRequest } from '../preload/bridge-contract';
import { handleChannel } from './ipc-channels';
import type { TrustCheck } from './ipc-trust';
import { isStoredPath } from './stored-files';

export type ReceivedRequest =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'link'; readonly link: string };

export interface OutsideRequests {
  readonly receive: (argv: readonly string[]) => void;
  readonly takeFile: () => string | null;
}

const PROJECT_EXTENSION = '.tasklace';
const LINK_START = 'tasklace:';
const PROGRAM_ARGUMENTS = 1;

/** Reads the project file or link Tasklace was started with from the last argument, put after the separator that keeps it from being read as an option, ignoring anything else and logging, without its text that may hold keys, what looked like one. */
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
    return null;
  }
  if (extname(value).toLowerCase() !== PROJECT_EXTENSION) {
    return null;
  }
  if (isStoredPath(value)) {
    return { kind: 'file', path: value };
  }
  console.warn('Tasklace was started with a project file whose path it cannot use.');
  return null;
}

/** Keeps the latest file or link Tasklace was started with from outside until the page takes it, telling the page each time a new one arrives, the path of a file staying in the main process until the page asks to open it. */
export function registerOutsideRequests(services: {
  readonly assertTrusted: TrustCheck;
  readonly notify: () => void;
}): OutsideRequests {
  let waiting: ReceivedRequest | null = null;
  let file: string | null = null;
  handleChannel(services.assertTrusted, IPC_CHANNELS.takeOutsideRequest, () => {
    const taken = waiting;
    waiting = null;
    if (taken?.kind === 'file') {
      file = taken.path;
    }
    return success(shownRequest(taken));
  });
  return {
    receive: (argv) => {
      const request = readOutsideRequest(argv);
      if (request !== null) {
        waiting = request;
        services.notify();
      }
    },
    takeFile: () => {
      const taken = file;
      file = null;
      return taken;
    },
  };
}

/** Gives the page what arrived from outside, the link it fills in the join window or only the kind for a file, whose path the page never holds. */
function shownRequest(request: ReceivedRequest | null): OutsideRequest | null {
  if (request === null) {
    return null;
  }
  return request.kind === 'file' ? { kind: 'file' } : request;
}
