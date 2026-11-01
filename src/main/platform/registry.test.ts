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
  type ToolOutcome,
} from './registry';

const KEY = 'HKEY_CURRENT_USER\\Software\\Tasklace\\Setup';
const SUBKEY = `${KEY}\\Inner`;
const WITNESS = ['query', 'HKEY_CURRENT_USER\\Software'];
const DONE: ToolOutcome = { exitCode: 0, errorOutput: '' };
const NOT_DONE: ToolOutcome = { exitCode: 1, errorOutput: 'ERROR: unable to find the key' };
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
  `[${SUBKEY}]`,
  '@="inner"',
  '"Inner"=dword:00000001',
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

/** Builds a registry tool that answers each command in turn with the outcomes given, writing an exported key where it is asked to, and records the commands. */
function scriptedTool(outcomes: readonly ToolOutcome[], exported = EXPORTED) {
  const calls: (readonly string[])[] = [];
  /** Answers one command with the next outcome, writing the exported key for a successful export. */
  const run: RunRegistryTool = async (args) => {
    calls.push(args);
    const outcome = outcomes[calls.length - 1] ?? DONE;
    if (args[0] === 'export' && outcome.exitCode === 0) {
      await writeFile(args[2] ?? '', `\ufeff${exported}`, 'utf16le');
    }
    return outcome;
  };
  return { run, calls };
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

  it('reads the default and named texts and numbers of one key, and nothing that is missing, of another kind or of another key', () => {
    expect(readRegistryString(EXPORTED, KEY, null)).toBe('"C:\\Users\\Maël\\Tasklace.exe" -- "%1"');
    expect(readRegistryString(EXPORTED, KEY.toLowerCase(), 'Name')).toBe('A "quoted" name');
    expect(readRegistryString(EXPORTED, KEY, 'Associate')).toBeNull();
    expect(readRegistryString(EXPORTED, KEY, 'Missing')).toBeNull();
    expect(readRegistryString(EXPORTED, SUBKEY, null)).toBe('inner');
    expect(readRegistryString(EXPORTED, `${KEY}\\Other`, null)).toBeNull();
    expect(readRegistryNumber(EXPORTED, KEY, 'Associate')).toBe(1);
    expect(readRegistryNumber(EXPORTED, KEY, 'CheckForNewVersions')).toBe(0);
    expect(readRegistryNumber(EXPORTED, KEY, 'Broken')).toBeNull();
    expect(readRegistryNumber(EXPORTED, KEY, 'Name')).toBeNull();
    expect(readRegistryNumber(EXPORTED, KEY, 'Inner')).toBeNull();
    expect(readRegistryNumber(EXPORTED, SUBKEY, 'Inner')).toBe(1);
  });

  it('never reads the default value of a key from a key under it', () => {
    const withoutDefault = [`[${KEY}]`, '"Name"="x"', '', `[${SUBKEY}]`, '@="inner"'].join('\r\n');
    expect(readRegistryString(withoutDefault, KEY, null)).toBeNull();
  });
});

