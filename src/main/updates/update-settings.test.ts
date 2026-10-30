import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UPDATE_SETTINGS,
  loadUpdateSettings,
  localDayOf,
  readUpdateSettings,
  storeUpdateSettings,
} from './update-settings';

let folder = '';
let storePath = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-updates-'));
  storePath = join(folder, 'update-check.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

describe('localDayOf', () => {
  it('writes the day of a moment on this computer, with two digits for the month and the day', () => {
    expect(localDayOf(new Date(2026, 0, 5, 0, 0))).toBe('2026-01-05');
    expect(localDayOf(new Date(2026, 9, 30, 23, 59))).toBe('2026-10-30');
  });
});

describe('readUpdateSettings', () => {
  it('reads settings with or without the day of a last check', () => {
    expect(readUpdateSettings({ checkForNewVersions: false, lastCheckedOn: null })).toEqual({
      checkForNewVersions: false,
      lastCheckedOn: null,
    });
    expect(readUpdateSettings({ checkForNewVersions: true, lastCheckedOn: '2026-10-30' })).toEqual({
      checkForNewVersions: true,
      lastCheckedOn: '2026-10-30',
    });
  });

  it('refuses anything else', () => {
    for (const value of [
      null,
      'settings',
      { checkForNewVersions: 'yes', lastCheckedOn: null },
      { checkForNewVersions: true, lastCheckedOn: '30/10/2026' },
      { checkForNewVersions: true, lastCheckedOn: 20_261_030 },
      { checkForNewVersions: true },
      { checkForNewVersions: true, lastCheckedOn: null, extra: 1 },
    ]) {
      expect(readUpdateSettings(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('loadUpdateSettings', () => {
  it('gives the defaults when nothing is stored yet: check on, never checked', async () => {
    expect(await loadUpdateSettings(storePath)).toEqual(DEFAULT_UPDATE_SETTINGS);
    expect(DEFAULT_UPDATE_SETTINGS).toEqual({ checkForNewVersions: true, lastCheckedOn: null });
  });

  it('reads back what was stored', async () => {
    const settings = { checkForNewVersions: false, lastCheckedOn: '2026-10-30' };
    await storeUpdateSettings(storePath, settings);
    expect(JSON.parse(await readFile(storePath, 'utf8'))).toEqual({ version: 1, settings });
    expect(await loadUpdateSettings(storePath)).toEqual(settings);
  });

  it('sets a damaged store aside and gives the defaults', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const damagedStores = [
      '{broken',
      JSON.stringify({ version: 2, settings: DEFAULT_UPDATE_SETTINGS }),
    ];
    for (const damaged of damagedStores) {
      await writeFile(storePath, damaged);
      expect(await loadUpdateSettings(storePath)).toEqual(DEFAULT_UPDATE_SETTINGS);
      const [asideName = ''] = (await readdir(folder)).filter((name) =>
        name.startsWith('update-check.json.damaged-'),
      );
      expect(await readFile(join(folder, asideName), 'utf8')).toBe(damaged);
      await rm(join(folder, asideName));
    }
    expect(error.mock.calls.map(([text]) => String(text).replace(/\d+\.$/, '<ms>.'))).toEqual([
      `The file of the settings of new versions was damaged and was kept as ${storePath}.damaged-<ms>.`,
      `The file of the settings of new versions was damaged and was kept as ${storePath}.damaged-<ms>.`,
    ]);
  });
});
