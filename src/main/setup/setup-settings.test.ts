import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_PATH_LENGTH } from '../../core/limits';
import {
  DEFAULT_SETUP_SETTINGS,
  loadSetupSettings,
  readSetupSettings,
  storeSetupSettings,
} from './setup-settings';

const EXECUTABLE = 'C:\\Users\\Lea\\Downloads\\Tasklace-0.1.0-portable.exe';

let folder = '';
let storePath = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-setup-settings-'));
  storePath = join(folder, 'setup.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

describe('readSetupSettings', () => {
  it('reads whether the welcome window got its answer and the executable registered to open files', () => {
    expect(readSetupSettings({ welcomed: false, registeredExecutable: null })).toEqual({
      welcomed: false,
      registeredExecutable: null,
    });
    expect(readSetupSettings({ welcomed: true, registeredExecutable: EXECUTABLE })).toEqual({
      welcomed: true,
      registeredExecutable: EXECUTABLE,
    });
  });

  it('refuses anything else', () => {
    for (const value of [
      null,
      'setup',
      { welcomed: 'yes', registeredExecutable: null },
      { welcomed: true, registeredExecutable: 'Tasklace.exe' },
      { welcomed: true, registeredExecutable: '/opt/Tasklace/tasklace' },
      { welcomed: true, registeredExecutable: 'C:\\Users\\"Lea"\\Tasklace.exe' },
      { welcomed: true, registeredExecutable: 'C:\\Users\\Lea\0\\Tasklace.exe' },
      { welcomed: true, registeredExecutable: `C:\\${'a'.repeat(MAX_FILE_PATH_LENGTH)}.exe` },
      { welcomed: true, registeredExecutable: 7 },
      { welcomed: true },
      { welcomed: true, registeredExecutable: null, extra: 1 },
    ]) {
      expect(readSetupSettings(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('loadSetupSettings', () => {
  it('gives the defaults when nothing is stored yet: not welcomed, nothing registered', async () => {
    expect(await loadSetupSettings(storePath)).toEqual(DEFAULT_SETUP_SETTINGS);
    expect(DEFAULT_SETUP_SETTINGS).toEqual({ welcomed: false, registeredExecutable: null });
  });

  it('reads back what was stored', async () => {
    const settings = { welcomed: true, registeredExecutable: EXECUTABLE };
    await storeSetupSettings(storePath, settings);
    expect(JSON.parse(await readFile(storePath, 'utf8'))).toEqual({ version: 1, settings });
    expect(await loadSetupSettings(storePath)).toEqual(settings);
  });

  it('sets a damaged store aside and gives the defaults', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const damaged of [
      '{broken',
      JSON.stringify({ version: 2, settings: DEFAULT_SETUP_SETTINGS }),
    ]) {
      await writeFile(storePath, damaged);
      expect(await loadSetupSettings(storePath)).toEqual(DEFAULT_SETUP_SETTINGS);
      const [asideName = ''] = (await readdir(folder)).filter((name) =>
        name.startsWith('setup.json.damaged-'),
      );
      expect(await readFile(join(folder, asideName), 'utf8')).toBe(damaged);
      await rm(join(folder, asideName));
    }
    expect(error.mock.calls.map(([text]) => String(text).replace(/\d+\.$/, '<ms>.'))).toEqual([
      `The file of the setup of Tasklace was damaged and was kept as ${storePath}.damaged-<ms>.`,
      `The file of the setup of Tasklace was damaged and was kept as ${storePath}.damaged-<ms>.`,
    ]);
  });
});
