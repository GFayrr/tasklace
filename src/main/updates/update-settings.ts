import { writeFileSafely } from '../safe-write';
import { parseStoredJson, readStoredText, setDamagedFileAside } from '../stored-files';

export interface StoredUpdateSettings {
  readonly checkForNewVersions: boolean;
  readonly lastCheckedOn: string | null;
}

export const DEFAULT_UPDATE_SETTINGS: StoredUpdateSettings = {
  checkForNewVersions: true,
  lastCheckedOn: null,
};

const STORE_VERSION = 1;
const SETTINGS_KEYS = ['checkForNewVersions', 'lastCheckedOn'];
const LOCAL_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_DIGITS = 2;

/** Writes the day of a moment in the time zone of this computer, as year-month-day, so that two checks the same local day can be told apart from checks on two days. */
export function localDayOf(moment: Date): string {
  const month = String(moment.getMonth() + 1).padStart(DAY_DIGITS, '0');
  const day = String(moment.getDate()).padStart(DAY_DIGITS, '0');
  return `${String(moment.getFullYear())}-${month}-${day}`;
}

/** Reads the settings of the check for new versions from an untrusted value, or returns null when it is not exactly such settings. */
export function readUpdateSettings(value: unknown): StoredUpdateSettings | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).some((key) => !SETTINGS_KEYS.includes(key))
  ) {
    return null;
  }
  const checkForNewVersions: unknown = Reflect.get(value, 'checkForNewVersions');
  const lastCheckedOn: unknown = Reflect.get(value, 'lastCheckedOn');
  if (
    typeof checkForNewVersions !== 'boolean' ||
    !(
      lastCheckedOn === null ||
      (typeof lastCheckedOn === 'string' && LOCAL_DAY.test(lastCheckedOn))
    )
  ) {
    return null;
  }
  return { checkForNewVersions, lastCheckedOn };
}

/** Reads the settings of the check for new versions from their store, a missing store giving the defaults and a damaged one being set aside before the defaults are used. */
export async function loadUpdateSettings(storePath: string): Promise<StoredUpdateSettings> {
  const text = await readStoredText(storePath);
  if (text === '') {
    return DEFAULT_UPDATE_SETTINGS;
  }
  const data = parseStoredJson(text);
  const settings =
    Reflect.get(Object(data), 'version') === STORE_VERSION
      ? readUpdateSettings(Reflect.get(Object(data), 'settings'))
      : null;
  if (settings !== null) {
    return settings;
  }
  await setDamagedFileAside(storePath, new Date(), 'The file of the settings of new versions');
  return DEFAULT_UPDATE_SETTINGS;
}

/** Writes the settings of the check for new versions to their store. */
export function storeUpdateSettings(
  storePath: string,
  settings: StoredUpdateSettings,
): Promise<void> {
  return writeFileSafely(storePath, JSON.stringify({ version: STORE_VERSION, settings }));
}
