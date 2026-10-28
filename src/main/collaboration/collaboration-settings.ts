import { DEFAULT_COLLABORATION_PORT, isPort } from '../../core/collaboration/ports';
import { readRelayAddress } from '../../core/collaboration/relay/relay-link';
import { MAX_PARTICIPANT_NAME_LENGTH } from '../../core/limits';
import { createIssueList } from '../../core/validation/validation-issues';
import { readText } from '../../core/validation/value-readers';
import type { CollaborationSettings } from '../../preload/bridge-contract';
import { writeFileSafely } from '../safe-write';
import { parseStoredJson, readStoredText, setDamagedFileAside } from '../stored-files';

export const DEFAULT_COLLABORATION_SETTINGS: CollaborationSettings = {
  name: null,
  port: DEFAULT_COLLABORATION_PORT,
  firewallNoticeSeen: false,
  relayAddress: null,
};

const STORE_VERSION = 1;
const SETTINGS_KEYS = ['name', 'port', 'firewallNoticeSeen', 'relayAddress'];

/** Reads collaboration settings from an untrusted value, as the page or the store gives them: a name of a participant or null, a port, whether the note about the firewall was seen and the address of a relay, missing meaning none. */
export function readCollaborationSettings(value: unknown): CollaborationSettings | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).some((key) => !SETTINGS_KEYS.includes(key))
  ) {
    return null;
  }
  const name: unknown = Reflect.get(value, 'name');
  const port: unknown = Reflect.get(value, 'port');
  const firewallNoticeSeen: unknown = Reflect.get(value, 'firewallNoticeSeen');
  const relayAddress: unknown = Reflect.get(value, 'relayAddress') ?? null;
  const issues = createIssueList();
  const readName =
    name === null
      ? null
      : readText({ value: name, path: 'name' }, issues, MAX_PARTICIPANT_NAME_LENGTH);
  if (
    readName === undefined ||
    typeof port !== 'number' ||
    !isPort(port) ||
    typeof firewallNoticeSeen !== 'boolean' ||
    !(relayAddress === null || isRelayAddress(relayAddress))
  ) {
    return null;
  }
  return { name: readName, port, firewallNoticeSeen, relayAddress };
}

/** Tells whether a value is the address of a relay the application connects to, exactly as a person typed it without spaces around. */
function isRelayAddress(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && readRelayAddress(value).ok;
}

/** Reads the collaboration settings of this computer from their store, a missing store giving the defaults and a damaged one being set aside before the defaults are used. */
export async function loadCollaborationSettings(storePath: string): Promise<CollaborationSettings> {
  const text = await readStoredText(storePath);
  if (text === '') {
    return DEFAULT_COLLABORATION_SETTINGS;
  }
  const data = parseStoredJson(text);
  const settings =
    Reflect.get(Object(data), 'version') === STORE_VERSION
      ? readCollaborationSettings(Reflect.get(Object(data), 'settings'))
      : null;
  if (settings !== null) {
    return settings;
  }
  await setDamagedFileAside(storePath, new Date(), 'The file of the collaboration settings');
  return DEFAULT_COLLABORATION_SETTINGS;
}

/** Writes the collaboration settings of this computer to their store. */
export function storeCollaborationSettings(
  storePath: string,
  settings: CollaborationSettings,
): Promise<void> {
  return writeFileSafely(storePath, JSON.stringify({ version: STORE_VERSION, settings }));
}
