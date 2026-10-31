import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  associationRegistry,
  createFileAssociations,
  openCommandOf,
  ownerOfCommand,
  removalRegistry,
  sameWindowsPath,
} from './file-associations';
import { registryFileText, registryString, type Registry } from './registry';

const EXECUTABLE = 'C:\\Users\\Maël\\Downloads\\Tasklace-0.1.0-portable.exe';
const ICON = 'C:\\Users\\Maël\\AppData\\Roaming\\Tasklace\\tasklace-file.ico';
const COMMAND_KEY = 'HKEY_CURRENT_USER\\Software\\Classes\\Tasklace.Project\\shell\\open\\command';

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-associations-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** Builds a registry that holds one exported key and records what is imported. */
function fakeRegistry(exported: Readonly<Record<string, string>>): Registry & {
  readonly imported: string[];
  readonly asked: string[];
} {
  const imported: string[] = [];
  const asked: string[] = [];
  return {
    imported,
    asked,
    exportKey: (key) => {
      asked.push(key);
      return Promise.resolve(exported[key] ?? null);
    },
    importText: (text) => {
      imported.push(text);
      return Promise.resolve();
    },
    deleteKey: () => Promise.reject(new Error('Associations never delete a key.')),
  };
}

/** Writes the key of the command that opens project files as the registry tool exports it. */
function commandKey(command: string): string {
  return registryFileText([`[${COMMAND_KEY}]`, `@=${registryString(command)}`]);
}

describe('the keys of the files and links of Tasklace', () => {
  it('opens files and links with a separator before them, so that a link is never read as an option', () => {
    expect(openCommandOf(EXECUTABLE)).toBe(`"${EXECUTABLE}" -- "%1"`);
  });

  it('registers the project type, its icon, the extension and the link scheme for the current user, after removing its own earlier keys', () => {
    const command =
      '@="\\"C:\\\\Users\\\\Maël\\\\Downloads\\\\Tasklace-0.1.0-portable.exe\\" -- \\"%1\\""';
    expect(associationRegistry(EXECUTABLE, ICON)).toBe(
      registryFileText([
        '[-HKEY_CURRENT_USER\\Software\\Classes\\Tasklace.Project]',
        '[-HKEY_CURRENT_USER\\Software\\Classes\\tasklace]',
        '[HKEY_CURRENT_USER\\Software\\Classes\\.tasklace]',
        '@="Tasklace.Project"',
        '[HKEY_CURRENT_USER\\Software\\Classes\\Tasklace.Project]',
        '@="Tasklace project"',
        '[HKEY_CURRENT_USER\\Software\\Classes\\Tasklace.Project\\DefaultIcon]',
        '@="C:\\\\Users\\\\Maël\\\\AppData\\\\Roaming\\\\Tasklace\\\\tasklace-file.ico"',
        '[HKEY_CURRENT_USER\\Software\\Classes\\Tasklace.Project\\shell\\open\\command]',
        command,
        '[HKEY_CURRENT_USER\\Software\\Classes\\tasklace]',
        '@="URL:Tasklace link"',
        '"URL Protocol"=""',
        '[HKEY_CURRENT_USER\\Software\\Classes\\tasklace\\DefaultIcon]',
        '@="\\"C:\\\\Users\\\\Maël\\\\Downloads\\\\Tasklace-0.1.0-portable.exe\\",0"',
        '[HKEY_CURRENT_USER\\Software\\Classes\\tasklace\\shell\\open\\command]',
        command,
      ]),
    );
  });

  it('removes only its own keys and the type it gave the extension', () => {
    expect(removalRegistry()).toBe(
      registryFileText([
        '[-HKEY_CURRENT_USER\\Software\\Classes\\Tasklace.Project]',
        '[-HKEY_CURRENT_USER\\Software\\Classes\\tasklace]',
        '[HKEY_CURRENT_USER\\Software\\Classes\\.tasklace]',
        '@=-',
      ]),
    );
  });

  it('compares Windows paths without regard to case or to doubled separators', () => {
    expect(sameWindowsPath('C:\\Apps\\Tasklace.exe', 'c:\\apps\\TASKLACE.EXE')).toBe(true);
    expect(sameWindowsPath('C:\\Apps\\\\Tasklace.exe', 'C:/Apps/Tasklace.exe')).toBe(true);
    expect(sameWindowsPath('C:\\Apps\\Tasklace.exe', 'D:\\Apps\\Tasklace.exe')).toBe(false);
  });

  it('tells which copy opens project files from the registered command', () => {
    expect(ownerOfCommand(null, EXECUTABLE)).toEqual({ kind: 'none' });
    expect(ownerOfCommand(openCommandOf(EXECUTABLE.toUpperCase()), EXECUTABLE)).toEqual({
      kind: 'thisCopy',
    });
    expect(ownerOfCommand(openCommandOf('D:\\Old\\Tasklace.exe'), EXECUTABLE)).toEqual({
      kind: 'otherCopy',
      path: 'D:\\Old\\Tasklace.exe',
    });
    expect(ownerOfCommand('"D:\\Other.exe" "%1"', EXECUTABLE)).toEqual({
      kind: 'otherCopy',
      path: '"D:\\Other.exe" "%1"',
    });
  });
});

describe('createFileAssociations', () => {
  it('finds out the copy that opens project files from the registry, none when nothing is registered', async () => {
    const registry = fakeRegistry({ [COMMAND_KEY]: commandKey(openCommandOf(EXECUTABLE)) });
    const services = { registry, executable: EXECUTABLE, fileIcon: '', userDataFolder: folder };
    expect(await createFileAssociations(services).owner()).toEqual({ kind: 'thisCopy' });
    expect(registry.asked).toEqual([COMMAND_KEY]);
    const empty = { ...services, registry: fakeRegistry({}) };
    expect(await createFileAssociations(empty).owner()).toEqual({ kind: 'none' });
    const garbled = { ...services, registry: fakeRegistry({ [COMMAND_KEY]: 'nothing' }) };
    expect(await createFileAssociations(garbled).owner()).toEqual({ kind: 'none' });
  });

  it('copies the icon of project files to the folder of Tasklace before registering, and removes the keys', async () => {
    const source = join(folder, 'source.ico');
    await writeFile(source, 'icon');
    const registry = fakeRegistry({});
    const associations = createFileAssociations({
      registry,
      executable: EXECUTABLE,
      fileIcon: source,
      userDataFolder: folder,
    });
    await associations.register();
    expect(await readFile(join(folder, 'tasklace-file.ico'), 'utf8')).toBe('icon');
    await associations.unregister();
    expect(registry.imported).toEqual([
      associationRegistry(EXECUTABLE, join(folder, 'tasklace-file.ico')),
      removalRegistry(),
    ]);
  });

  it('registers nothing when the icon cannot be copied', async () => {
    const registry = fakeRegistry({});
    const associations = createFileAssociations({
      registry,
      executable: EXECUTABLE,
      fileIcon: join(folder, 'missing.ico'),
      userDataFolder: folder,
    });
    await expect(associations.register()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(registry.imported).toEqual([]);
  });
});
