import { testDigest, testJoinCode } from '../../../core/testing/secrets';
import * as Y from 'yjs';
import type { Project } from '../../../core/model/project';
import type { PrintDocument } from '../../../core/print/print-document';
import { scheduleProject } from '../../../core/scheduling/schedule-project';
import {
  createSharedDocument,
  requireDocumentId,
  type DocumentId,
} from '../../../core/shared/shared-document';
import { TEST_DOCUMENT_ID, testId } from '../../../core/testing/project-builder';
import type {
  BridgeResult,
  CollaborationEvent,
  CollaborationSettings,
  CollaborationTarget,
  ExchangeKind,
  ExportedFile,
  OpenedProject,
  RecentProject,
  RelayJoined,
  RelayLinks,
  RelayReopened,
  SavedProject,
  Sharing,
  TasklaceBridge,
  PdfExport,
} from '../../../preload/bridge-contract';
import type { RelayOutgoing } from '../../../core/collaboration/relay/relay-member';
import english from '../../locales/en.json';
import type { Scheduler, ScheduleListener } from '../../schedule/scheduler';
import { SAND_GRAPHITE } from '../../theme/sand-graphite';
import { AppState, type AppContext } from '../app-state.svelte';

export const OPENED_DOCUMENT_ID = requireDocumentId('22222222-2222-4222-8222-222222222222');
export const FRENCH_FORMAT = {
  listSeparator: ';',
  dateOrder: 'dayMonthYear',
  dateSeparator: '/',
  twelveHourClock: false,
} as const;
export const FIXED_NOW = new Date(2026, 8, 28, 10);

const SAVED: BridgeResult<SavedProject> = { ok: true, value: { localCopySaved: true } };
const NOT_ANSWERED: BridgeResult<never> = { ok: false, error: { code: 'TASK_FAILED' } };

export interface FakeBridgeControl {
  openResult: BridgeResult<OpenedProject>;
  saveResult: BridgeResult<SavedProject> | Error;
  saveAsResult: BridgeResult<SavedProject>;
  exportResult: BridgeResult<ExportedFile>;
  pdfResult: BridgeResult<PdfExport>;
  heldPdfResult: BridgeResult<ExportedFile>;
  discardResult: BridgeResult<null>;
  setAsideResult: BridgeResult<null>;
  adoptResult: BridgeResult<null>;
  recent: readonly RecentProject[] | Error | 'unreadable';
  newDocumentId: string;
  readonly calls: string[];
  readonly adopted: string[];
  readonly saved: { readonly as: boolean; readonly name: string | null }[];
  readonly openedRecent: number[];
  readonly imports: ExchangeKind[];
  readonly exports: { readonly kind: ExchangeKind; readonly text: string; readonly name: string }[];
  readonly pdfExports: { readonly document: PrintDocument; readonly name: string }[];
  readonly setAside: DocumentId[];
  readonly collaboration: FakeCollaboration;
}

export interface FakeCollaboration {
  settingsResult: BridgeResult<CollaborationSettings>;
  saveSettingsResult: BridgeResult<null>;
  shareResult: BridgeResult<Sharing>;
  joinResult: BridgeResult<null>;
  stopResult: BridgeResult<null>;
  findPlansResult: BridgeResult<null>;
  openSharedResult: BridgeResult<OpenedProject>;
  copyResult: BridgeResult<null>;
  findNextHostResult: BridgeResult<null>;
  allowResult: BridgeResult<null>;
  dropResult: BridgeResult<null>;
  forgetResult: BridgeResult<null>;
  keepResult: BridgeResult<SavedProject>;
  openKeptResult: BridgeResult<OpenedProject>;
  listener: ((event: CollaborationEvent) => void) | null;
  readonly requests: (readonly [string, ...unknown[]])[];
  readonly sent: (readonly [CollaborationTarget, Uint8Array])[];
  readonly relay: FakeRelay;
}

export interface FakeRelay {
  shareResult: BridgeResult<RelayLinks>;
  joinResult: BridgeResult<RelayJoined>;
  reopenResult: BridgeResult<RelayReopened | null>;
  newLinksResult: BridgeResult<RelayLinks>;
  copyLinkResult: BridgeResult<null>;
  guideResult: BridgeResult<null>;
  readonly requests: (readonly [string, ...unknown[]])[];
  readonly sent: RelayOutgoing[];
}

export interface ManualScheduler {
  readonly listener: () => ScheduleListener;
  readonly requests: Project[];
  automatic: boolean;
}

/** Describes a project as the main process gives it when a file is opened. */
export function openedProjectOf(
  project: Project,
  overrides: Partial<OpenedProject> = {},
): BridgeResult<OpenedProject> {
  const state = Y.encodeStateAsUpdate(createSharedDocument(project, OPENED_DOCUMENT_ID));
  return {
    ok: true,
    value: {
      state,
      documentId: OPENED_DOCUMENT_ID,
      fileName: `${project.name}.tasklace`,
      warnings: [],
      localChanges: null,
      ...overrides,
    },
  };
}

