import { readFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import type { FileAssociation } from '../../preload/bridge-contract';
import { writeFileSafely } from '../safe-write';
import { readRegistryString, registryFileText, registryString, type Registry } from './registry';
import { isWindowsExecutablePath, type WindowsExecutablePath } from './this-copy';

export type AssociationOwner = Exclude<
  FileAssociation,
  { readonly kind: 'unavailable' } | { readonly kind: 'unknown' }
>;

export interface FileAssociations {
  readonly owner: () => Promise<AssociationOwner>;
  readonly register: () => Promise<void>;
  readonly unregister: () => Promise<void>;
}

export interface AssociationServices {
  readonly registry: Registry;
  readonly executable: WindowsExecutablePath;
  readonly fileIcon: string;
  readonly userDataFolder: string;
}

const CLASSES = 'HKEY_CURRENT_USER\\Software\\Classes';
const PROJECT_EXTENSION_KEY = `${CLASSES}\\.tasklace`;
const PROJECT_TYPE = 'Tasklace.Project';
const PROJECT_TYPE_KEY = `${CLASSES}\\${PROJECT_TYPE}`;
const LINK_KEY = `${CLASSES}\\tasklace`;
const OPEN_COMMAND = '\\shell\\open\\command';
const ICON = '\\DefaultIcon';
const PROJECT_TYPE_NAME = 'Tasklace project';
const LINK_NAME = 'URL:Tasklace link';
const COPIED_ICON = 'tasklace-file.ico';
const COMMAND_PATTERN = /^"([^"]+)" -- "%1"$/;

/** Writes the command Windows runs to open a project file or a link, the separator before the file or link keeping Tasklace and Chromium from ever reading it as an option. */
export function openCommandOf(executable: WindowsExecutablePath): string {
  return `"${executable}" -- "%1"`;
}

/** Writes the registry file that makes an executable open project files and Tasklace links for the current user, the earlier keys of Tasklace being removed first so that none of their values stays behind. */
export function associationRegistry(executable: WindowsExecutablePath, fileIcon: string): string {
  const command = registryString(openCommandOf(executable));
  return registryFileText([
    `[-${PROJECT_TYPE_KEY}]`,
    `[-${LINK_KEY}]`,
    `[${PROJECT_EXTENSION_KEY}]`,
    `@=${registryString(PROJECT_TYPE)}`,
    `[${PROJECT_TYPE_KEY}]`,
    `@=${registryString(PROJECT_TYPE_NAME)}`,
    `[${PROJECT_TYPE_KEY}${ICON}]`,
    `@=${registryString(fileIcon)}`,
    `[${PROJECT_TYPE_KEY}${OPEN_COMMAND}]`,
    `@=${command}`,
    `[${LINK_KEY}]`,
    `@=${registryString(LINK_NAME)}`,
    `${registryString('URL Protocol')}=${registryString('')}`,
    `[${LINK_KEY}${ICON}]`,
    `@=${registryString(`"${executable}",0`)}`,
    `[${LINK_KEY}${OPEN_COMMAND}]`,
    `@=${command}`,
  ]);
}

/** Writes the registry file that removes the keys of Tasklace for project files and links, and nothing else. */
export function removalRegistry(): string {
  return registryFileText([
    `[-${PROJECT_TYPE_KEY}]`,
    `[-${LINK_KEY}]`,
    `[${PROJECT_EXTENSION_KEY}]`,
    '@=-',
  ]);
}

/** Tells which copy of Tasklace opens project files from the command registered for them: this one, another one named by its path, another program whose command is not that of a copy of Tasklace, or none. */
export function ownerOfCommand(
  command: string | null,
  executable: WindowsExecutablePath,
): AssociationOwner {
  if (command === null) {
    return { kind: 'none' };
  }
  const registered = COMMAND_PATTERN.exec(command)?.[1];
  if (!isWindowsExecutablePath(registered)) {
    return { kind: 'otherProgram' };
  }
  return sameWindowsPath(registered, executable)
    ? { kind: 'thisCopy' }
    : { kind: 'otherCopy', path: registered };
}

/** Tells whether two Windows paths name the same file, which Windows compares without regard to case. */
export function sameWindowsPath(first: string, second: string): boolean {
  return win32.normalize(first).toLowerCase() === win32.normalize(second).toLowerCase();
}

/** Registers, finds out and removes the copy of Tasklace that opens project files and Tasklace links for the current user, in the registry of that user alone. */
export function createFileAssociations(services: AssociationServices): FileAssociations {
  const { registry, executable } = services;
  return {
    owner: async () => {
      const key = `${PROJECT_TYPE_KEY}${OPEN_COMMAND}`;
      const exported = await registry.exportKey(key);
      return ownerOfCommand(
        exported === null ? null : readRegistryString(exported, key, null),
        executable,
      );
    },
    register: async () => {
      const icon = join(services.userDataFolder, COPIED_ICON);
      await writeFileSafely(icon, await readFile(services.fileIcon));
      await registry.importText(associationRegistry(executable, icon));
    },
    unregister: () => registry.importText(removalRegistry()),
  };
}
