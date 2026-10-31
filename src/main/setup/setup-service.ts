import { failure, success } from '../../core/result';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type FileAssociation,
  type InvokeChannel,
  type WelcomeChoices,
} from '../../preload/bridge-contract';
import { handleChannel, type ChannelHandler } from '../ipc-channels';
import type { TrustCheck } from '../ipc-trust';
import {
  sameWindowsPath,
  type AssociationOwner,
  type FileAssociations,
} from '../platform/file-associations';
import { readRegistryNumber, RegistryToolError, type Registry } from '../platform/registry';
import { isSystemError } from '../stored-files';
import { loadSetupSettings, storeSetupSettings, type SetupSettings } from './setup-settings';

export type CopyKind = 'portable' | 'installed';

export interface ThisCopy {
  readonly kind: CopyKind;
  readonly executable: string;
  readonly registry: Registry;
  readonly associations: FileAssociations;
}

export interface SetupServices {
  readonly assertTrusted: TrustCheck;
  readonly storePath: string;
  readonly copy: ThisCopy | null;
  readonly setCheck: (check: boolean) => Promise<BridgeResult<null>>;
}

export interface Setup {
  readonly welcomePending: () => boolean;
}

export const INSTALLER_CHOICES_KEY = 'HKEY_CURRENT_USER\\Software\\Tasklace\\Setup';

const CHOSEN = 1;
const WELCOME_KEYS = ['associate', 'checkForNewVersions'];

/** Prepares the setup of this copy as it starts, the installed version applying the choices of its installer and a moved copy keeping its files, and answers the channels of the welcome window and of the copy that opens files. */
export function registerSetupHandlers(services: SetupServices): Setup {
  let pending = false;
  const ready = prepare(services).then((welcome) => {
    pending = welcome;
  });
  /** Registers the answer of a channel once the setup is prepared, which checks first that the page asking is trusted. */
  const handle = <C extends InvokeChannel>(channel: C, answer: ChannelHandler<C>): void => {
    handleChannel(services.assertTrusted, channel, async (event, ...values) => {
      await ready;
      return answer(event, ...values);
    });
  };
  handle(IPC_CHANNELS.setupState, async () => {
    const association = await associationOf(services.copy);
    return association.ok
      ? success({ welcome: pending, association: association.value })
      : association;
  });
  handle(IPC_CHANNELS.finishWelcome, async (_event, value) => {
    const choices = readWelcomeChoices(value);
    if (choices === null || !pending || services.copy === null) {
      console.error(
        'The page asked to finish a welcome that was not shown, or with other choices:',
        value,
      );
      return failure({ code: 'TASK_FAILED' });
    }
    pending = false;
    return finishWelcome(services, services.copy, choices);
  });
  handle(IPC_CHANNELS.setFileAssociation, async (_event, value) => {
    if (typeof value !== 'boolean' || services.copy === null) {
      console.error('The page asked to change which copy opens project files with:', value);
      return failure({ code: 'TASK_FAILED' });
    }
    return setAssociation(services, services.copy, value);
  });
  return { welcomePending: () => pending };
}

/** Reads the choices of the welcome window from an untrusted value, or returns null when it is not exactly such choices. */
export function readWelcomeChoices(value: unknown): WelcomeChoices | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.keys(value).length !== WELCOME_KEYS.length ||
    Object.keys(value).some((key) => !WELCOME_KEYS.includes(key))
  ) {
    return null;
  }
  const associate: unknown = Reflect.get(value, 'associate');
  const checkForNewVersions: unknown = Reflect.get(value, 'checkForNewVersions');
  return typeof associate === 'boolean' && typeof checkForNewVersions === 'boolean'
    ? { associate, checkForNewVersions }
    : null;
}

/** Prepares the setup as Tasklace starts, telling whether the welcome window must ask its choices, a setup that cannot be prepared being logged and asking again in the portable version, so that nothing is sent before the person chose. */
async function prepare(services: SetupServices): Promise<boolean> {
  const copy = services.copy;
  if (copy === null) {
    return false;
  }
  try {
    const settings = await loadSetupSettings(services.storePath);
    if (copy.kind === 'installed') {
      await applyInstallerChoices(services, copy, settings);
      return false;
    }
    await followMove(services, copy, settings);
    return !settings.welcomed;
  } catch (error) {
    if (!isSetupFailure(error)) {
      throw error;
    }
    console.error('The setup of Tasklace could not be prepared:', error);
    return copy.kind === 'portable';
  }
}