/** Builds a bridge to a fake main process whose answers a test controls, recording the requests it receives. */
export function fakeBridge(): {
  readonly bridge: TasklaceBridge;
  readonly control: FakeBridgeControl;
} {
  const control: FakeBridgeControl = {
    openResult: { ok: false, error: { code: 'CANCELLED' } },
    saveResult: SAVED,
    saveAsResult: SAVED,
    exportResult: { ok: true, value: { fileName: 'plan.json' } },
    pdfResult: { ok: true, value: { kind: 'exported', fileName: 'Thesis.pdf' } },
    heldPdfResult: { ok: true, value: { fileName: 'Thesis.pdf' } },
    discardResult: { ok: true, value: null },
    setAsideResult: { ok: true, value: null },
    adoptResult: { ok: true, value: null },
    recent: [],
    newDocumentId: TEST_DOCUMENT_ID,
    calls: [],
    adopted: [],
    saved: [],
    openedRecent: [],
    imports: [],
    exports: [],
    pdfExports: [],
    setAside: [],
    collaboration: {
      settingsResult: {
        ok: true,
        value: { name: null, port: 47_313, firewallNoticeSeen: false, relayAddress: null },
      },
      saveSettingsResult: { ok: true, value: null },
      shareResult: {
        ok: true,
        value: {
          code: testJoinCode('K7Q4MZ'),
          port: 47_313,
          addresses: ['192.168.1.24'],
          tokenDigest: testDigest('d'.repeat(64)),
        },
      },
      joinResult: { ok: true, value: null },
      stopResult: { ok: true, value: null },
      findPlansResult: { ok: true, value: null },
      openSharedResult: { ok: false, error: { code: 'TASK_FAILED' } },
      copyResult: { ok: true, value: null },
      findNextHostResult: { ok: true, value: null },
      allowResult: { ok: true, value: null },
      dropResult: { ok: true, value: null },
      forgetResult: { ok: true, value: null },
      keepResult: { ok: true, value: { localCopySaved: true } },
      openKeptResult: { ok: false, error: { code: 'CANCELLED' } },
      listener: null,
      requests: [],
      sent: [],
      relay: {
        shareResult: NOT_ANSWERED,
        joinResult: NOT_ANSWERED,
        reopenResult: { ok: true, value: null },
        newLinksResult: NOT_ANSWERED,
        copyLinkResult: { ok: true, value: null },
        guideResult: { ok: true, value: null },
        requests: [],
        sent: [],
      },
    },
  };
  const { collaboration } = control;
  const { relay } = collaboration;
  /** Records a request about a relay and answers it with a value. */
  const askedRelay = <T>(request: readonly [string, ...unknown[]], value: T): Promise<T> => {
    relay.requests.push(request);
    return Promise.resolve(value);
  };
  /** Records a collaboration request and answers it with a value. */
  const asked = <T>(request: readonly [string, ...unknown[]], value: T): Promise<T> => {
    collaboration.requests.push(request);
    return Promise.resolve(value);
  };
  /** Records a call of the bridge and answers it with a value. */
  const called = <T>(name: string, value: T): Promise<T> => {
    control.calls.push(name);
    return Promise.resolve(value);
  };
  const bridge: TasklaceBridge = {
    regionalFormat: () => called('regionalFormat', FRENCH_FORMAT),
    newProject: () => called('newProject', control.newDocumentId),
    openProject: () => called('openProject', control.openResult),
    openRecentProject: (index) => {
      control.openedRecent.push(index);
      return called('openRecentProject', control.openResult);
    },
    recentProjects: () => {
      const { recent } = control;
      if (recent instanceof Error) {
        return Promise.reject(recent);
      }
      return called(
        'recentProjects',
        recent === 'unreadable'
          ? { ok: false, error: { code: 'READ_FAILED' } }
          : { ok: true, value: recent },
      );
    },
    importProject: (kind) => {
      control.imports.push(kind);
      return called('importProject', control.openResult);
    },
    adoptProject: (documentId) => {
      control.adopted.push(documentId);
      return called('adoptProject', control.adoptResult);
    },
    saveProject: (state) => {
      control.saved.push({ as: false, name: projectNameIn(state) });
      const { saveResult } = control;
      return saveResult instanceof Error
        ? Promise.reject(saveResult)
        : called('saveProject', saveResult);
    },
    saveProjectAs: (state) => {
      control.saved.push({ as: true, name: projectNameIn(state) });
      return called('saveProjectAs', control.saveAsResult);
    },
    exportProject: (kind, text, name) => {
      control.exports.push({ kind, text, name });
      return called('exportProject', control.exportResult);
    },
    exportPdf: (document, name) => {
      control.pdfExports.push({ document, name });
      return called('exportPdf', control.pdfResult);
    },
    saveHeldPdf: () => called('saveHeldPdf', control.heldPdfResult),
    exportLighterPdf: () => called('exportLighterPdf', control.heldPdfResult),
    discardHeldPdf: () => called('discardHeldPdf', control.discardResult),
    collaborationSettings: () => asked(['settings'], collaboration.settingsResult),
    saveCollaborationSettings: (settings) =>
      asked(['saveSettings', settings], collaboration.saveSettingsResult),
    sharePlan: (planName, hostName) =>
      asked(['share', planName, hostName], collaboration.shareResult),
    stopCollaboration: () => asked(['stop'], collaboration.stopResult),
    joinPlan: (joining) => asked(['join', joining], collaboration.joinResult),
    openSharedPlan: (state) => asked(['openShared', state], collaboration.openSharedResult),
    findPlans: (searching) => asked(['findPlans', searching], collaboration.findPlansResult),
    dropPeer: (peer) => asked(['dropPeer', peer], collaboration.dropResult),
    allowPeerToEdit: (peer) => asked(['allowPeerToEdit', peer], collaboration.allowResult),
    forgetGuests: (ids) => asked(['forgetGuests', ids], collaboration.forgetResult),
    copyJoinCode: () => asked(['copyCode'], collaboration.copyResult),
    findNextHost: (queue, planName, hostName, knownPeople) =>
      asked(
        ['findNextHost', queue, planName, hostName, knownPeople],
        collaboration.findNextHostResult,
      ),
    keepOwnChanges: (state, planName) =>
      asked(['keepOwnChanges', state, planName], collaboration.keepResult),
    openKeptChanges: () => asked(['openKeptChanges'], collaboration.openKeptResult),
    setLocalCopyAside: (documentId) => {
      control.setAside.push(documentId);
      return called('setLocalCopyAside', control.setAsideResult);
    },
    shareThroughRelay: (address) => askedRelay(['shareThroughRelay', address], relay.shareResult),
    joinByLink: (link) => askedRelay(['joinByLink', link], relay.joinResult),
    reopenSharedPlan: (documentId) =>
      askedRelay(['reopenSharedPlan', documentId], relay.reopenResult),
    makeNewLinks: () => askedRelay(['makeNewLinks'], relay.newLinksResult),
    copyRelayLink: (kind) => askedRelay(['copyRelayLink', kind], relay.copyLinkResult),
    openGuide: () => askedRelay(['openGuide'], relay.guideResult),
    sendToRelay: (outgoing) => {
      relay.sent.push(outgoing);
    },
    sendToCollaboration: (to, message) => {
      collaboration.sent.push([to, message]);
    },
    onCollaborationEvent: (listener) => {
      collaboration.listener = listener;
    },
    onFlushRequested: () => undefined,
    reportStartFailure: () => undefined,
  };
  return { bridge, control };
}

