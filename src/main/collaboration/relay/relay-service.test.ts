import { ipcMain as electronIpcMain, type WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { WebSocketServer } from 'ws';
import { startRelayServer, type RunningRelay } from '../../../../relay/src/server.ts';
import { testConfig } from '../../../../relay/src/testing/relay-client.ts';
import { temporaryFolder } from '../../../../relay/src/testing/relay-records.ts';
import { encodeMessage } from '../../../core/collaboration/messages';
import { AEAD_TAG_BYTES } from '../../../core/collaboration/secure/channel';
import {
  encodeRelayLink,
  readRelayLink,
  shownRelayLink,
} from '../../../core/collaboration/relay/relay-link';
import { failure, success } from '../../../core/result';
import { createSharedDocument, type DocumentId } from '../../../core/shared/shared-document';
import {
  forgedDocumentId,
  project,
  TEST_DOCUMENT_ID,
  workTask,
} from '../../../core/testing/project-builder';
import { IPC_CHANNELS, type CollaborationEvent } from '../../../preload/bridge-contract';
import { runFileTask, type ResultOfTask, type FileTask } from '../../file-tasks';
import type { FakeIpcMain } from '../../testing/fake-electron';
import { freePort, LOOPBACK, until } from '../../testing/plan-host';
import { TEST_CERTIFICATE, writeRelayCertificate } from '../../testing/test-certificate';
import type { StartTimer } from '../secure-connection';
import { zlibCompressor } from '../../zlib-compressor';
import { systemRandomBytes } from '../aes-gcm';
import type { RelayLinkStore } from './relay-links';
import { readRelayOutgoing, registerRelayHandlers, type RelayHandlers } from './relay-service';

vi.mock('electron', async () => {
  const fakes = await import('../../testing/fake-electron');
  return { ipcMain: new fakes.FakeIpcMain() };
});

vi.mock('../../../core/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/limits')>()),
  MAX_UNCOMPRESSED_BYTES: SMALL_PLAN_BYTES,
}));

vi.mock('node:tls', async (importOriginal) => {
  const tls = await importOriginal<typeof import('node:tls')>();
  const { trustingTestCertificate } = await import('../../testing/test-certificate');
  return { ...tls, getCACertificates: trustingTestCertificate(tls.getCACertificates) };
});

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const OTHER_PLAN = forgedDocumentId('1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d');
const PLAN_STATE = Y.encodeStateAsUpdate(
  createSharedDocument(project([workTask('a')]), TEST_DOCUMENT_ID),
);
const SPEED_UP = 64;
const SMALL_PLAN_BYTES = vi.hoisted(() => 1_048_576);
const NOISE_BYTES = 400_000;

/** A fake page that records the events the main process sends it. */
class FakePage {
  readonly events: CollaborationEvent[] = [];
  destroyed = false;

  /** Records an event sent on the channel of the shared plan. */
  send(channel: string, event: CollaborationEvent): void {
    if (channel === IPC_CHANNELS.collaborationEvent) {
      this.events.push(event);
    }
  }

  /** Tells whether the page is gone. */
  isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Gives the kinds of the events the page received, in order. */
  kinds(): string[] {
    return this.events.map((event) => event.kind);
  }
}

/** Keeps links in memory as the store of the vault would, and can be made to fail. */
function memoryLinks() {
  const kept = new Map<DocumentId, string>();
  const state = {
    keepThrows: false,
    thrown: undefined as unknown,
    vault: true,
    findFails: null as Error | null,
    linkUnreadable: false,
    forgetFails: null as Error | null,
  };
  const store: RelayLinkStore = {
    keep: async (documentId, link) => {
      await Promise.resolve();
      if (state.keepThrows) {
        throw state.thrown;
      }
      if (!state.vault) {
        return failure('NO_SAFE_STORAGE');
      }
      kept.set(documentId, encodeRelayLink(link));
      return success(undefined);
    },
    find: (documentId) => {
      if (state.findFails !== null) {
        return Promise.reject(state.findFails);
      }
      if (state.linkUnreadable) {
        return Promise.resolve(failure('LINK_UNREADABLE'));
      }
      const text = kept.get(documentId);
      const link = text === undefined ? null : readRelayLink(text);
      return Promise.resolve(success(link?.ok === true ? link.value : null));
    },
    forget: (documentId) => {
      if (state.forgetFails !== null) {
        return Promise.reject(state.forgetFails);
      }
      kept.delete(documentId);
      return Promise.resolve();
    },
  };
  return { kept, state, store };
}

/** Runs the waits of the sessions sixty-four times faster. */
const fastTimer: StartTimer = (milliseconds, onEnd) => {
  const timer = setTimeout(onEnd, milliseconds / SPEED_UP);
  return () => {
    clearTimeout(timer);
  };
};

let folder: string;
let removeFolder: () => Promise<void>;
let relayServer: RunningRelay;
let links = memoryLinks();
let documents = new Map<FakePage, DocumentId>();
let busyElsewhere = new Set<FakePage>();
let handlers: RelayHandlers;
let tasks: FileTask[];
let gate: { readonly held: Promise<undefined>; readonly open: () => void } | null = null;
let taskEnds: Promise<unknown>[] = [];
let taskThrows: Error | null = null;
let copied: string[];
let copyFails: Error | null;
let noted: [FakePage, string | null][];
let offered: { page: FakePage; name: string; relay: string }[];
let guideOpens: boolean;
const pages: FakePage[] = [];
const fakes: Server[] = [];

