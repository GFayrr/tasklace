import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrintDocument } from '../core/print/print-document';
import { BRIDGE_NAME, IPC_CHANNELS, type TasklaceBridge } from './bridge-contract';
import { requireDocumentId } from '../core/shared/shared-document';

const PRINTED: PrintDocument = {
  paper: 'a4',
  orientation: 'landscape',
  title: 'Thesis',
  pages: [[]],
};

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  listeners: new Map<string, (event?: unknown, value?: unknown) => void>(),
  sent: [] as unknown[][],
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
    on: (channel: string, listener: (event?: unknown, value?: unknown) => void) => {
      electron.listeners.set(channel, listener);
    },
    send: (channel: string, ...values: unknown[]) => {
      electron.sent.push([channel, ...values]);
    },
  },
}));

const ENDPOINT = { addresses: ['192.168.1.24'], port: 47_313 };

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
    await bridge.adoptProject(requireDocumentId('11111111-1111-4111-8111-111111111111'));
    await bridge.saveProject(state);
    await bridge.saveProjectAs(state, 'Plan');
    await bridge.keepOwnChanges(state, 'Plan');
    await bridge.openKeptChanges();
    await bridge.exportProject('json', '{}', 'Plan');
    await bridge.exportPdf(PRINTED, 'Plan');
    await bridge.saveHeldPdf();
    await bridge.exportLighterPdf();
    expect(electron.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.openProject],
      [IPC_CHANNELS.openRecentProject, 2],
      [IPC_CHANNELS.importProject, 'csv'],
      [IPC_CHANNELS.adoptProject, '11111111-1111-4111-8111-111111111111'],
      [IPC_CHANNELS.saveProject, state],
      [IPC_CHANNELS.saveProjectAs, state, 'Plan'],
      [IPC_CHANNELS.keepOwnChanges, state, 'Plan'],
      [IPC_CHANNELS.openKeptChanges],
      [IPC_CHANNELS.exportProject, 'json', '{}', 'Plan'],
      [IPC_CHANNELS.exportPdf, PRINTED, 'Plan'],
      [IPC_CHANNELS.saveHeldPdf],
      [IPC_CHANNELS.exportLighterPdf],
    ]);
  });

  it('tells the main process that the page could not start', async () => {
    const bridge = await loadBridge();
    bridge.reportStartFailure();
    expect(electron.sent).toEqual([[IPC_CHANNELS.pageStartFailed]]);
  });

  it('turns an answer that is not a result into a failed task', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue('nonsense');
    expect(await bridge.openProject()).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
  });

  it('gives simple answers their expected type', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValueOnce('11111111-1111-4111-8111-111111111111');
    expect(await bridge.newProject()).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('refuses recent projects with an entry of an unexpected shape, whose positions would no longer match, or that are not a list, and passes a failure through, logging each unexpected answer', async () => {
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
      expect(await bridge.recentProjects()).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
      const single = { name: 'Plan', folder: '/projects' };
      electron.invoke.mockResolvedValueOnce({ ok: true, value: single });
      expect(await bridge.recentProjects()).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
      electron.invoke.mockResolvedValueOnce({ ok: true, value: [single] });
      expect(await bridge.recentProjects()).toEqual({ ok: true, value: [single] });
      electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: 'READ_FAILED' } });
      expect(await bridge.recentProjects()).toEqual({ ok: false, error: { code: 'READ_FAILED' } });
      electron.invoke.mockResolvedValueOnce([single]);
      expect(await bridge.recentProjects()).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
      expect(logged.mock.calls).toEqual([
        ['The main process sent recent projects of an unexpected shape:', entries],
        ['The main process sent recent projects that are not a list:', single],
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

describe('the shared plan through the bridge', () => {
  it('sends each collaboration request on its own channel with its values', async () => {
    const bridge = await loadBridge();
    electron.invoke.mockResolvedValue({ ok: true, value: null });
    const settings = { name: 'Léa', port: 47_313, firewallNoticeSeen: true };
    const joining = {
      address: '192.168.1.24',
      port: 47_313,
      code: 'K7Q4MZ',
      participantId: 'lea',
      name: 'Léa',
    };
    await bridge.collaborationSettings();
    await bridge.saveCollaborationSettings(settings);
    await bridge.sharePlan('Thesis', 'Camille', 'camille');
    await bridge.stopCollaboration();
    await bridge.joinPlan(joining);
    await bridge.openSharedPlan(Uint8Array.of(1));
    await bridge.findPlans(true);
    await bridge.dropPeer(2);
    await bridge.copyJoinCode();
    await bridge.findNextHost(
      [{ participantId: 'lea', rank: 1, endpoint: null }],
      'Thesis',
      'Léa',
      [],
    );
    expect(electron.invoke.mock.calls).toEqual([
      [IPC_CHANNELS.collaborationSettings],
      [IPC_CHANNELS.saveCollaborationSettings, settings],
      [IPC_CHANNELS.sharePlan, 'Thesis', 'Camille', 'camille'],
      [IPC_CHANNELS.stopCollaboration],
      [IPC_CHANNELS.joinPlan, joining],
      [IPC_CHANNELS.openSharedPlan, Uint8Array.of(1)],
      [IPC_CHANNELS.findPlans, true],
      [IPC_CHANNELS.dropPeer, 2],
      [IPC_CHANNELS.copyJoinCode],
      [
        IPC_CHANNELS.findNextHost,
        [{ participantId: 'lea', rank: 1, endpoint: null }],
        'Thesis',
        'Léa',
        [],
      ],
    ]);
  });

  it('sends the messages of the plan without waiting for an answer', async () => {
    const bridge = await loadBridge();
    bridge.sendToCollaboration('host', Uint8Array.of(1));
    bridge.sendToCollaboration(3, Uint8Array.of(2));
    expect(electron.sent).toEqual([
      [IPC_CHANNELS.collaborationSend, 'host', Uint8Array.of(1)],
      [IPC_CHANNELS.collaborationSend, 3, Uint8Array.of(2)],
    ]);
  });

  it('passes on each event of the main process of a known shape, and logs any other', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bridge = await loadBridge();
    /** Sends an event to the page as the main process does. */
    const emit = (value: unknown): void => {
      electron.listeners.get(IPC_CHANNELS.collaborationEvent)?.({}, value);
    };
    emit({ kind: 'connected' });
    const received: unknown[] = [];
    bridge.onCollaborationEvent((event) => received.push(event));
    const plan = {
      key: 'k',
      planName: 'Thesis',
      hostName: 'Camille',
      addresses: ['10.0.0.1'],
      port: 1,
    };
    const valid = [
      {
        kind: 'peerJoined',
        peer: 1,
        participantId: 'lea',
        name: 'Léa',
        endpoint: ENDPOINT,
        tokenDigest: 'd'.repeat(64),
      },
      { kind: 'peerMessage', peer: 1, message: Uint8Array.of(1) },
      { kind: 'peerLeft', peer: 1 },
      { kind: 'codeChanged', code: 'K7Q4MZ' },
      { kind: 'nearbyPlans', plans: [plan] },
      { kind: 'connected' },
      { kind: 'reconnecting' },
      { kind: 'hostLeft' },
      { kind: 'yielded' },
      {
        kind: 'becameHost',
        sharing: {
          code: 'K7Q4MZ',
          port: 47_313,
          addresses: ['10.0.0.1'],
          tokenDigest: 'd'.repeat(64),
        },
      },
      { kind: 'offline' },
      { kind: 'hostMessage', message: Uint8Array.of(2) },
      { kind: 'ended', reason: 'WRONG_CODE' },
      { kind: 'ended', reason: 'REMOVED' },
    ];
    const invalid = [
      null,
      { kind: 'unknown' },
      { kind: 'constructor' },
      {
        kind: 'peerJoined',
        peer: 1.5,
        participantId: 'lea',
        name: 'Léa',
        endpoint: ENDPOINT,
        tokenDigest: 'd'.repeat(64),
      },
      {
        kind: 'peerJoined',
        peer: 1,
        participantId: 'lea',
        name: 'Léa',
        endpoint: { port: 1 },
        tokenDigest: 'd'.repeat(64),
      },
      { kind: 'peerMessage', peer: 1, message: [1] },
      { kind: 'codeChanged', code: 1 },
      { kind: 'nearbyPlans', plans: [{ ...plan, addresses: [1] }] },
      { kind: 'nearbyPlans', plans: 'none' },
      { kind: 'ended', reason: 'SOMETHING' },
      {
        kind: 'becameHost',
        sharing: { code: 'K7Q4MZ', port: 47_313, addresses: [1], tokenDigest: 'd'.repeat(64) },
      },
      { kind: 'becameHost', sharing: null },
    ];
    [...valid, ...invalid].forEach(emit);
    expect(received).toEqual(valid);
    expect(errors.mock.calls.map((call): unknown => call[1])).toEqual(invalid);
  });
});
