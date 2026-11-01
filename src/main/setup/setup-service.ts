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
import { sameWindowsPath, type FileAssociations } from '../platform/file-associations';
import {
  forgetInstallerChoices,
  readInstallerChoices,
  type InstallerChoices,
} from '../platform/installer-choices';
import { RegistryToolError, type Registry } from '../platform/registry';
import type { CopyPlace } from '../platform/this-copy';
import { isSystemError } from '../stored-files';
import { loadSetupSettings, storeSetupSettings, type SetupSettings } from './setup-settings';

export interface ThisCopy extends CopyPlace {
  readonly registry: Registry;
  readonly associations: FileAssociations;
}

export interface SetupServices {
  readonly assertTrusted: TrustCheck;
  readonly storePath: string;
  readonly isPackaged: boolean;
  readonly copy: ThisCopy | null;
  readonly setCheck: (check: boolean) => Promise<BridgeResult<null>>;
}

export interface Setup {
  readonly mayCheckAtLaunch: () => Promise<boolean>;
}

interface Prepared {
  readonly welcome: boolean;
  readonly consent: boolean;
}

const WELCOME_KEYS = ['associate', 'checkForNewVersions'];
const UNANSWERED: Prepared = { welcome: true, consent: false };

/** Prepares the setup of this copy and answers the channels of the welcome window and of the copy that opens files, allowing the check for new versions at launch only once the choice about it is known and applied. */
export function registerSetupHandlers(services: SetupServices): Setup {
  let welcome = false;
  let consent = false;
  const ready = prepare(services).then(
    (prepared) => {
      welcome = prepared.welcome;
      consent = prepared.consent;
    },
    (error: unknown) => {
      console.error('The setup of Tasklace failed unexpectedly:', error);
      welcome = services.isPackaged;
    },
  );
  /** Registers the answer of a channel once the setup is prepared, which checks first that the page asking is trusted. */
  const handle = <C extends InvokeChannel>(channel: C, answer: ChannelHandler<C>): void => {
    handleChannel(services.assertTrusted, channel, async (event, ...values) => {
      await ready;
      return answer(event, ...values);
    });
  };
  handle(IPC_CHANNELS.setupState, async () =>
    success({ welcome, association: await associationOf(services.copy) }),
  );
  handle(IPC_CHANNELS.finishWelcome, async (_event, value) => {
    const choices = readWelcomeChoices(value);
    if (choices === null || !welcome) {
      console.error(
        'The page asked to finish a welcome that was not shown, or with other choices:',
        value,
      );
      return failure({ code: 'TASK_FAILED' });
    }
    welcome = false;
    const finished = await finishWelcome(services, choices);
    consent = finished.consent;
    return finished.result;
  });
  handle(IPC_CHANNELS.setFileAssociation, async (_event, value) => {
    if (typeof value !== 'boolean' || services.copy === null) {
      console.error('The page asked to change which copy opens project files with:', value);
      return failure({ code: 'TASK_FAILED' });
    }
    return setAssociation(services, services.copy, value);
  });
  return {
    mayCheckAtLaunch: async () => {
      await ready;
      return consent && !welcome;
    },
  };
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

/** Prepares the setup of a built copy: the installed version applies the choices of its installer, a copy whose choices are unknown asks them in its welcome, and a setup that cannot be read asks them again. */
async function prepare(services: SetupServices): Promise<Prepared> {
  if (!services.isPackaged) {
    return { welcome: false, consent: false };
  }
  const { copy } = services;
  let settings: SetupSettings;
  let choices: InstallerChoices | null = null;
  try {
    settings = await loadSetupSettings(services.storePath);
    if (copy?.kind === 'installed') {
      choices = await readInstallerChoices(copy.registry);
    }
  } catch (error) {
    rethrowUnlessSetupFailure(error);
    console.error(
      'The setup of Tasklace could not be read, so its choices are asked again:',
      error,
    );
    return UNANSWERED;
  }
  if (copy !== null && choices !== null) {
    return {
      welcome: false,
      consent: await applyInstallerChoices(services, copy, settings, choices),
    };
  }
  if (copy !== null) {
    await followMove(services, copy, settings);
  }
  return { welcome: !settings.welcomed, consent: settings.welcomed };
}

/** Applies the choices the installer left, keeping them in the registry until every one of them is applied so that a later launch tries again, and tells whether the choice about new versions is applied. */
async function applyInstallerChoices(
  services: SetupServices,
  copy: ThisCopy,
  settings: SetupSettings,
  choices: InstallerChoices,
): Promise<boolean> {
  const checkKept = await services.setCheck(choices.checkForNewVersions);
  if (!checkKept.ok) {
    console.error(
      'The choice of the installer about new versions could not be kept; it is applied at the next launch.',
    );
    return false;
  }
  try {
    const registered = choices.associate && (await registerUnlessOwner(copy));
    await storeSetupSettings(services.storePath, {
      welcomed: true,
      registeredExecutable: registered ? copy.executable : settings.registeredExecutable,
    });
    await forgetInstallerChoices(copy.registry);
  } catch (error) {
    rethrowUnlessSetupFailure(error);
    console.error(
      'The choices of the installer could not all be applied; they are applied again at the next launch:',
      error,
    );
  }
  return true;
}

/** Makes this copy open project files and links unless it already does, telling that it does now. */
async function registerUnlessOwner(copy: ThisCopy): Promise<boolean> {
  if ((await copy.associations.owner()).kind !== 'thisCopy') {
    await copy.associations.register();
  }
  return true;
}

/** Keeps a copy that moved opening the project files it opened from its former place, never taking them from another copy, a failure being only logged since nothing the person chose is lost. */
async function followMove(
  services: SetupServices,
  copy: ThisCopy,
  settings: SetupSettings,
): Promise<void> {
  const former = settings.registeredExecutable;
  if (!settings.welcomed || former === null || sameWindowsPath(former, copy.executable)) {
    return;
  }
  try {
    const owner = await copy.associations.owner();
    if (owner.kind !== 'otherCopy' || !sameWindowsPath(owner.path, former)) {
      return;
    }
    await copy.associations.register();
    await storeSetupSettings(services.storePath, {
      ...settings,
      registeredExecutable: copy.executable,
    });
  } catch (error) {
    rethrowUnlessSetupFailure(error);
    console.error('This copy moved, but could not keep opening project files:', error);
  }
}

/** Applies the choices of the welcome window, new versions first so that a doubt never lets a check run, then the files and links, noting the answer last, and gives whether that choice applies and which copy opens files. */
async function finishWelcome(
  services: SetupServices,
  choices: WelcomeChoices,
): Promise<{ readonly consent: boolean; readonly result: BridgeResult<FileAssociation> }> {
  const checkKept = await services.setCheck(choices.checkForNewVersions);
  if (!checkKept.ok) {
    return { consent: false, result: checkKept };
  }
  const { copy } = services;
  try {
    if (choices.associate && copy !== null) {
      await copy.associations.register();
    }
    await storeSetupSettings(services.storePath, {
      welcomed: true,
      registeredExecutable: choices.associate && copy !== null ? copy.executable : null,
    });
  } catch (error) {
    rethrowUnlessSetupFailure(error);
    console.error('The choices of the welcome window could not all be applied:', error);
    return { consent: true, result: failure({ code: 'WRITE_FAILED' }) };
  }
  return { consent: true, result: success(await associationOf(copy)) };
}

/** Makes this copy open project files and links or stops it, a copy that does not open them leaving them to whichever copy does, and gives which copy opens them afterwards. */
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
      welcomed: settings.welcomed,
      registeredExecutable: on && settings.welcomed ? copy.executable : null,
    });
  } catch (error) {
    rethrowUnlessSetupFailure(error);
    console.error('The copy that opens project files could not be changed:', error);
    return failure({ code: 'WRITE_FAILED' });
  }
  return success(await associationOf(copy));
}

/** Finds out which copy opens project files, unavailable for a copy that is not a built application on Windows, and unknown, which is logged, when the registry cannot be read. */
async function associationOf(copy: ThisCopy | null): Promise<FileAssociation> {
  if (copy === null) {
    return { kind: 'unavailable' };
  }
  try {
    return await copy.associations.owner();
  } catch (error) {
    rethrowUnlessSetupFailure(error);
    console.error('Tasklace could not find out which copy opens project files:', error);
    return { kind: 'unknown' };
  }
}

/** Throws again an error that comes neither from the registry tool nor from the system, so that a fault of the program is never taken for a refusal. */
function rethrowUnlessSetupFailure(error: unknown): void {
  if (!(error instanceof RegistryToolError || isSystemError(error))) {
    throw error;
  }
}