beforeEach(async () => {
  ({ folder, remove: removeFolder } = await temporaryFolder());
  relayServer = await startedRelay();
  links = memoryLinks();
  documents = new Map();
  busyElsewhere = new Set();
  tasks = [];
  gate = null;
  taskEnds = [];
  taskThrows = null;
  copied = [];
  copyFails = null;
  noted = [];
  offered = [];
  guideOpens = true;
  ipcMain.handlers.clear();
  handlers = registerRelayHandlers({
    assertTrusted: () => undefined,
    runTask: <T extends FileTask>(task: T) => {
      tasks.push(task);
      /** Runs the task once the gate of the test lets it, or fails as a worker that cannot start. */
      const run = async (): Promise<ResultOfTask<T>> => {
        await gate?.held;
        if (taskThrows !== null) {
          throw taskThrows;
        }
        return (await runFileTask(task)) as ResultOfTask<T>;
      };
      const ended = run();
      taskEnds.push(ended.catch(() => undefined));
      return ended;
    },
    links: links.store,
    documentOf: (sender) => documents.get(sender as unknown as FakePage) ?? null,
    busyElsewhere: (sender) => busyElsewhere.has(sender as unknown as FakePage),
    startTimer: fastTimer,
    offerRelayPlan: async (sender, plan, relay) => {
      await Promise.resolve();
      offered.push({ page: sender as unknown as FakePage, name: plan.name, relay });
      return {
        state: plan.state,
        documentId: plan.documentId,
        fileName: `${plan.name}.tasklace`,
        warnings: [],
        localChanges: null,
      };
    },
    noteRelay: async (sender, relay) => {
      noted.push([sender as unknown as FakePage, relay]);
      await Promise.resolve();
    },
    copyText: async (text) => {
      await Promise.resolve();
      if (copyFails !== null) {
        throw copyFails;
      }
      copied.push(text);
    },
    openGuide: async () => {
      await Promise.resolve();
      return guideOpens;
    },
  });
});

afterEach(async () => {
  pages.splice(0).forEach((page) => {
    handlers.leave(asSender(page));
  });
  await relayServer.close();
  await Promise.all(
    fakes.splice(0).map(
      (fake) =>
        new Promise((resolve) => {
          fake.closeAllConnections();
          fake.close(resolve);
        }),
    ),
  );
  vi.restoreAllMocks();
  await removeFolder();
});

/** Gives a fake page as the sender the main process sees. */
function asSender(page: FakePage): WebContents {
  return page as unknown as WebContents;
}

/** Opens a fake page, holding a plan when given one. */
function openPage(documentId: DocumentId | null = null): FakePage {
  const page = new FakePage();
  pages.push(page);
  if (documentId !== null) {
    documents.set(page, documentId);
  }
  return page;
}

/** Invokes a channel as a page would. */
async function invoke(page: FakePage, channel: string, ...values: unknown[]): Promise<unknown> {
  return await Promise.resolve(ipcMain.invoke(channel, { sender: page }, ...values));
}

/** Starts the relay of the test over TLS, keeping its rooms in the folder of the test. */
async function startedRelay(): Promise<RunningRelay> {
  return await startRelayServer({
    config: testConfig(folder, await writeRelayCertificate(folder)),
  });
}

/** Gives the address of the relay of the test. */
function relayAddress(port = relayServer.port): string {
  return `wss://127.0.0.1:${String(port)}/`;
}

/** Shares the plan of a page through the relay of the test, giving its two links as copied. */
async function shared(page: FakePage): Promise<{ editLink: string; viewLink: string }> {
  await invoke(page, IPC_CHANNELS.shareThroughRelay, relayAddress());
  return await copiedLinks(page);
}

/** Copies both links of the plan a page shares, giving them as the clipboard received them. */
async function copiedLinks(page: FakePage): Promise<{ editLink: string; viewLink: string }> {
  await invoke(page, IPC_CHANNELS.copyRelayLink, 'edit');
  await invoke(page, IPC_CHANNELS.copyRelayLink, 'view');
  const [editLink = '', viewLink = ''] = copied.splice(-2);
  return { editLink, viewLink };
}

/** Gives a link as a person sees it on screen. */
function shownOf(text: string): string {
  const link = readRelayLink(text);
  return link.ok ? shownRelayLink(link.value) : 'not a link';
}

/** Gives the relay of the test as the application shows it. */
function relayLabel(): string {
  return `127.0.0.1:${String(relayServer.port)}`;
}

/** Sends a message of the plan from a page to the relay, as its member would. */
function sendPlan(
  page: FakePage,
  bytes: Uint8Array = encodeMessage({ kind: 'update', update: PLAN_STATE }),
): void {
  ipcMain.send(
    IPC_CHANNELS.relaySend,
    { sender: page },
    {
      kind: 'message',
      message: { kind: 'snapshot', messageId: new Uint8Array(16).fill(7), covers: 0, bytes },
    },
  );
}

/** Shares a plan from a page and puts its state on the relay, waiting until the relay kept it. */
async function sharedWithPlan(): Promise<{ owner: FakePage; editLink: string; viewLink: string }> {
  const owner = openPage(TEST_DOCUMENT_ID);
  const created = await shared(owner);
  await until(() => owner.kinds().includes('relayCaughtUp'));
  sendPlan(owner);
  await until(() => owner.kinds().includes('relayDelivery'));
  return { owner, ...created };
}