describe('createRegistry', () => {
  it('exports a key into a file of its own in UTF-16, reads it and removes the file', async () => {
    const { run, calls } = scriptedTool([DONE]);
    expect(await createRegistry(run, folder).exportKey(KEY)).toBe(EXPORTED);
    expect(calls).toEqual([['export', KEY, expect.stringMatching(/registry-.+\.reg$/), '/y']]);
    expect(calls[0]?.[2]?.startsWith(folder)).toBe(true);
    expect(await leftFiles()).toEqual([]);
  });

  it('takes a refused export for a missing key only when the tool still reads a key that always exists', async () => {
    const missing = scriptedTool([NOT_DONE, DONE]);
    expect(await createRegistry(missing.run, folder).exportKey(KEY)).toBeNull();
    expect(missing.calls.slice(1)).toEqual([WITNESS]);
    const blocked = scriptedTool([NOT_DONE, NOT_DONE]);
    await expect(createRegistry(blocked.run, folder).exportKey(KEY)).rejects.toThrow(
      'The registry tool could not export: it ended with the code 1 (ERROR: unable to find the key).',
    );
    const failed = scriptedTool([{ exitCode: 5, errorOutput: '' }]);
    await expect(createRegistry(failed.run, folder).exportKey(KEY)).rejects.toThrow(
      new RegistryToolError('export', { exitCode: 5, errorOutput: '' }),
    );
    expect(await leftFiles()).toEqual([]);
  });

  it('imports a text through a file in UTF-16 that it removes, even when the tool fails', async () => {
    const imported: string[] = [];
    let outcome: ToolOutcome = DONE;
    /** Reads the file the tool is asked to import, as the registry tool does. */
    const run: RunRegistryTool = async (args) => {
      expect(args.slice(0, 1)).toEqual(['import']);
      imported.push(await readFile(args[1] ?? '', 'utf16le'));
      return outcome;
    };
    const registry = createRegistry(run, folder);
    await registry.importText(registryFileText(['[K]']));
    outcome = { exitCode: 'stopped', errorOutput: '' };
    await expect(registry.importText('x')).rejects.toThrow(
      'The registry tool could not import: it was stopped.',
    );
    expect(imported).toEqual([registryFileText(['[K]']), 'x']);
    expect(await leftFiles()).toEqual([]);
  });

  it('deletes a key and checks it is gone, a key that does not exist being deleted already', async () => {
    const deleted = scriptedTool([DONE, NOT_DONE, DONE]);
    await createRegistry(deleted.run, folder).deleteKey(KEY);
    expect(deleted.calls).toEqual([
      ['delete', KEY, '/f'],
      ['export', KEY, expect.any(String), '/y'],
      WITNESS,
    ]);
    const missing = scriptedTool([NOT_DONE, DONE]);
    await createRegistry(missing.run, folder).deleteKey(KEY);
    expect(missing.calls).toEqual([['delete', KEY, '/f'], WITNESS]);
  });

  it('throws when a key cannot be deleted, when the tool is blocked, or when the key is still there', async () => {
    const refused = scriptedTool([{ exitCode: 5, errorOutput: 'ERROR: Access is denied.' }]);
    await expect(createRegistry(refused.run, folder).deleteKey(KEY)).rejects.toThrow(
      'The registry tool could not delete: it ended with the code 5 (ERROR: Access is denied.).',
    );
    const blocked = scriptedTool([NOT_DONE, NOT_DONE]);
    await expect(createRegistry(blocked.run, folder).deleteKey(KEY)).rejects.toThrow(
      new RegistryToolError('delete', NOT_DONE),
    );
    const kept = scriptedTool([DONE, DONE]);
    await expect(createRegistry(kept.run, folder).deleteKey(KEY)).rejects.toThrow(
      'The registry tool could not delete: it ended with the code 0 (the key is still there).',
    );
  });

  it('logs a registry file it could not remove', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let file = '';
    const registry = createRegistry(async (args) => {
      if (args[0] === 'export') {
        file = args[2] ?? '';
        await mkdir(join(file, 'inside'), { recursive: true });
        return NOT_DONE;
      }
      return DONE;
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

  it('gives the exit code of the tool and what it wrote as an error, started from the system folder with its arguments as they are', async () => {
    const run = runRegistryTool(await standIn('exit 0'));
    expect(await run(['query', 'HKCU\\Software', '/v', 'a "b" %1'])).toEqual(DONE);
    expect(await readFile(join(folder, 'arguments'), 'utf8')).toBe(
      'query HKCU\\Software /v a "b" %1\n',
    );
    expect(
      await runRegistryTool(await standIn('echo "ERROR: denied" >&2; exit 1'))(['export']),
    ).toEqual({ exitCode: 1, errorOutput: 'ERROR: denied' });
  });

  it('tells of a tool stopped by a signal, and rejects a tool the system cannot start', async () => {
    expect(await runRegistryTool(await standIn('kill -9 $$'))(['export'])).toEqual({
      exitCode: 'stopped',
      errorOutput: '',
    });
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
      expect(exported === null ? null : readRegistryString(exported, key, null)).toBe(
        '"C:\\Users\\Maël\\T.exe" -- "%1"',
      );
    } finally {
      await registry.deleteKey(key);
    }
    expect(await registry.exportKey(key)).toBeNull();
    expect(await leftFiles()).toEqual([]);
  });
});
