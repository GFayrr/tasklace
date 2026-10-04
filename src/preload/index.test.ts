import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_NAME, IPC_CHANNELS, type TasklaceBridge } from './bridge-contract';

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  listeners: new Map<string, () => void>(),
  sent: [] as [string, unknown][],
  invoke: vi.fn<(channel: string, ...values: unknown[]) => Promise<unknown>>(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      electron.exposed.set(name, api);
    },
  },
  ipcRenderer: {
    invoke: (channel: string, ...values: unknown[]) => electron.invoke(channel, ...values),
    on: (channel: string, listener: () => void) => {
      electron.listeners.set(channel, listener);
    },
    send: (channel: string, value: unknown) => {
      electron.sent.push([channel, value]);
    },
  },
}));

const FORMAT = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
};

/** Loads a fresh bridge script and returns what it exposes to the page. */
async function loadBridge(): Promise<TasklaceBridge> {
  vi.resetModules();
  await import('./index');
  return electron.exposed.get(BRIDGE_NAME) as TasklaceBridge;
}

/** Asks the bridge to close the window, as the main process does, and waits for its answer. */
async function requestClose(): Promise<void> {
  electron.listeners.get(IPC_CHANNELS.flushRequested)?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  electron.sent.length = 0;
  electron.invoke.mockReset();
});

afterEach(() => {
  electron.exposed.clear();
  electron.listeners.clear();
});

describe('the bridge exposed to the page', () => {
  it('sends each request on its own channel with its values', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue({ ok: true, value: null });
    const state = Uint8Array.from([1]);
    await bridge.openProject();
    await bridge.openRecentProject(2);
    await bridge.importProject('csv');
    await bridge.adoptProject('11111111-1111-4111-8111-111111111111');
    await bridge.saveProject(state);
    await bridge.saveProjectAs(state, 'Plan');
    await bridge.exportProject('json', '{}', 'Plan');
    expect(electron.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.openProject],
      [IPC_CHANNELS.openRecentProject, 2],
      [IPC_CHANNELS.importProject, 'csv'],
      [IPC_CHANNELS.adoptProject, '11111111-1111-4111-8111-111111111111'],
      [IPC_CHANNELS.saveProject, state],
      [IPC_CHANNELS.saveProjectAs, state, 'Plan'],
      [IPC_CHANNELS.exportProject, 'json', '{}', 'Plan'],
    ]);
  });

  it('tells the main process that the page could not start', async () => {
    const bridge = await loadBridge();
    bridge.reportStartFailure();
    expect(electron.sent).toEqual([[IPC_CHANNELS.pageStartFailed, undefined]]);
  });

  it('turns an answer that is not a result into a failed task', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue('nonsense');
    expect(await bridge.openProject()).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
  });

  it('gives simple answers their expected type', async () => {
    const bridge = await loadBridge();
    electron.invoke
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce('yes')
      .mockResolvedValueOnce(true);
    expect(await bridge.appVersion()).toBe('12');
    expect(await bridge.openExternal('https://github.com/GFayrr/tasklace')).toBe(false);
    expect(await bridge.openExternal('https://github.com/GFayrr/tasklace')).toBe(true);
    electron.invoke.mockResolvedValueOnce('11111111-1111-4111-8111-111111111111');
    expect(await bridge.newProject()).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('keeps only well-formed recent projects, none from a value that is not a list, and passes a failure through, logging each unexpected answer', async () => {
    const bridge = await loadBridge();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const entries = [
        { name: 'Plan', folder: '/projects' },
        { name: 3, folder: '/projects' },
        { name: 'Other' },
        null,
      ];
      electron.invoke.mockResolvedValueOnce({ ok: true, value: entries });
      expect(await bridge.recentProjects()).toEqual({
        ok: true,
        value: [{ name: 'Plan', folder: '/projects' }],
      });
      const single = { name: 'Plan', folder: '/projects' };
      electron.invoke.mockResolvedValueOnce({ ok: true, value: single });
      expect(await bridge.recentProjects()).toEqual({ ok: true, value: [] });
      electron.invoke.mockResolvedValueOnce({ ok: true, value: [single] });
      expect(await bridge.recentProjects()).toEqual({ ok: true, value: [single] });
      electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'READ_FAILED' } });
      expect(await bridge.recentProjects()).toEqual({ ok: false, error: { code: 'READ_FAILED' } });
      electron.invoke.mockResolvedValueOnce([single]);
      expect(await bridge.recentProjects()).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
      expect(logged.mock.calls).toEqual([
        ['The main process sent recent projects of an unexpected shape:', entries],
        ['The main process sent recent projects of an unexpected shape:', single],
        [
          `The main process answered ${IPC_CHANNELS.recentProjects} with an unexpected shape:`,
          [single],
        ],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it('gives the regional format, refusing an answer of another shape', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValueOnce(FORMAT);
    expect(await bridge.regionalFormat()).toEqual(FORMAT);
    electron.invoke.mockResolvedValueOnce({ listSeparator: ';' });
    await expect(bridge.regionalFormat()).rejects.toThrow('Unexpected regional format');
    electron.invoke.mockResolvedValueOnce(null);
    await expect(bridge.regionalFormat()).rejects.toThrow('Unexpected regional format');
    for (const changed of [
      { listSeparator: '|' },
      { dateOrder: 'yearDayMonth' },
      { dateSeparator: ' ' },
      { twelveHourClock: 'no' },
    ]) {
      electron.invoke.mockResolvedValueOnce({ ...FORMAT, ...changed });
      await expect(bridge.regionalFormat()).rejects.toThrow('Unexpected regional format');
    }
  });
});

describe('closing the window', () => {
  it('lets the window close at once while the page has not started', async () => {
    await loadBridge();
    await requestClose();
    expect(electron.sent).toEqual([[IPC_CHANNELS.flushDone, true]]);
  });

  it('passes on the answer of the page once it has saved', async () => {
    const bridge = await loadBridge();
    bridge.onFlushRequested(() => Promise.resolve(false));
    await requestClose();
    bridge.onFlushRequested(() => Promise.resolve(true));
    await requestClose();
    expect(electron.sent).toEqual([
      [IPC_CHANNELS.flushDone, false],
      [IPC_CHANNELS.flushDone, true],
    ]);
  });

  it('keeps the window open when the page fails unexpectedly, logging why', async () => {
    const bridge = await loadBridge();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      bridge.onFlushRequested(() => Promise.reject(new Error('page broken')));
      await requestClose();
      expect(logged).toHaveBeenCalledWith(
        'The page could not prepare to close:',
        expect.any(Error),
      );
    } finally {
      logged.mockRestore();
    }
    expect(electron.sent).toEqual([[IPC_CHANNELS.flushDone, false]]);
  });
});
