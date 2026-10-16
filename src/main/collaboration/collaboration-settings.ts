import { MAX_PARTICIPANT_NAME_LENGTH } from '../../core/limits';
import { createIssueList } from '../../core/validation/validation-issues';
import { readText } from '../../core/validation/value-readers';
import type { CollaborationSettings } from '../../preload/bridge-contract';
import { writeFileSafely } from '../safe-write';
import { parseStoredJson, readStoredText, setDamagedFileAside } from '../stored-files';
import { isPort } from './guest-client';
import { DEFAULT_COLLABORATION_PORT } from './host-server';

export const DEFAULT_COLLABORATION_SETTINGS: CollaborationSettings = {
  name: null,
  port: DEFAULT_COLLABORATION_PORT,
  firewallNoticeSeen: false,
};

const STORE_VERSION = 1;
const SETTINGS_KEYS = ['name', 'port', 'firewallNoticeSeen'];

/** Reads collaboration settings from an untrusted value, as the page or the store gives them: a name that is null or a well-formed name of a participant, a port and whether the note about the firewall was seen, nothing else. */
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
  const issues = createIssueList();
  const readName =
    name === null
      ? null
      : readText({ value: name, path: 'name' }, issues, MAX_PARTICIPANT_NAME_LENGTH);
  if (
    readName === undefined ||
    typeof port !== 'number' ||
    !isPort(port) ||
    typeof firewallNoticeSeen !== 'boolean'
  ) {
    return null;
  }
  return { name: readName, port, firewallNoticeSeen };
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
