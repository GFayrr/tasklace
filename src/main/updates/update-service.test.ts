import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain as electronIpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../preload/bridge-contract';
import type { FakeIpcMain } from '../testing/fake-electron';
import type { FetchReleases } from './release-check';
import { registerUpdateHandlers, type UpdateServices } from './update-service';

vi.mock('electron', async () => {
  const fakes = await import('../testing/fake-electron');
  return { ipcMain: new fakes.FakeIpcMain() };
});

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const TODAY = new Date(2026, 9, 30, 9, 30);
const NEWER = JSON.stringify([{ tag_name: 'v0.2.0', draft: false, prerelease: true }]);

let folder = '';
let storePath = '';
let fetched = 0;
let opened: string[] = [];

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-update-service-'));
  storePath = join(folder, 'update-check.json');
  fetched = 0;
  opened = [];
  ipcMain.handlers.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

/** Builds a fetch of releases that counts its calls and answers with a body. */
function releasesAnswering(body: string, status = 200): FetchReleases {
  return () => {
    fetched += 1;
    return Promise.resolve(new Response(body, { status }));
  };
}

/** Registers the channels with fake services, built and installed by default. */
function register(overrides: Partial<UpdateServices> = {}): void {
  registerUpdateHandlers({
    assertTrusted: () => undefined,
    storePath,
    version: '0.1.0',
    isPackaged: true,
    now: () => TODAY,
    fetchReleases: releasesAnswering(NEWER),
    openInBrowser: (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    ...overrides,
  });
}

/** Asks a channel as the page would. */
async function ask(channel: string, ...values: unknown[]): Promise<unknown> {
  return await Promise.resolve(ipcMain.invoke(channel, { sender: {} }, ...values));
}

/** Reads what the store holds. */
async function stored(): Promise<unknown> {
  return JSON.parse(await readFile(storePath, 'utf8'));
}

describe('registerUpdateHandlers', () => {
  it('refuses to start with a version of the application that is not a version', () => {
    expect(() => {
      register({ version: '0.1' });
    }).toThrow(new Error('The version of the application, 0.1, is not a version.'));
  });

  it('gives the version in use and the setting of the check, on by default', async () => {
    register();
    expect(await ask(IPC_CHANNELS.appVersion)).toEqual({ ok: true, value: '0.1.0' });
    expect(await ask(IPC_CHANNELS.updateSettings)).toEqual({
      ok: true,
      value: { checkForNewVersions: true },
    });
  });

  it('turns the check off and on, keeping the day of the last check, and refuses anything else', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    register();
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        settings: { checkForNewVersions: true, lastCheckedOn: '2026-10-29' },
      }),
    );
    expect(await ask(IPC_CHANNELS.setCheckForNewVersions, false)).toEqual({
      ok: true,
      value: null,
    });
    expect(await stored()).toEqual({
      version: 1,
      settings: { checkForNewVersions: false, lastCheckedOn: '2026-10-29' },
    });
    expect(await ask(IPC_CHANNELS.setCheckForNewVersions, 'off')).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    expect(error.mock.calls).toEqual([
      [
        'The page asked to turn the check for new versions to a value that is not on or off:',
        'off',
      ],
    ]);
  });

  it('checks at launch once a day, noting the day of a check that reached GitHub', async () => {
    register();
    expect(await ask(IPC_CHANNELS.checkAtLaunch)).toEqual({
      ok: true,
      value: { kind: 'newer', version: '0.2.0' },
    });
    expect(await stored()).toEqual({
      version: 1,
      settings: { checkForNewVersions: true, lastCheckedOn: '2026-10-30' },
    });
    expect(await ask(IPC_CHANNELS.checkAtLaunch)).toEqual({ ok: true, value: { kind: 'skipped' } });
    expect(fetched).toBe(1);
  });

  it('checks again at launch the next day', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        settings: { checkForNewVersions: true, lastCheckedOn: '2026-10-29' },
      }),
    );
    register();
    expect(await ask(IPC_CHANNELS.checkAtLaunch)).toEqual({
      ok: true,
      value: { kind: 'newer', version: '0.2.0' },
    });
    expect(fetched).toBe(1);
  });

  it('checks again at the next launch the same day when GitHub could not answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    register({ fetchReleases: releasesAnswering('', 503) });
    expect(await ask(IPC_CHANNELS.checkAtLaunch)).toEqual({
      ok: true,
      value: { kind: 'failed', reason: 'refused' },
    });
    expect(await ask(IPC_CHANNELS.checkAtLaunch)).toEqual({
      ok: true,
      value: { kind: 'failed', reason: 'refused' },
    });
    expect(fetched).toBe(2);
  });

  it('skips the check at launch when it is turned off, or in an application that is not built', async () => {
    register({ isPackaged: false });
    expect(await ask(IPC_CHANNELS.checkAtLaunch)).toEqual({ ok: true, value: { kind: 'skipped' } });
    ipcMain.handlers.clear();
    await writeFile(
      storePath,
      JSON.stringify({ version: 1, settings: { checkForNewVersions: false, lastCheckedOn: null } }),
    );
    register();
    expect(await ask(IPC_CHANNELS.checkAtLaunch)).toEqual({ ok: true, value: { kind: 'skipped' } });
    expect(fetched).toBe(0);
  });

  it('checks now whatever the setting and the day, sharing a check that already runs', async () => {
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        settings: { checkForNewVersions: false, lastCheckedOn: '2026-10-30' },
      }),
    );
    register();
    const [first, second] = await Promise.all([
      ask(IPC_CHANNELS.checkNow),
      ask(IPC_CHANNELS.checkNow),
    ]);
    expect([first, second]).toEqual([
      { ok: true, value: { kind: 'newer', version: '0.2.0' } },
      { ok: true, value: { kind: 'newer', version: '0.2.0' } },
    ]);
    expect(fetched).toBe(1);
    expect(await ask(IPC_CHANNELS.checkNow)).toEqual({
      ok: true,
      value: { kind: 'newer', version: '0.2.0' },
    });
    expect(fetched).toBe(2);
  });

  it('opens the page of a release built from the version, and refuses a value that is not a version', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    register();
    expect(await ask(IPC_CHANNELS.openReleasePage, 'v0.2.0')).toEqual({ ok: true, value: null });
    expect(await ask(IPC_CHANNELS.openReleasePage, 'https://evil.example/0.2.0')).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    expect(opened).toEqual(['https://github.com/GFayrr/tasklace/releases/tag/v0.2.0']);
    expect(error.mock.calls).toEqual([
      [
        'The page asked to open the release page of a value that is not a version:',
        'https://evil.example/0.2.0',
      ],
    ]);
  });

  it('opens the privacy policy, and tells when the browser cannot open a page', async () => {
    register();
    expect(await ask(IPC_CHANNELS.openPrivacyPolicy)).toEqual({ ok: true, value: null });
    expect(opened).toEqual(['https://github.com/GFayrr/tasklace/blob/main/PRIVACY.md']);
    ipcMain.handlers.clear();
    register({ openInBrowser: () => Promise.resolve(false) });
    expect(await ask(IPC_CHANNELS.openPrivacyPolicy)).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
    expect(await ask(IPC_CHANNELS.openReleasePage, '0.2.0')).toEqual({
      ok: false,
      error: { code: 'TASK_FAILED' },
    });
  });
});
