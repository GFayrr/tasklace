import { MAX_RELAY_ADDRESS_LENGTH, MAX_RELAY_LINK_LENGTH } from '../../limits';
import { failure, success, type Result } from '../../result';
import { FIRST_PORT, LAST_PORT } from '../ports';
import { decodeBase64Url, encodeBase64Url } from './base64url';
import {
  RELAY_KEY_BYTES,
  readRelayReadKey,
  readSigningSeed,
  readVerifyKey,
  type RelayAccess,
} from './relay-keys';

export interface RelayAddress {
  readonly host: string;
  readonly port: number | null;
  readonly path: string;
}

export interface RelayLink {
  readonly address: RelayAddress;
  readonly access: RelayAccess;
}

export interface RelayLinkPreview {
  readonly relay: string;
  readonly canEdit: boolean;
}

export type AddressRefusal = 'INVALID_ADDRESS' | 'NOT_SECURE';

const MAX_HOST_LENGTH = 253;
const MAX_PATH_LENGTH = 256;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const SECURE_SCHEME = 'wss';
const LOOPBACK_SCHEME = 'ws';
const LINK_SCHEME = 'tasklace';
const EDIT_MARK = 'e1';
const LINK_KEY_BYTES = RELAY_KEY_BYTES + RELAY_KEY_BYTES;
const VIEW_MARK = 'v1';
const LINK_KEYS_TEXT_LENGTH = encodeBase64Url(new Uint8Array(LINK_KEY_BYTES)).length;
const SHOWN_KEY_CHARACTERS = 6;
const LEFT_OUT = '…';
const ADDRESS_PATTERN = /^([a-z]+):\/\/([^/:[\]]+|\[[^\]]*\])(?::(\d{1,5}))?(\/[^#?]*)?$/i;
const LINK_PATTERN =
  /^tasklace:\/\/([^/:[\]]+|\[[^\]]*\])(?::(\d{1,5}))?(\/[^#?]*)?#([ev]1)\.([A-Za-z0-9_-]+)$/;
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV6_PATTERN = /^\[[0-9a-f:.]{2,45}\]$/;
const PATH_PATTERN = /^(\/[A-Za-z0-9._~-]*)+$/;

/** Reads the address of a relay a person typed, refusing anything but wss:// to a host name or address with an optional port and path, ws:// being let through only to this computer, where there is nothing to encrypt the connection against. */
export function readRelayAddress(text: string): Result<RelayAddress, AddressRefusal> {
  const trimmed = text.trim();
  const match = trimmed.length > MAX_RELAY_ADDRESS_LENGTH ? null : ADDRESS_PATTERN.exec(trimmed);
  if (match === null) {
    return failure('INVALID_ADDRESS');
  }
  const [, scheme = '', host = '', port, path] = match;
  const address = addressOf(host, port, path);
  if (address === null) {
    return failure('INVALID_ADDRESS');
  }
  const expected = isLoopback(address) ? [SECURE_SCHEME, LOOPBACK_SCHEME] : [SECURE_SCHEME];
  return expected.includes(scheme.toLowerCase()) ? success(address) : failure('NOT_SECURE');
}

/** Gives the address the connection to a relay opens: wss:// except to this computer. */
export function relayUrlOf(address: RelayAddress): string {
  const scheme = isLoopback(address) ? LOOPBACK_SCHEME : SECURE_SCHEME;
  return `${scheme}://${hostLabelOf(address)}${address.path}`;
}

/** Gives the relay as a person reads it: its host, and its port when there is one. */
export function hostLabelOf(address: RelayAddress): string {
  return address.port === null ? address.host : `${address.host}:${String(address.port)}`;
}

/** Writes the link that lets a person join a plan through a relay, the keys after the # so that they never reach any server. */
export function encodeRelayLink(link: RelayLink): string {
  const { access } = link;
  const [mark, secondKey] =
    access.kind === 'edit' ? [EDIT_MARK, access.seed] : [VIEW_MARK, access.verifyKey];
  const keys = new Uint8Array(LINK_KEY_BYTES);
  keys.set(access.readKey);
  keys.set(secondKey, RELAY_KEY_BYTES);
  return `${LINK_SCHEME}://${hostLabelOf(link.address)}${link.address.path}#${mark}.${encodeBase64Url(keys)}`;
}

/** Reads a link a person pasted, refusing without ever throwing anything that is not exactly the link of a plan shared through a relay. */
export function readRelayLink(text: string): Result<RelayLink, 'INVALID_LINK'> {
  const trimmed = text.trim();
  const match = trimmed.length > MAX_RELAY_LINK_LENGTH ? null : LINK_PATTERN.exec(trimmed);
  if (match === null) {
    return failure('INVALID_LINK');
  }
  const [, host = '', port, path, mark, keys = ''] = match;
  const address = addressOf(host, port, path);
  const access = accessOf(mark === EDIT_MARK, decodeBase64Url(keys));
  return address === null || access === null
    ? failure('INVALID_LINK')
    : success({ address, access });
}

/** Tells what a link a person pasted leads to, its relay and whether it edits, from its form alone without ever reading its keys, or returns null for text that cannot be such a link. */
export function previewRelayLink(text: string): RelayLinkPreview | null {
  const trimmed = text.trim();
  const match = trimmed.length > MAX_RELAY_LINK_LENGTH ? null : LINK_PATTERN.exec(trimmed);
  if (match === null) {
    return null;
  }
  const [, host = '', port, path, mark, keys = ''] = match;
  const address = addressOf(host, port, path);
  return address === null || keys.length !== LINK_KEYS_TEXT_LENGTH
    ? null
    : { relay: hostLabelOf(address), canEdit: mark === EDIT_MARK };
}

/** Writes a link as a person may see it on screen, its keys cut after their first characters so that the page never holds them. */
export function shownRelayLink(link: RelayLink): string {
  const written = encodeRelayLink(link);
  const keysStart = written.indexOf('#') + `#${EDIT_MARK}.`.length;
  return `${written.slice(0, keysStart + SHOWN_KEY_CHARACTERS)}${LEFT_OUT}`;
}

/** Tells whether a relay runs on this computer. */
export function isLoopback(address: RelayAddress): boolean {
  return LOOPBACK_HOSTS.has(address.host);
}

/** Checks the host, port and path of an address, the host in lower case and the path / when none is given, or returns null for any part that is not one. */
function addressOf(
  rawHost: string,
  rawPort: string | undefined,
  rawPath: string | undefined,
): RelayAddress | null {
  const host = rawHost.toLowerCase();
  const isHost =
    host.length <= MAX_HOST_LENGTH && (NAME_PATTERN.test(host) || IPV6_PATTERN.test(host));
  const port = rawPort === undefined ? null : Number(rawPort);
  const isPort = port === null || (port >= FIRST_PORT && port <= LAST_PORT);
  const path = rawPath === undefined || rawPath === '' ? '/' : rawPath;
  const isPath = path.length <= MAX_PATH_LENGTH && PATH_PATTERN.test(path);
  return isHost && isPort && isPath ? { host, port, path } : null;
}

/** Splits the keys of a link into the key that reads the plan and the seed that signs, or the key that checks signatures, or returns null when they are not exactly that. */
function accessOf(canEdit: boolean, keys: Uint8Array | null): RelayAccess | null {
  if (keys?.length !== LINK_KEY_BYTES) {
    return null;
  }
  const readKey = readRelayReadKey(keys.slice(0, RELAY_KEY_BYTES));
  const second = keys.slice(RELAY_KEY_BYTES);
  if (readKey === null) {
    return null;
  }
  if (canEdit) {
    const seed = readSigningSeed(second);
    return seed === null ? null : { kind: 'edit', readKey, seed };
  }
  const verifyKey = readVerifyKey(second);
  return verifyKey === null ? null : { kind: 'view', readKey, verifyKey };
}
