import { isWindowsExecutablePath } from '../platform/this-copy';
import { writeFileSafely } from '../safe-write';
import { parseStoredJson, readStoredText, setDamagedFileAside } from '../stored-files';

export interface SetupSettings {
  readonly welcomed: boolean;
  readonly registeredExecutable: string | null;
}

export const DEFAULT_SETUP_SETTINGS: SetupSettings = {
  welcomed: false,
  registeredExecutable: null,
};

const STORE_VERSION = 1;
const SETTINGS_KEYS = ['welcomed', 'registeredExecutable'];

/** Reads what this computer knows of the setup of Tasklace from an untrusted value, or returns null when it is not exactly such settings. */
export function readSetupSettings(value: unknown): SetupSettings | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).some((key) => !SETTINGS_KEYS.includes(key))
  ) {
    return null;
  }
  const welcomed: unknown = Reflect.get(value, 'welcomed');
  const registeredExecutable: unknown = Reflect.get(value, 'registeredExecutable');
  if (
    typeof welcomed !== 'boolean' ||
    !(registeredExecutable === null || isWindowsExecutablePath(registeredExecutable))
  ) {
    return null;
  }
  return { welcomed, registeredExecutable };
}

/** Reads the setup of Tasklace from its store, a missing store giving the defaults and a damaged one being set aside before the defaults are used. */
export async function loadSetupSettings(storePath: string): Promise<SetupSettings> {
  const text = await readStoredText(storePath);
  if (text === '') {
    return DEFAULT_SETUP_SETTINGS;
  }
  const data = parseStoredJson(text);
  const settings =
    Reflect.get(Object(data), 'version') === STORE_VERSION
      ? readSetupSettings(Reflect.get(Object(data), 'settings'))
      : null;
  if (settings !== null) {
    return settings;
  }
  await setDamagedFileAside(storePath, new Date(), 'The file of the setup of Tasklace');
  return DEFAULT_SETUP_SETTINGS;
}

/** Writes the setup of Tasklace to its store. */
export function storeSetupSettings(storePath: string, settings: SetupSettings): Promise<void> {
  return writeFileSafely(storePath, JSON.stringify({ version: STORE_VERSION, settings }));
}