/** Gives the member, bytes as a plain list and right of a presence event, or null for another event. */
function presenceOf(event: CollaborationEvent | undefined) {
  return event?.kind === 'relayPresence'
    ? { member: event.member, bytes: [...event.presence.bytes], canEdit: event.presence.canEdit }
    : null;
}

/** Holds every task of the worker until the test opens the gate. */
function closeGate(): () => void {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  gate = {
    held: promise,
    open: () => {
      resolve(undefined);
    },
  };
  return () => {
    resolve(undefined);
  };
}

/** Starts a relay of its own over TLS that lets a member in and never says it caught up. */
async function silentRelay(): Promise<number> {
  const port = await freePort();
  const server = createHttpsServer({
    cert: TEST_CERTIFICATE.certificate,
    key: TEST_CERTIFICATE.key,
  });
  new WebSocketServer({ server });
  fakes.push(server);
  await new Promise((resolve) =>
    server.listen(port, LOOPBACK, () => {
      resolve(undefined);
    }),
  );
  return port;
}

describe('sharing a plan through a relay', () => {
  it('creates a room for the plan of a window, gives both links and keeps the one that edits', async () => {
    const owner = openPage(TEST_DOCUMENT_ID);
    const answer = await invoke(owner, IPC_CHANNELS.shareThroughRelay, relayAddress());
    await until(() => owner.kinds().includes('relayCaughtUp'));
    const { editLink, viewLink } = await copiedLinks(owner);
    const edit = readRelayLink(editLink);
    const view = readRelayLink(viewLink);
    expect([
      answer,
      edit.ok && edit.value.access.kind,
      view.ok && view.value.access.kind,
      links.kept.get(TEST_DOCUMENT_ID),
      noted,
      owner.events.slice(0, 2),
      handlers.isSharing(asSender(owner)),
    ]).toEqual([
      {
        ok: true,
        value: {
          shown: { edit: shownOf(editLink), view: shownOf(viewLink) },
          relay: relayLabel(),
          kept: true,
        },
      },
      'edit',
      'view',
      editLink,
      [[owner, relayLabel()]],
      [{ kind: 'relayConnected', member: 1, members: [] }, { kind: 'relayCaughtUp' }],
      true,
    ]);
  });

  it('still shares when the link cannot be kept, telling it was not', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    links.state.vault = false;
    const withoutVault = await invoke(
      openPage(TEST_DOCUMENT_ID),
      IPC_CHANNELS.shareThroughRelay,
      relayAddress(),
    );
    links.state.vault = true;
    links.state.keepThrows = true;
    links.state.thrown = new Error('Encryption is not available.');
    const failing = await invoke(
      openPage(OTHER_PLAN),
      IPC_CHANNELS.shareThroughRelay,
      relayAddress(),
    );
    expect([
      Reflect.get(Object(Reflect.get(Object(withoutVault), 'value')), 'kept'),
      Reflect.get(Object(Reflect.get(Object(failing), 'value')), 'kept'),
      error.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([false, false, ['The link of a shared plan could not be kept:']]);
  });

  it('refuses an address that is not one or not secure, a window holding no plan or already sharing it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = openPage(TEST_DOCUMENT_ID);
    await shared(owner);
    const elsewhere = openPage(OTHER_PLAN);
    busyElsewhere.add(elsewhere);
    expect([
      await invoke(openPage(TEST_DOCUMENT_ID), IPC_CHANNELS.shareThroughRelay, 'not an address'),
      await invoke(
        openPage(TEST_DOCUMENT_ID),
        IPC_CHANNELS.shareThroughRelay,
        relayAddress().replace('wss://', 'ws://'),
      ),
      await invoke(openPage(), IPC_CHANNELS.shareThroughRelay, relayAddress()),
      await invoke(owner, IPC_CHANNELS.shareThroughRelay, relayAddress()),
      await invoke(elsewhere, IPC_CHANNELS.shareThroughRelay, relayAddress()),
      error.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([
      { ok: false, error: { code: 'INVALID_ADDRESS' } },
      { ok: false, error: { code: 'NOT_SECURE' } },
      { ok: false, error: { code: 'TASK_FAILED' } },
      { ok: false, error: { code: 'ALREADY_SHARING' } },
      { ok: false, error: { code: 'ALREADY_SHARING' } },
      ['A page shared a plan through a relay without holding one.'],
    ]);
    await expect(invoke(openPage(), IPC_CHANNELS.shareThroughRelay, 3)).rejects.toThrow(
      'its content is not valid.',
    );
  });

  it('tells why the relay refused to create the room', async () => {
    const port = await freePort();
    const answer = await invoke(
      openPage(TEST_DOCUMENT_ID),
      IPC_CHANNELS.shareThroughRelay,
      relayAddress(port),
    );
    expect(answer).toEqual({ ok: false, error: { code: 'RELAY_ENDED', reason: 'UNREACHABLE' } });
  });
});

describe('joining a plan by its link', () => {
  it('opens the plan the log of the relay holds, checked by the worker, and keeps the link under it', async () => {
    const { owner, viewLink } = await sharedWithPlan();
    const guest = openPage();
    const answer = await invoke(guest, IPC_CHANNELS.joinByLink, viewLink);
    await until(() => owner.kinds().includes('relayJoined'));
    expect([
      answer,
      offered,
      links.kept.get(TEST_DOCUMENT_ID) === viewLink,
      tasks.map((task) => task.kind),
      guest.kinds().slice(0, 1),
    ]).toEqual([
      {
        ok: true,
        value: {
          project: {
            state: PLAN_STATE,
            documentId: TEST_DOCUMENT_ID,
            fileName: 'Test project.tasklace',
            warnings: [],
            localChanges: null,
          },
          shown: { edit: null, view: shownOf(viewLink) },
          relay: relayLabel(),
          bytesSinceSnapshot: 0,
          kept: true,
        },
      },
      [{ page: guest, name: 'Test project', relay: relayLabel() }],
      true,
      ['readRelayLog'],
      ['relayConnected'],
    ]);
  });

  it('counts the bytes of the changes the relay kept since its last snapshot', async () => {
    const { viewLink, owner } = await sharedWithPlan();
    const change = encodeMessage({ kind: 'update', update: PLAN_STATE });
    ipcMain.send(
      IPC_CHANNELS.relaySend,
      { sender: owner },
      {
        kind: 'message',
        message: {
          kind: 'update',
          messageId: new Uint8Array(16).fill(8),
          covers: 0,
          bytes: change,
        },
      },
    );
    await until(() => owner.kinds().filter((kind) => kind === 'relayDelivery').length === 2);
    const answer = await invoke(openPage(), IPC_CHANNELS.joinByLink, viewLink);
    expect(Reflect.get(Object(Reflect.get(Object(answer), 'value')), 'bytesSinceSnapshot')).toBe(
      zlibCompressor.compress(change).length + AEAD_TAG_BYTES,
    );
  });

  it('ends a join whose window leaves while the worker checks the plan', async () => {
    const { viewLink } = await sharedWithPlan();
    const open = closeGate();
    const guest = openPage();
    const joining = invoke(guest, IPC_CHANNELS.joinByLink, viewLink);
    await until(() => tasks.length === 1);
    handlers.leave(asSender(guest));
    open();
    expect(await joining).toEqual({ ok: false, error: { code: 'CANCELLED' } });
  });

  it('refuses a text that is not a link, a room that is not there and a window already sharing', async () => {
    const { owner, editLink } = await sharedWithPlan();
    const busy = openPage();
    busyElsewhere.add(busy);
    const gone = editLink.replace(/#e1\.[A-Za-z0-9_-]+$/, '#e1.' + 'A'.repeat(86));
    expect([
      await invoke(openPage(), IPC_CHANNELS.joinByLink, 'https://example.org'),
      await invoke(openPage(), IPC_CHANNELS.joinByLink, gone),
      await invoke(owner, IPC_CHANNELS.joinByLink, editLink),
      await invoke(busy, IPC_CHANNELS.joinByLink, editLink),
    ]).toEqual([
      { ok: false, error: { code: 'INVALID_LINK' } },
      { ok: false, error: { code: 'RELAY_ENDED', reason: 'NO_ROOM' } },
      { ok: false, error: { code: 'ALREADY_SHARING' } },
      { ok: false, error: { code: 'ALREADY_SHARING' } },
    ]);
    await expect(invoke(openPage(), IPC_CHANNELS.joinByLink, 3)).rejects.toThrow(
      'its content is not valid.',
    );
  });

  it('refuses a log that is not a plan and lets the window go', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const owner = openPage(TEST_DOCUMENT_ID);
    const { editLink } = await shared(owner);
    await until(() => owner.kinds().includes('relayCaughtUp'));
    sendPlan(owner, encodeMessage({ kind: 'stateVector', vector: new Uint8Array(1) }));
    await until(() => owner.kinds().includes('relayDelivery'));
    const guest = openPage();
    expect([
      await invoke(guest, IPC_CHANNELS.joinByLink, editLink),
      handlers.isSharing(asSender(guest)),
    ]).toEqual([{ ok: false, error: { code: 'INVALID_CONTENT' } }, false]);
  });

  it('ends a join still waiting once the window leaves', async () => {
    const port = await silentRelay();
    const { editLink } = await sharedWithPlan();
    const link = readRelayLink(editLink);
    const elsewhere = link.ok
      ? encodeRelayLink({ ...link.value, address: { ...link.value.address, port } })
      : '';
    const guest = openPage();
    const joining = invoke(guest, IPC_CHANNELS.joinByLink, elsewhere);
    await until(() => handlers.isSharing(asSender(guest)));
    handlers.leave(asSender(guest));
    expect(await joining).toEqual({ ok: false, error: { code: 'CANCELLED' } });
  });
});

describe('reopening a plan shared through a relay', () => {
  it('reads the log again from the start and hands the page the state it holds before anything after it', async () => {
    const { owner, editLink, viewLink } = await sharedWithPlan();
    handlers.leave(asSender(owner));
    const again = openPage(TEST_DOCUMENT_ID);
    const answer = await invoke(again, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID);
    await until(() => again.kinds().includes('relayCaughtUp'));
    const stateEvent = again.events.find((event) => event.kind === 'relayState');
    expect([
      answer,
      links.kept.get(TEST_DOCUMENT_ID) === editLink,
      noted.at(-1),
      again.kinds(),
      stateEvent?.kind === 'relayState' && stateEvent.state !== null,
    ]).toEqual([
      {
        ok: true,
        value: {
          shown: { edit: shownOf(editLink), view: shownOf(viewLink) },
          relay: relayLabel(),
        },
      },
      true,
      [again, relayLabel()],
      ['relayConnected', 'relayState', 'relayCaughtUp'],
      true,
    ]);
  });

  it('holds what comes while the worker checks the state, handing it after the state', async () => {
    const { owner, viewLink } = await sharedWithPlan();
    handlers.leave(asSender(owner));
    const guest = openPage();
    await invoke(guest, IPC_CHANNELS.joinByLink, viewLink);
    const witness = openPage();
    await invoke(witness, IPC_CHANNELS.joinByLink, viewLink);
    const open = closeGate();
    const again = openPage(TEST_DOCUMENT_ID);
    await invoke(again, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID);
    await until(() => tasks.length === 3);
    ipcMain.send(
      IPC_CHANNELS.relaySend,
      { sender: guest },
      { kind: 'presence', bytes: Uint8Array.of(4) },
    );
    await until(() => witness.kinds().includes('relayPresence'));
    const beforeState = again.kinds();
    open();
    await until(() => again.kinds().includes('relayPresence'));
    expect([beforeState, again.kinds(), presenceOf(again.events.at(-1))]).toEqual([
      ['relayConnected'],
      ['relayConnected', 'relayState', 'relayCaughtUp', 'relayPresence'],
      { member: 1, bytes: [4], canEdit: false },
    ]);
  });

  it('hands nothing once the window left while the worker checked the state', async () => {
    const { owner } = await sharedWithPlan();
    handlers.leave(asSender(owner));
    const open = closeGate();
    const again = openPage(TEST_DOCUMENT_ID);
    await invoke(again, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID);
    await until(() => tasks.length === 1);
    handlers.leave(asSender(again));
    open();
    await Promise.all(taskEnds);
    expect(again.kinds()).toEqual(['relayConnected']);
  });

  it('ends a reopened plan whose state the worker could not check, handing what it held, and logs why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { owner } = await sharedWithPlan();
    handlers.leave(asSender(owner));
    taskThrows = new Error('The worker could not start.');
    const again = openPage(TEST_DOCUMENT_ID);
    await invoke(again, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID);
    await until(() => again.kinds().includes('relayEnded'));
    expect([
      again.kinds(),
      handlers.isSharing(asSender(again)),
      error.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([
      ['relayConnected', 'relayEnded'],
      false,
      ['The plan could not come back to its relay:'],
    ]);
  });

  it('ends a reopened plan and refuses a join whose log cannot be read, logging why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { owner, viewLink } = await sharedWithPlan();
    sendPlan(owner, Uint8Array.of(9));
    await until(() => owner.kinds().filter((kind) => kind === 'relayDelivery').length === 2);
    handlers.leave(asSender(owner));
    const again = openPage(TEST_DOCUMENT_ID);
    await invoke(again, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID);
    await until(() => again.kinds().includes('relayEnded'));
    const joined = await invoke(openPage(), IPC_CHANNELS.joinByLink, viewLink);
    expect([again.events.at(-1), joined, error.mock.calls]).toEqual([
      { kind: 'relayEnded', reason: 'MALFORMED' },
      { ok: false, error: { code: 'INVALID_CONTENT' } },
      [
        ['The log the relay gave for the reopened plan could not be read: INVALID_CONTENT.'],
        ['The log of the plan a link joined could not be read: INVALID_CONTENT.'],
      ],
    ]);
  });

  it('hands an empty state for a room nothing was put in yet', async () => {
    const owner = openPage(TEST_DOCUMENT_ID);
    await shared(owner);
    await until(() => owner.kinds().includes('relayCaughtUp'));
    handlers.leave(asSender(owner));
    const again = openPage(TEST_DOCUMENT_ID);
    await invoke(again, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID);
    await until(() => again.kinds().includes('relayCaughtUp'));
    expect(again.events.find((event) => event.kind === 'relayState')).toEqual({
      kind: 'relayState',
      state: null,
      bytesSinceSnapshot: 0,
    });
  });

  it('ends a plan whose relay holds the log of another plan', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { owner, editLink } = await sharedWithPlan();
    handlers.leave(asSender(owner));
    const link = readRelayLink(editLink);
    links.kept.set(OTHER_PLAN, link.ok ? encodeRelayLink(link.value) : '');
    const other = openPage(OTHER_PLAN);
    await invoke(other, IPC_CHANNELS.reopenSharedPlan, OTHER_PLAN);
    await until(() => other.kinds().includes('relayEnded'));
    expect([
      other.events.at(-1),
      handlers.isSharing(asSender(other)),
      error.mock.calls.at(-1),
    ]).toEqual([
      { kind: 'relayEnded', reason: 'MALFORMED' },
      false,
      ['The relay gave a log that is not the log of the reopened plan.'],
    ]);
  });

  it('answers nothing for a plan without a kept link, clearing its relay among the recent projects, and refuses a plan the window does not hold, a kept link it cannot open or an unreadable store, keeping its relay', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const page = openPage(TEST_DOCUMENT_ID);
    const withoutLink = await invoke(page, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID);
    const clearedRelay = noted.splice(0);
    const notHeld = await invoke(page, IPC_CHANNELS.reopenSharedPlan, OTHER_PLAN);
    links.state.linkUnreadable = true;
    const notOpened = await invoke(page, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID);
    links.state.linkUnreadable = false;
    links.state.findFails = Object.assign(new Error('Input/output error'), { code: 'EIO' });
    const unreadable = await invoke(page, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID);
    expect([
      withoutLink,
      clearedRelay,
      notHeld,
      notOpened,
      unreadable,
      noted,
      error.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([
      { ok: true, value: null },
      [[page, null]],
      { ok: false, error: { code: 'TASK_FAILED' } },
      { ok: false, error: { code: 'LINK_UNREADABLE' } },
      { ok: false, error: { code: 'READ_FAILED' } },
      [],
      [
        'A page reopened a shared plan it does not hold.',
        'The plan could not come back to its relay: LINK_UNREADABLE.',
        'The links of shared plans could not be read:',
        'The plan could not come back to its relay: READ_FAILED.',
      ],
    ]);
    await expect(invoke(page, IPC_CHANNELS.reopenSharedPlan, 'not an identifier')).rejects.toThrow(
      'its content is not valid.',
    );
    links.state.findFails = new Error('broken');
    await expect(invoke(page, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID)).rejects.toThrow(
      'broken',
    );
  });

  it('refuses to reopen a plan the window already shares another way', async () => {
    const { owner, editLink } = await sharedWithPlan();
    handlers.leave(asSender(owner));
    links.kept.set(TEST_DOCUMENT_ID, editLink);
    const page = openPage(TEST_DOCUMENT_ID);
    busyElsewhere.add(page);
    expect(await invoke(page, IPC_CHANNELS.reopenSharedPlan, TEST_DOCUMENT_ID)).toEqual({
      ok: false,
      error: { code: 'ALREADY_SHARING' },
    });
  });

  it('keeps trying a relay that cannot be reached yet, telling the page', async () => {
    const port = await freePort();
    const { editLink } = await sharedWithPlan();
    const link = readRelayLink(editLink);
    links.kept.set(
      OTHER_PLAN,
      link.ok ? encodeRelayLink({ ...link.value, address: { ...link.value.address, port } }) : '',
    );
    const page = openPage(OTHER_PLAN);
    await invoke(page, IPC_CHANNELS.reopenSharedPlan, OTHER_PLAN);
    await until(() => page.kinds().includes('offline'));
    expect(page.kinds()).toEqual(['reconnecting', 'offline']);
  });
});

describe('the links of a plan shared through a relay', () => {
  it('makes new links: the old room is closed for everyone in it and the new link that edits is kept', async () => {
    const { owner, editLink, viewLink } = await sharedWithPlan();
    const guest = openPage();
    await invoke(guest, IPC_CHANNELS.joinByLink, viewLink);
    const answer = await invoke(owner, IPC_CHANNELS.makeNewLinks);
    await until(() => guest.kinds().includes('relayEnded'));
    const fresh = await copiedLinks(owner);
    expect([
      answer,
      fresh.editLink !== editLink,
      links.kept.get(TEST_DOCUMENT_ID) === fresh.editLink,
      guest.events.at(-1),
      handlers.isSharing(asSender(owner)),
    ]).toEqual([
      {
        ok: true,
        value: {
          shown: { edit: shownOf(fresh.editLink), view: shownOf(fresh.viewLink) },
          relay: relayLabel(),
          kept: true,
        },
      },
      true,
      true,
      { kind: 'relayEnded', reason: 'CLOSED' },
      true,
    ]);
  });

  it('refuses new links to a window that does not share with the link that edits, or is not connected', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { owner, viewLink } = await sharedWithPlan();
    const guest = openPage();
    await invoke(guest, IPC_CHANNELS.joinByLink, viewLink);
    await relayServer.close();
    await until(() => owner.kinds().includes('reconnecting'));
    relayServer = await startedRelay();
    expect([
      await invoke(guest, IPC_CHANNELS.makeNewLinks),
      await invoke(owner, IPC_CHANNELS.makeNewLinks),
      error.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([
      { ok: false, error: { code: 'TASK_FAILED' } },
      { ok: false, error: { code: 'NOT_CONNECTED' } },
      [
        'A page asked for new links of a plan it does not share with the link that edits.',
        'The room of a plan could not be closed for new links: NOT_OPEN.',
      ],
    ]);
  });

  it('keeps the link of a plan when the window leaves it or the relay no longer finds its room, until the page forgets it', async () => {
    const { owner, editLink } = await sharedWithPlan();
    handlers.leave(asSender(owner));
    const keptAfterLeaving = links.kept.get(TEST_DOCUMENT_ID) === editLink;
    const gone = editLink.replace(/#e1\.[A-Za-z0-9_-]+$/, '#e1.' + 'A'.repeat(86));
    const goneLink = readRelayLink(gone);
    links.kept.set(OTHER_PLAN, goneLink.ok ? encodeRelayLink(goneLink.value) : '');
    const page = openPage(OTHER_PLAN);
    await invoke(page, IPC_CHANNELS.reopenSharedPlan, OTHER_PLAN);
    await until(() => page.kinds().includes('relayEnded'));
    const keptWhenGone = links.kept.has(OTHER_PLAN);
    const notedWhenGone = noted.at(-1);
    const forgotten = await invoke(page, IPC_CHANNELS.forgetSharedPlan);
    expect([
      keptAfterLeaving,
      page.events.at(-1),
      keptWhenGone,
      notedWhenGone,
      forgotten,
      links.kept.has(OTHER_PLAN),
      noted.at(-1),
      handlers.isSharing(asSender(owner)),
    ]).toEqual([
      true,
      { kind: 'relayEnded', reason: 'NO_ROOM' },
      true,
      [page, relayLabel()],
      { ok: true, value: null },
      false,
      [page, null],
      false,
    ]);
  });

  it('forgets the link of a plan for the other members once its owner closed its room for new links', async () => {
    const { owner, viewLink } = await sharedWithPlan();
    const guest = openPage();
    await invoke(guest, IPC_CHANNELS.joinByLink, viewLink);
    const made = await invoke(owner, IPC_CHANNELS.makeNewLinks);
    await until(() => guest.kinds().includes('relayEnded'));
    await until(() => noted.some(([page, relay]) => page === guest && relay === null));
    expect([
      Reflect.get(Object(made), 'ok'),
      guest.events.at(-1),
      owner.kinds().includes('relayEnded'),
    ]).toEqual([true, { kind: 'relayEnded', reason: 'CLOSED' }, false]);
  });

  it('refuses to forget a plan a page does not hold or still follows through its relay', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { owner } = await sharedWithPlan();
    expect([
      await invoke(openPage(null), IPC_CHANNELS.forgetSharedPlan),
      await invoke(owner, IPC_CHANNELS.forgetSharedPlan),
      error.mock.calls.map(([message]: unknown[]) => message),
    ]).toEqual([
      { ok: false, error: { code: 'TASK_FAILED' } },
      { ok: false, error: { code: 'TASK_FAILED' } },
      [
        'A page asked to forget a shared plan it does not hold or still follows.',
        'A page asked to forget a shared plan it does not hold or still follows.',
      ],
    ]);
  });
});

describe('copying a link and opening the guide', () => {
  it('copies the whole link that edits and the link that reads of the plan a window shares, which join the same plan', async () => {
    const { editLink, viewLink } = await sharedWithPlan();
    const edit = readRelayLink(editLink);
    const view = readRelayLink(viewLink);
    expect([
      editLink.startsWith(`tasklace://${relayLabel()}/#e1.`),
      viewLink.startsWith(`tasklace://${relayLabel()}/#v1.`),
      edit.ok && view.ok && view.value.access.readKey.join() === edit.value.access.readKey.join(),
    ]).toEqual([true, true, true]);
  });

  it('copies only the link that reads for a window that joined with it, and nothing for a window sharing nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { viewLink } = await sharedWithPlan();
    const guest = openPage();
    await invoke(guest, IPC_CHANNELS.joinByLink, viewLink);
    expect([
      await invoke(guest, IPC_CHANNELS.copyRelayLink, 'edit'),
      await invoke(guest, IPC_CHANNELS.copyRelayLink, 'view'),
      await invoke(openPage(), IPC_CHANNELS.copyRelayLink, 'view'),
      copied,
      error.mock.calls,
    ]).toEqual([
      { ok: false, error: { code: 'TASK_FAILED' } },
      { ok: true, value: null },
      { ok: false, error: { code: 'TASK_FAILED' } },
      [viewLink],
      [
        ['A page asked to copy a link of a plan it does not share with that link.'],
        ['A page asked to copy a link of a plan it does not share with that link.'],
      ],
    ]);
  });

  it('refuses a kind of link that is not one', async () => {
    const owner = openPage(TEST_DOCUMENT_ID);
    await shared(owner);
    await expect(invoke(owner, IPC_CHANNELS.copyRelayLink, 'secret')).rejects.toThrow(
      'Request refused',
    );
  });

  it('tells a link that the clipboard did not take, logging why', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const owner = openPage(TEST_DOCUMENT_ID);
    await shared(owner);
    const refusal = new Error('The clipboard is busy.');
    copyFails = refusal;
    expect([await invoke(owner, IPC_CHANNELS.copyRelayLink, 'edit'), error.mock.calls]).toEqual([
      { ok: false, error: { code: 'TASK_FAILED' } },
      [['The link of a shared plan could not be copied:', refusal]],
    ]);
  });

  it('opens the guide to set up a relay, telling when the browser could not', async () => {
    const page = openPage();
    const opened = await invoke(page, IPC_CHANNELS.openGuide);
    guideOpens = false;
    expect([opened, await invoke(page, IPC_CHANNELS.openGuide)]).toEqual([
      { ok: true, value: null },
      { ok: false, error: { code: 'TASK_FAILED' } },
    ]);
  });
});

describe('keeping and forgetting links, when the store fails', () => {
  it('logs a link that cannot be forgotten once the page forgets its plan', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { editLink } = await sharedWithPlan();
    const gone = readRelayLink(editLink.replace(/#e1\.[A-Za-z0-9_-]+$/, '#e1.' + 'A'.repeat(86)));
    links.kept.set(OTHER_PLAN, gone.ok ? encodeRelayLink(gone.value) : '');
    links.state.forgetFails = new Error('Input/output error');
    const page = openPage(OTHER_PLAN);
    await invoke(page, IPC_CHANNELS.reopenSharedPlan, OTHER_PLAN);
    await until(() => page.kinds().includes('relayEnded'));
    await invoke(page, IPC_CHANNELS.forgetSharedPlan);
    expect(error.mock.calls.map(([message]: unknown[]) => message)).toEqual([
      'The link of a shared plan could not be forgotten:',
    ]);
  });

  it('ends a join whose relay sends more before it caught up than any plan holds', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { owner, viewLink } = await sharedWithPlan();
    for (let count = 0; count < 3; count += 1) {
      sendPlan(owner, encodeMessage({ kind: 'update', update: systemRandomBytes(NOISE_BYTES) }));
    }
    await until(() => owner.kinds().filter((kind) => kind === 'relayDelivery').length === 4);
    const joined = await invoke(openPage(), IPC_CHANNELS.joinByLink, viewLink);
    expect([joined, error.mock.calls]).toEqual([
      { ok: false, error: { code: 'RELAY_ENDED', reason: 'TOO_LARGE' } },
      [['The relay gave a log larger than any plan.']],
    ]);
  });

  it('passes on a value thrown while keeping a link that is not an error', async () => {
    links.state.keepThrows = true;
    links.state.thrown = 'not an error';
    await expect(
      invoke(openPage(TEST_DOCUMENT_ID), IPC_CHANNELS.shareThroughRelay, relayAddress()),
    ).rejects.toBe('not an error');
  });

  it('passes the presence of a member to the others', async () => {
    const { owner, viewLink } = await sharedWithPlan();
    const guest = openPage();
    await invoke(guest, IPC_CHANNELS.joinByLink, viewLink);
    ipcMain.send(
      IPC_CHANNELS.relaySend,
      { sender: owner },
      { kind: 'presence', bytes: Uint8Array.of(6) },
    );
    await until(() => guest.kinds().includes('relayPresence'));
    expect(presenceOf(guest.events.at(-1))).toEqual({ member: 1, bytes: [6], canEdit: true });
  });
});

describe('what a page sends a relay', () => {
  it('passes a change of the plan on, and logs one it cannot send or that has no relay to go to', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { viewLink } = await sharedWithPlan();
    const guest = openPage();
    await invoke(guest, IPC_CHANNELS.joinByLink, viewLink);
    sendPlan(guest);
    sendPlan(openPage());
    ipcMain.send(IPC_CHANNELS.relaySend, { sender: guest }, { kind: 'nothing' });
    expect([warn.mock.calls, error.mock.calls]).toEqual([
      [['A message of the shared plan could not be sent to the relay: READ_ONLY.']],
      [
        ['The page sent a message of a plan shared through a relay that cannot be sent.'],
        ['The page sent a message of a plan shared through a relay that cannot be sent.'],
      ],
    ]);
  });

  it.each([
    ['a presence', { kind: 'presence', bytes: Uint8Array.of(1) }, true],
    [
      'a change',
      {
        kind: 'message',
        message: {
          kind: 'update',
          messageId: new Uint8Array(16),
          covers: 0,
          bytes: Uint8Array.of(1),
        },
      },
      true,
    ],
    [
      'a snapshot',
      {
        kind: 'message',
        message: {
          kind: 'snapshot',
          messageId: new Uint8Array(16),
          covers: 9,
          bytes: Uint8Array.of(1),
        },
      },
      true,
    ],
    [
      'a change covering a sequence, which only a snapshot does',
      {
        kind: 'message',
        message: {
          kind: 'update',
          messageId: new Uint8Array(16),
          covers: 1,
          bytes: Uint8Array.of(1),
        },
      },
      false,
    ],
    ['a presence without bytes', { kind: 'presence', bytes: 'text' }, false],
    [
      'a message of another kind',
      {
        kind: 'message',
        message: {
          kind: 'other',
          messageId: new Uint8Array(16),
          covers: 0,
          bytes: Uint8Array.of(1),
        },
      },
      false,
    ],
    [
      'an identifier of another length',
      {
        kind: 'message',
        message: {
          kind: 'update',
          messageId: new Uint8Array(8),
          covers: 0,
          bytes: Uint8Array.of(1),
        },
      },
      false,
    ],
    [
      'a negative sequence',
      {
        kind: 'message',
        message: {
          kind: 'update',
          messageId: new Uint8Array(16),
          covers: -1,
          bytes: Uint8Array.of(1),
        },
      },
      false,
    ],
    ['nothing', null, false],
  ])('reads %s', (_name, value, valid) => {
    expect(readRelayOutgoing(value) === null).toBe(!valid);
  });

  it('reads a message as its kind, identifier, sequence and bytes', () => {
    const messageId = new Uint8Array(16).fill(3);
    expect(
      readRelayOutgoing({
        kind: 'message',
        message: { kind: 'snapshot', messageId, covers: 4, bytes: Uint8Array.of(5), more: true },
      }),
    ).toEqual({
      kind: 'message',
      message: { kind: 'snapshot', messageId, covers: 4, bytes: Uint8Array.of(5) },
    });
  });
});

describe('a page that is gone', () => {
  it('is told nothing more', async () => {
    const owner = openPage(TEST_DOCUMENT_ID);
    owner.destroyed = true;
    await invoke(owner, IPC_CHANNELS.shareThroughRelay, relayAddress());
    expect(owner.events).toEqual([]);
  });
});
