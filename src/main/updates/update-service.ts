import { readVersion, type Version } from '../../core/version';
import { failure, success } from '../../core/result';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type InvokeChannel,
  type LaunchCheck,
  type ReleaseCheck,
  type UpdateSettings,
} from '../../preload/bridge-contract';
import { PRIVACY_POLICY_URL, releasePageUrl } from '../external-links';
import { handleChannel, type ChannelHandler } from '../ipc-channels';
import type { TrustCheck } from '../ipc-trust';
import { isSystemError } from '../stored-files';
import { checkReleases, type FetchReleases } from './release-check';
import {
  loadUpdateSettings,
  localDayOf,
  storeUpdateSettings,
  type StoredUpdateSettings,
} from './update-settings';

export interface UpdateServices {
  readonly assertTrusted: TrustCheck;
  readonly storePath: string;
  readonly version: string;
  readonly isPackaged: boolean;
  readonly now: () => Date;
  readonly fetchReleases: FetchReleases;
  readonly openInBrowser: (url: string) => Promise<boolean>;
  readonly mayCheckAtLaunch: () => Promise<boolean>;
}

export interface UpdateHandlers {
  readonly setCheck: (check: boolean) => Promise<BridgeResult<null>>;
}

/** Answers the channels of the version and of the check for new versions, which runs at launch at most once a day, only built and once the choice about it is known and applied, one check at a time, and returns how to turn the check on or off. */
export function registerUpdateHandlers(services: UpdateServices): UpdateHandlers {
  const current = readVersion(services.version);
  if (current === null) {
    throw new Error(`The version of the application, ${services.version}, is not a version.`);
  }
  let running: Promise<ReleaseCheck> | null = null;
  /** Runs one check for new versions, sharing the one that already runs, and notes the day of a check that reached GitHub. */
  const check = (): Promise<ReleaseCheck> => {
    running ??= checkAndNote(services, current).finally(() => {
      running = null;
    });
    return running;
  };
  /** Registers the answer of a channel, which checks first that the page asking is trusted. */
  const handle = <C extends InvokeChannel>(channel: C, answer: ChannelHandler<C>): void => {
    handleChannel(services.assertTrusted, channel, answer);
  };
  handle(IPC_CHANNELS.appVersion, () => success(services.version));
  handle(IPC_CHANNELS.updateSettings, async () => {
    const settings = await readSettings(services.storePath);
    return settings.ok ? success(shownSettings(settings.value)) : settings;
  });
  handle(IPC_CHANNELS.setCheckForNewVersions, (_event, value) =>
    setCheck(services.storePath, value),
  );
  handle(IPC_CHANNELS.checkAtLaunch, async () => {
    if (!services.isPackaged || !(await services.mayCheckAtLaunch())) {
      return success({ kind: 'skipped' });
    }
    const settings = await readSettings(services.storePath);
    return settings.ok ? success(await launchCheck(settings.value, services, check)) : settings;
  });
  handle(IPC_CHANNELS.checkNow, async () => success(await check()));
  handle(IPC_CHANNELS.openReleasePage, async (_event, value) => openReleasePage(services, value));
  handle(IPC_CHANNELS.openPrivacyPolicy, async () =>
    (await services.openInBrowser(PRIVACY_POLICY_URL))
      ? success(null)
      : failure({ code: 'TASK_FAILED' }),
  );
  return { setCheck: (check) => setCheck(services.storePath, check) };
}

/** Gives the page the settings it shows, leaving out the day of the last check, which only the main process uses. */
function shownSettings(settings: StoredUpdateSettings): UpdateSettings {
  return { checkForNewVersions: settings.checkForNewVersions };
}

/** Runs the check at launch unless it is turned off or a check already reached GitHub today. */
async function launchCheck(
  settings: StoredUpdateSettings,
  services: UpdateServices,
  check: () => Promise<ReleaseCheck>,
): Promise<LaunchCheck> {
  if (!settings.checkForNewVersions || settings.lastCheckedOn === localDayOf(services.now())) {
    return { kind: 'skipped' };
  }
  return check();
}

/** Asks GitHub for new versions and, when GitHub answered, notes the day so that the check at launch does not run again before tomorrow, a day that cannot be noted being only logged. */
async function checkAndNote(services: UpdateServices, current: Version): Promise<ReleaseCheck> {
  const result = await checkReleases(services.fetchReleases, current);
  if (result.kind === 'failed') {
    return result;
  }
  try {
    const settings = await loadUpdateSettings(services.storePath);
    await storeUpdateSettings(services.storePath, {
      ...settings,
      lastCheckedOn: localDayOf(services.now()),
    });
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The day of the check for new versions could not be kept:', error);
  }
  return result;
}

/** Turns the check for new versions on or off from an untrusted value, refusing anything but true or false. */
async function setCheck(storePath: string, value: unknown): Promise<BridgeResult<null>> {
  if (typeof value !== 'boolean') {
    console.error(
      'The page asked to turn the check for new versions to a value that is not on or off:',
      value,
    );
    return failure({ code: 'TASK_FAILED' });
  }
  const settings = await readSettings(storePath);
  if (!settings.ok) {
    return settings;
  }
  try {
    await storeUpdateSettings(storePath, { ...settings.value, checkForNewVersions: value });
    return success(null);
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The settings of new versions could not be written:', error);
    return failure({ code: 'WRITE_FAILED' });
  }
}

/** Reads the settings of new versions, a store the system cannot read being logged and reported. */
async function readSettings(storePath: string): Promise<BridgeResult<StoredUpdateSettings>> {
  try {
    return success(await loadUpdateSettings(storePath));
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The settings of new versions could not be read:', error);
    return failure({ code: 'READ_FAILED' });
  }
}

/** Opens the page of a release from the version the page names, building its address from the version once read again, never from any address. */
async function openReleasePage(
  services: UpdateServices,
  value: unknown,
): Promise<BridgeResult<null>> {
  const version = readVersion(value);
  if (version === null) {
    console.error(
      'The page asked to open the release page of a value that is not a version:',
      value,
    );
    return failure({ code: 'TASK_FAILED' });
  }
  return (await services.openInBrowser(releasePageUrl(version)))
    ? success(null)
    : failure({ code: 'TASK_FAILED' });
}
