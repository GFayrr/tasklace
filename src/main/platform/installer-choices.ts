import { readRegistryNumber, type Registry } from './registry';

export interface InstallerChoices {
  readonly associate: boolean;
  readonly checkForNewVersions: boolean;
}

export const INSTALLER_CHOICES_KEY = 'HKEY_CURRENT_USER\\Software\\Tasklace\\Setup';

const CHOSEN = 1;

/** Reads the choices the installer of Tasklace left in the registry of the current user, a choice that is missing or not a number counting as declined, or returns null when the installer left none. */
export async function readInstallerChoices(registry: Registry): Promise<InstallerChoices | null> {
  const exported = await registry.exportKey(INSTALLER_CHOICES_KEY);
  if (exported === null) {
    return null;
  }
  return {
    associate: readRegistryNumber(exported, INSTALLER_CHOICES_KEY, 'Associate') === CHOSEN,
    checkForNewVersions:
      readRegistryNumber(exported, INSTALLER_CHOICES_KEY, 'CheckForNewVersions') === CHOSEN,
  };
}

/** Removes the choices of the installer once they are applied, so that a later launch never applies them again. */
export function forgetInstallerChoices(registry: Registry): Promise<void> {
  return registry.deleteKey(INSTALLER_CHOICES_KEY);
}
