import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRegistry,
  readRegistryNumber,
  readRegistryString,
  registryFileText,
  registryString,
  RegistryToolError,
  runRegistryTool,
  type RunRegistryTool,
} from './registry';

const KEY = 'HKEY_CURRENT_USER\\Software\\Tasklace\\Setup';
const EXPORTED = [
  'Windows Registry Editor Version 5.00',
  '',
  `[${KEY}]`,
  '@="\\"C:\\\\Users\\\\Maël\\\\Tasklace.exe\\" -- \\"%1\\""',
  '"Name"="A \\"quoted\\" name"',
  '"Associate"=dword:00000001',
  '"CheckForNewVersions"=dword:00000000',
  '"Broken"=dword:1',
  '',
].join('\r\n');

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-registry-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

/** Gives the registry files left in the folder, which every use must remove. */
async function leftFiles(): Promise<string[]> {
  return (await readdir(folder)).filter((name) => name.endsWith('.reg'));
}

describe('registry files', () => {
  it('writes values with their backslashes and quotes escaped, in a file with its header and Windows line ends', () => {
    expect(registryString('"C:\\Tasklace.exe" -- "%1"')).toBe(
      '"\\"C:\\\\Tasklace.exe\\" -- \\"%1\\""',
    );
    expect(registryFileText(['[K]', '@="v"'])).toBe(
      '\ufeffWindows Registry Editor Version 5.00\r\n\r\n[K]\r\n@="v"\r\n',
    );
  });

  it('reads the default and named texts and numbers of an exported key, and nothing that is missing or of another kind', () => {
    expect(readRegistryString(EXPORTED, null)).toBe('"C:\\Users\\Maël\\Tasklace.exe" -- "%1"');
    expect(readRegistryString(EXPORTED, 'Name')).toBe('A "quoted" name');
    expect(readRegistryString(EXPORTED, 'Associate')).toBeNull();
    expect(readRegistryString(EXPORTED, 'Missing')).toBeNull();
    expect(readRegistryNumber(EXPORTED, 'Associate')).toBe(1);
    expect(readRegistryNumber(EXPORTED, 'CheckForNewVersions')).toBe(0);
    expect(readRegistryNumber(EXPORTED, 'Broken')).toBeNull();
    expect(readRegistryNumber(EXPORTED, 'Name')).toBeNull();
    expect(readRegistryNumber(EXPORTED, 'Missing')).toBeNull();
  });
});

