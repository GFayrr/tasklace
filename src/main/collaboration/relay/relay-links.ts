import type { SafeStorage } from 'electron';
import {
  encodeRelayLink,
  readRelayLink,
  type RelayLink,
} from '../../../core/collaboration/relay/relay-link';
import { MAX_KEPT_RELAY_LINKS, MAX_SEALED_RELAY_LINK_LENGTH } from '../../../core/limits';
import { failure, success, type Result } from '../../../core/result';
import { isDocumentId, type DocumentId } from '../../../core/shared/shared-document';
import { writeFileSafely } from '../../safe-write';
import { parseStoredJson, readStoredText, setDamagedFileAside } from '../../stored-files';

export interface Vault {
  readonly isAvailable: () => boolean;
  readonly seal: (text: string) => Uint8Array;
  readonly open: (sealed: Uint8Array) => string;
}

export type SystemSafeStorage = Pick<
  SafeStorage,
  'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'
>;

export interface RelayLinkStore {
  readonly keep: (
    documentId: DocumentId,
    link: RelayLink,
  ) => Promise<Result<void, 'NO_SAFE_STORAGE'>>;
  readonly find: (documentId: DocumentId) => Promise<Result<RelayLink | null, 'LINK_UNREADABLE'>>;
  readonly forget: (documentId: DocumentId) => Promise<void>;
}

interface KeptLink {
  readonly documentId: DocumentId;
  readonly sealed: string;
}

interface LinkStoreReading {
  readonly links: readonly KeptLink[];
  readonly damaged: boolean;
}

const STORE_VERSION = 1;
const LINK_KEYS = ['documentId', 'sealed'];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const LINUX = 'linux';
const UNPROTECTED_BACKENDS: ReadonlySet<string> = new Set(['basic_text', 'unknown']);

/** Gives the vault of the system that keeps the links of shared plans, available only when it really protects them: never with the plain text store Linux falls back on. */
export function vaultOf(storage: SystemSafeStorage, platform: NodeJS.Platform): Vault {
  return {
    isAvailable: () =>
      storage.isEncryptionAvailable() &&
      (platform !== LINUX || !UNPROTECTED_BACKENDS.has(storage.getSelectedStorageBackend())),
    seal: (text) => storage.encryptString(text),
    open: (sealed) => storage.decryptString(Buffer.from(sealed)),
  };
}

/** Parses the untrusted text of the store of links, keeping each well-formed entry once, within the limit, and tells whether it was unreadable or held a malformed entry, an empty text from a missing store being neither. */
export function readLinkStore(text: string): LinkStoreReading {
  if (text === '') {
    return { links: [], damaged: false };
  }
  const data = parseStoredJson(text);
  const links: unknown = Reflect.get(Object(data), 'links');
  if (Reflect.get(Object(data), 'version') !== STORE_VERSION || !Array.isArray(links)) {
    return { links: [], damaged: true };
  }
  const kept = links.filter(isKeptLink);
  const unique = kept.filter(
    (link, index) => kept.findIndex((other) => other.documentId === link.documentId) === index,
  );
  return {
    links: unique.slice(0, MAX_KEPT_RELAY_LINKS),
    damaged: unique.length !== links.length || unique.length > MAX_KEPT_RELAY_LINKS,
  };
}

/** Tells whether a stored value is exactly an entry of the store: the identifier of a plan and its link sealed by the vault, in base64 of reasonable length. */
function isKeptLink(value: unknown): value is KeptLink {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const documentId: unknown = Reflect.get(value, 'documentId');
  const sealed: unknown = Reflect.get(value, 'sealed');
  return (
    Object.keys(value).every((key) => LINK_KEYS.includes(key)) &&
    isDocumentId(documentId) &&
    typeof sealed === 'string' &&
    sealed.length <= MAX_SEALED_RELAY_LINK_LENGTH &&
    BASE64.test(sealed)
  );
}

/** Keeps the links of the plans this computer shares through a relay, one per plan, sealed by the vault of the system so that they never lie on the disk in clear, the most recent first within the limit. */
export function createRelayLinkStore(storePath: string, vault: Vault): RelayLinkStore {
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs a step on the store after the ones before it, so that two windows never write over each other. */
  const inOrder = <T>(step: () => Promise<T>): Promise<T> => {
    const done = queue.then(step, step);
    queue = done;
    return done;
  };
  /** Reads the entries of the store, setting a damaged store aside and writing its valid entries back, a failed write being only logged. */
  const read = async (): Promise<readonly KeptLink[]> => {
    const { links, damaged } = readLinkStore(await readStoredText(storePath));
    if (damaged) {
      await setDamagedFileAside(storePath, new Date(), 'The links of shared plans');
      await write(links).catch((error: unknown) => {
        console.error('The repaired links of shared plans could not be written:', error);
      });
    }
    return links;
  };
  /** Writes the entries of the store. */
  const write = (links: readonly KeptLink[]): Promise<void> =>
    writeFileSafely(storePath, JSON.stringify({ version: STORE_VERSION, links }));
  return {
    keep: (documentId, link) =>
      inOrder(async () => {
        if (!vault.isAvailable()) {
          return failure('NO_SAFE_STORAGE');
        }
        const sealed = Buffer.from(vault.seal(encodeRelayLink(link))).toString('base64');
        const others = (await read()).filter((kept) => kept.documentId !== documentId);
        await write([{ documentId, sealed }, ...others].slice(0, MAX_KEPT_RELAY_LINKS));
        return success(undefined);
      }),
    find: (documentId) =>
      inOrder(async (): Promise<Result<RelayLink | null, 'LINK_UNREADABLE'>> => {
        const kept = (await read()).find((link) => link.documentId === documentId);
        if (kept === undefined) {
          return success(null);
        }
        if (!vault.isAvailable()) {
          console.warn(
            'The link of a shared plan is kept, but the vault of the system cannot open it now.',
          );
          return failure('LINK_UNREADABLE');
        }
        const link = opened(vault, kept);
        return link === null ? failure('LINK_UNREADABLE') : success(link);
      }),
    forget: (documentId) =>
      inOrder(async () => {
        const links = await read();
        const others = links.filter((kept) => kept.documentId !== documentId);
        if (others.length !== links.length) {
          await write(others);
        }
      }),
  };
}

/** Opens a kept link, giving null and a warning for one the vault can no longer open, as after the account changed, or that no longer reads as a link. */
function opened(vault: Vault, kept: KeptLink): RelayLink | null {
  let text: string;
  try {
    text = vault.open(Buffer.from(kept.sealed, 'base64'));
  } catch (error) {
    console.warn('The link of a shared plan could not be opened:', error);
    return null;
  }
  const link = readRelayLink(text);
  if (!link.ok) {
    console.warn('The link kept for a shared plan is not a link.');
    return null;
  }
  return link.value;
}