/** Gives the requests the page made about a relay, leaving out the one every opened plan makes to come back to its relay. */
export function relayRequests(control: FakeBridgeControl): (readonly [string, ...unknown[]])[] {
  return control.collaboration.relay.requests.filter(([name]) => name !== 'reopenSharedPlan');
}

/** Reads the name of the project a saved state holds, or null when it holds none. */
function projectNameIn(state: Uint8Array): string | null {
  const document = new Y.Doc();
  Y.applyUpdate(document, state);
  const name: unknown = document.getMap('project').get('name');
  return typeof name === 'string' ? name : null;
}

/** Builds a scheduler that computes schedules at once, or only records requests when told to stop being automatic. */
export function manualScheduler(): {
  readonly create: (listener: ScheduleListener) => Scheduler;
  readonly scheduler: ManualScheduler;
} {
  let current: ScheduleListener | null = null;
  const scheduler: ManualScheduler = {
    listener: () => {
      if (current === null) {
        throw new Error('No scheduler was created');
      }
      return current;
    },
    requests: [],
    automatic: true,
  };
  /** Creates a scheduler that records each request and answers it at once while it is automatic. */
  const create = (listener: ScheduleListener): Scheduler => {
    current = listener;
    return {
      request: (project) => {
        scheduler.requests.push(project);
        if (scheduler.automatic) {
          listener.scheduled(scheduleProject(project), project);
        }
      },
      dispose: () => undefined,
    };
  };
  return { create, scheduler };
}

/** Builds the context of the application state around a fake bridge and an immediate scheduler, with fixed identifiers and time. */
export function fakeAppContext() {
  const { bridge, control } = fakeBridge();
  const { create, scheduler } = manualScheduler();
  let nextId = 0;
  const context: AppContext = {
    bridge,
    messages: english,
    locale: 'en-US',
    createScheduler: create,
    createId: () => {
      nextId += 1;
      return testId(`id${String(nextId)}`);
    },
    now: () => FIXED_NOW,
    theme: SAND_GRAPHITE,
  };
  return { context, control, scheduler };
}

/** Waits one turn of the event loop, so that every pending promise callback has run. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Opens a project in a new application state, with a fake bridge and a scheduler that answers at once, then lets its schedule arrive. */
export async function openedAppOf(project: Project, overrides: Partial<AppContext> = {}) {
  const fake = fakeAppContext();
  const app = new AppState({ ...fake.context, ...overrides });
  fake.control.openResult = openedProjectOf(project);
  await app.open();
  await settle();
  return { app, ...fake };
}