describe('createRegistry', () => {
  it('exports a key into a file of its own in UTF-16, reads it and removes the file', async () => {
    const calls: (readonly string[])[] = [];
    /** Writes the exported key where the tool is asked to, as the registry tool does. */
    const run: RunRegistryTool = async (args) => {
      calls.push(args);
      await writeFile(args[2] ?? '', `\ufeff${EXPORTED}`, 'utf16le');
      return 0;
    };
    expect(await createRegistry(run, folder).exportKey(KEY)).toBe(EXPORTED);
    expect(calls).toEqual([['export', KEY, expect.stringMatching(/registry-.+\.reg$/), '/y']]);
    expect(calls[0]?.[2]?.startsWith(folder)).toBe(true);
    expect(await leftFiles()).toEqual([]);
  });

  it('gives null for a key that does not exist, and throws when the tool fails otherwise', async () => {
    expect(await createRegistry(() => Promise.resolve(1), folder).exportKey(KEY)).toBeNull();
    await expect(createRegistry(() => Promise.resolve(5), folder).exportKey(KEY)).rejects.toThrow(
      new RegistryToolError('export', 5),
    );
    expect(await leftFiles()).toEqual([]);
  });

  it('imports a text through a file in UTF-16 that it removes, even when the tool fails', async () => {
    const imported: string[] = [];
    let code = 0;
    /** Reads the file the tool is asked to import, as the registry tool does. */
    const run: RunRegistryTool = async (args) => {
      expect(args.slice(0, 1)).toEqual(['import']);
      imported.push(await readFile(args[1] ?? '', 'utf16le'));
      return code;
    };
    const registry = createRegistry(run, folder);
    await registry.importText(registryFileText(['[K]']));
    code = 2;
    const failed = registry.importText('x');
    await expect(failed).rejects.toThrow(
      'The registry tool could not import: it ended with the code 2.',
    );
    expect(imported).toEqual([registryFileText(['[K]']), 'x']);
    expect(await leftFiles()).toEqual([]);
  });

  it('deletes a key, a key that does not exist being already deleted', async () => {
    const calls: (readonly string[])[] = [];
    let code = 0;
    const registry = createRegistry((args) => {
      calls.push(args);
      return Promise.resolve(code);
    }, folder);
    await registry.deleteKey(KEY);
    code = 1;
    await registry.deleteKey(KEY);
    code = 5;
    await expect(registry.deleteKey(KEY)).rejects.toThrow(new RegistryToolError('delete', 5));
    expect(calls).toEqual([
      ['delete', KEY, '/f'],
      ['delete', KEY, '/f'],
      ['delete', KEY, '/f'],
    ]);
  });

  it('logs a registry file it could not remove', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let file = '';
    const registry = createRegistry(async (args) => {
      file = args[2] ?? '';
      await mkdir(join(file, 'inside'), { recursive: true });
      return 1;
    }, folder);
    expect(await registry.exportKey(KEY)).toBeNull();
    expect(warn.mock.calls).toEqual([
      [
        `The registry file ${file} could not be removed:`,
        expect.objectContaining({ code: 'ERR_FS_EISDIR' }),
      ],
    ]);
  });
});

describe.skipIf(process.platform === 'win32')('runRegistryTool on a stand-in tool', () => {
  /** Places a stand-in for the registry tool in a system folder, running a shell script. */
  async function standIn(script: string): Promise<string> {
    const systemRoot = join(folder, 'Windows');
    await mkdir(join(systemRoot, 'System32'), { recursive: true });
    const tool = join(systemRoot, 'System32', 'reg.exe');
    await writeFile(tool, `#!/bin/sh\necho "$@" > "${folder}/arguments"\n${script}\n`);
    await chmod(tool, 0o755);
    return systemRoot;
  }

  it('gives the exit code of the tool, started from the system folder with its arguments as they are', async () => {
    const run = runRegistryTool(await standIn('exit 0'));
    expect(await run(['query', 'HKCU\\Software', '/v', 'a "b" %1'])).toBe(0);
    expect(await readFile(join(folder, 'arguments'), 'utf8')).toBe(
      'query HKCU\\Software /v a "b" %1\n',
    );
    expect(await runRegistryTool(await standIn('exit 1'))(['export'])).toBe(1);
  });

  it('gives -1 for a tool stopped by a signal, and rejects a tool the system cannot start', async () => {
    expect(await runRegistryTool(await standIn('kill -9 $$'))(['export'])).toBe(-1);
    await expect(runRegistryTool(join(folder, randomUUID()))(['export'])).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe.runIf(process.platform === 'win32')('the registry tool of Windows', () => {
  it('writes, reads and deletes a key of the current user, with a name out of ASCII', async () => {
    const key = `HKEY_CURRENT_USER\\Software\\Tasklace-test-${randomUUID()}`;
    const registry = createRegistry(runRegistryTool(process.env['SystemRoot']), folder);
    try {
      await registry.importText(
        registryFileText([`[${key}]`, `@=${registryString('"C:\\Users\\Maël\\T.exe" -- "%1"')}`]),
      );
      const exported = await registry.exportKey(key);
      expect(exported === null ? null : readRegistryString(exported, null)).toBe(
        '"C:\\Users\\Maël\\T.exe" -- "%1"',
      );
    } finally {
      await registry.deleteKey(key);
    }
    expect(await registry.exportKey(key)).toBeNull();
    expect(await leftFiles()).toEqual([]);
  });
});