/** Applies once the choices the installer left in the registry, then removes them, the files and links being registered by the installer already unless it could not. */
async function applyInstallerChoices(
  services: SetupServices,
  copy: ThisCopy,
  settings: SetupSettings,
): Promise<void> {
  const exported = await copy.registry.exportKey(INSTALLER_CHOICES_KEY);
  if (exported === null) {
    await followMove(services, copy, settings);
    return;
  }
  const associate = readRegistryNumber(exported, 'Associate') === CHOSEN;
  const check = readRegistryNumber(exported, 'CheckForNewVersions') === CHOSEN;
  const checkKept = await services.setCheck(check);
  if (!checkKept.ok) {
    console.error('The choice of the installer about new versions could not be kept.');
  }
  if (associate && (await copy.associations.owner()).kind !== 'thisCopy') {
    await copy.associations.register();
  }
  await storeSetupSettings(services.storePath, {
    welcomed: true,
    registeredExecutable: associate ? copy.executable : null,
  });
  await copy.registry.deleteKey(INSTALLER_CHOICES_KEY);
}

/** Keeps a copy that moved opening the project files it opened from its former place, never taking them from another copy. */
async function followMove(
  services: SetupServices,
  copy: ThisCopy,
  settings: SetupSettings,
): Promise<void> {
  const former = settings.registeredExecutable;
  if (!settings.welcomed || former === null || sameWindowsPath(former, copy.executable)) {
    return;
  }
  const owner = await copy.associations.owner();
  if (owner.kind !== 'otherCopy' || !sameWindowsPath(owner.path, former)) {
    return;
  }
  await copy.associations.register();
  await storeSetupSettings(services.storePath, {
    ...settings,
    registeredExecutable: copy.executable,
  });
}

/** Keeps the choices of the welcome window, so that it never shows again, then applies them, giving which copy now opens project files, a choice that cannot be applied being logged and reported. */
async function finishWelcome(
  services: SetupServices,
  copy: ThisCopy,
  choices: WelcomeChoices,
): Promise<BridgeResult<FileAssociation>> {
  try {
    await storeSetupSettings(services.storePath, {
      welcomed: true,
      registeredExecutable: choices.associate ? copy.executable : null,
    });
    const checkKept = await services.setCheck(choices.checkForNewVersions);
    if (!checkKept.ok) {
      return checkKept;
    }
    if (choices.associate) {
      await copy.associations.register();
    }
    return success(await copy.associations.owner());
  } catch (error) {
    return setupFailure(error, 'The choices of the welcome window could not be applied:');
  }
}

/** Makes this copy open project files and links, or stops it from opening them, a copy that does not open them leaving them to whichever copy does, and gives which copy opens them afterwards. */
async function setAssociation(
  services: SetupServices,
  copy: ThisCopy,
  on: boolean,
): Promise<BridgeResult<FileAssociation>> {
  try {
    const settings = await loadSetupSettings(services.storePath);
    if (on) {
      await copy.associations.register();
    } else if ((await copy.associations.owner()).kind === 'thisCopy') {
      await copy.associations.unregister();
    }
    await storeSetupSettings(services.storePath, {
      ...settings,
      welcomed: true,
      registeredExecutable: on ? copy.executable : null,
    });
    return success(await copy.associations.owner());
  } catch (error) {
    return setupFailure(error, 'The copy that opens project files could not be changed:');
  }
}

/** Finds out which copy opens project files, none being possible for a copy that is not a built application on Windows. */
async function associationOf(copy: ThisCopy | null): Promise<BridgeResult<FileAssociation>> {
  if (copy === null) {
    return success({ kind: 'unavailable' });
  }
  try {
    const owner: AssociationOwner = await copy.associations.owner();
    return success(owner);
  } catch (error) {
    return setupFailure(
      error,
      'Tasklace could not find out which copy opens project files:',
      'READ_FAILED',
    );
  }
}

/** Logs a failure of the registry or of the system and reports it, throwing again any other error. */
function setupFailure(
  error: unknown,
  what: string,
  code: 'READ_FAILED' | 'WRITE_FAILED' = 'WRITE_FAILED',
): BridgeResult<never> {
  if (!isSetupFailure(error)) {
    throw error;
  }
  console.error(what, error);
  return failure({ code });
}

/** Tells whether an error comes from the registry tool or from the system rather than from a fault of the program. */
function isSetupFailure(error: unknown): boolean {
  return error instanceof RegistryToolError || isSystemError(error);
}
