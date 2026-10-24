import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COLLABORATION_SETTINGS,
  loadCollaborationSettings,
  readCollaborationSettings,
  storeCollaborationSettings,
} from './collaboration-settings';

let folder = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-collaboration-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

describe('the collaboration settings of this computer', () => {
  it('starts with no name, port 47313 and the note about the firewall not seen', async () => {
    expect(await loadCollaborationSettings(join(folder, 'settings.json'))).toEqual({
      name: null,
      port: 47_313,
      firewallNoticeSeen: false,
    });
  });

  it('keeps what was stored', async () => {
    const path = join(folder, 'settings.json');
    const settings = { name: 'Camille', port: 50_000, firewallNoticeSeen: true };
    await storeCollaborationSettings(path, settings);
    expect(await loadCollaborationSettings(path)).toEqual(settings);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['another version', JSON.stringify({ version: 2, settings: DEFAULT_COLLABORATION_SETTINGS })],
    [
      'invalid settings',
      JSON.stringify({ version: 1, settings: { name: 3, port: 1, firewallNoticeSeen: false } }),
    ],
  ])('sets aside a store holding %s and uses the defaults', async (_label, text) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const path = join(folder, 'settings.json');
    await writeFile(path, text);
    expect(await loadCollaborationSettings(path)).toEqual(DEFAULT_COLLABORATION_SETTINGS);
    const files = await readdir(folder);
    expect(files.map((file) => file.replace(/\d+$/, 'N'))).toEqual(['settings.json.damaged-N']);
    expect(errors.mock.calls.map((call): unknown => call[0])).toEqual([
      `The file of the collaboration settings was damaged and was kept as ${join(folder, files[0] ?? '')}.`,
    ]);
  });

  it('reads settings from an untrusted value, refusing every other shape', () => {
    expect(readCollaborationSettings({ name: 'Léa', port: 1, firewallNoticeSeen: false })).toEqual({
      name: 'Léa',
      port: 1,
      firewallNoticeSeen: false,
    });
    expect(
      [
        null,
        'text',
        { name: null, port: 1, firewallNoticeSeen: false, extra: 1 },
        { name: ' ', port: 1, firewallNoticeSeen: false },
        { name: 'x'.repeat(65), port: 1, firewallNoticeSeen: false },
        { name: null, port: 0, firewallNoticeSeen: false },
        { name: null, port: '1', firewallNoticeSeen: false },
        { name: null, port: 1, firewallNoticeSeen: 'no' },
      ].map(readCollaborationSettings),
    ).toEqual([null, null, null, null, null, null, null, null]);
  });
});
