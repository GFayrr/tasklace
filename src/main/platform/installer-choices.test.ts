import { describe, expect, it } from 'vitest';
import {
  forgetInstallerChoices,
  INSTALLER_CHOICES_KEY,
  readInstallerChoices,
} from './installer-choices';
import { registryFileText, type Registry } from './registry';

/** Builds a registry that holds the exported key of the choices, or nothing, and records what is deleted. */
function registryHolding(exported: string | null): Registry & { readonly deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    exportKey: (key) => Promise.resolve(key === INSTALLER_CHOICES_KEY ? exported : null),
    importText: () => Promise.reject(new Error('The choices are never imported.')),
    deleteKey: (key) => {
      deleted.push(key);
      return Promise.resolve();
    },
  };
}

/** Writes the choices of the installer as the registry tool exports them. */
function choices(...lines: string[]): string {
  return registryFileText([`[${INSTALLER_CHOICES_KEY}]`, ...lines]);
}

describe('the choices of the installer', () => {
  it('are kept in the registry of the current user', () => {
    expect(INSTALLER_CHOICES_KEY).toBe('HKEY_CURRENT_USER\\Software\\Tasklace\\Setup');
  });

  it('are read as chosen only when set to 1, a missing or other value counting as declined', async () => {
    expect(
      await readInstallerChoices(
        registryHolding(
          choices('"Associate"=dword:00000001', '"CheckForNewVersions"=dword:00000000'),
        ),
      ),
    ).toEqual({ associate: true, checkForNewVersions: false });
    expect(
      await readInstallerChoices(
        registryHolding(
          choices('"Associate"=dword:00000002', '"CheckForNewVersions"=dword:00000001'),
        ),
      ),
    ).toEqual({ associate: false, checkForNewVersions: true });
    expect(await readInstallerChoices(registryHolding(choices()))).toEqual({
      associate: false,
      checkForNewVersions: false,
    });
  });

  it('are none when the installer left nothing, and are forgotten by deleting their key', async () => {
    const registry = registryHolding(null);
    expect(await readInstallerChoices(registry)).toBeNull();
    await forgetInstallerChoices(registry);
    expect(registry.deleted).toEqual([INSTALLER_CHOICES_KEY]);
  });
});
