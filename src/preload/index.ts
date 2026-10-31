import { contextBridge, ipcRenderer } from 'electron';
import { CSV_SEPARATORS } from '../core/exchange/csv/csv-text';
import {
  DATE_ORDERS,
  DATE_SEPARATORS,
  type RegionalFormat,
} from '../core/exchange/csv/regional-format';
import {
  BRIDGE_NAME,
  IPC_CHANNELS,
  type BridgeResult,
  type CollaborationEvent,
  type FileAssociation,
  type OutsideRequest,
  type SetupState,
  type ChannelAnswers,
  type ChannelArguments,
  type ResultChannel,
  type LaunchCheck,
  type RecentProject,
  type ReleaseCheck,
  RELEASE_CHECK_FAILURES,
  type UpdateSettings,
  type TasklaceBridge,
} from './bridge-contract';
import { isCollaborationEvent } from './collaboration-events';
import { readVersion } from '../core/version';
import { MAX_FILE_PATH_LENGTH, MAX_RELAY_LINK_LENGTH } from '../core/limits';

const LIST_SEPARATORS: readonly unknown[] = CSV_SEPARATORS;
const DATE_ORDER_VALUES: readonly unknown[] = DATE_ORDERS;
const DATE_SEPARATOR_VALUES: readonly unknown[] = DATE_SEPARATORS;
const UNEXPECTED_ANSWER: BridgeResult<never> = { ok: false, error: { code: 'TASK_FAILED' } };

const bridge: TasklaceBridge = {
  regionalFormat: async () => {
    const format: unknown = await ipcRenderer.invoke(IPC_CHANNELS.regionalFormat);
    if (!isRegionalFormat(format)) {
      throw new Error('Unexpected regional format from the main process.');
    }
    return format;
  },
  newProject: async () => String(await ipcRenderer.invoke(IPC_CHANNELS.newProject)),
  openProject: () => request(IPC_CHANNELS.openProject),
  openRecentProject: (index) => request(IPC_CHANNELS.openRecentProject, index),
  recentProjects: async () => {
    const answer: BridgeResult<unknown> = await request(IPC_CHANNELS.recentProjects);
    if (!answer.ok) {
      return answer;
    }
    const projects: unknown = answer.value;
    if (!Array.isArray(projects)) {
      console.error('The main process sent recent projects that are not a list:', projects);
      return UNEXPECTED_ANSWER;
    }
    if (!projects.every(isRecentProject)) {
      console.error('The main process sent recent projects of an unexpected shape:', projects);
      return UNEXPECTED_ANSWER;
    }
    return { ok: true, value: projects };
  },
  importProject: (kind) => request(IPC_CHANNELS.importProject, kind),
  adoptProject: (documentId) => request(IPC_CHANNELS.adoptProject, documentId),
  saveProject: (state) => request(IPC_CHANNELS.saveProject, state),
  saveProjectAs: (state, suggestedName) =>
    request(IPC_CHANNELS.saveProjectAs, state, suggestedName),
  keepOwnChanges: (state, planName) => request(IPC_CHANNELS.keepOwnChanges, state, planName),
  openKeptChanges: () => request(IPC_CHANNELS.openKeptChanges),
  setLocalCopyAside: (documentId) => request(IPC_CHANNELS.setLocalCopyAside, documentId),
  exportProject: (kind, text, suggestedName) =>
    request(IPC_CHANNELS.exportProject, kind, text, suggestedName),
  exportPdf: (document, suggestedName) => request(IPC_CHANNELS.exportPdf, document, suggestedName),
  saveHeldPdf: () => request(IPC_CHANNELS.saveHeldPdf),
  exportLighterPdf: () => request(IPC_CHANNELS.exportLighterPdf),
  discardHeldPdf: () => request(IPC_CHANNELS.discardHeldPdf),
  collaborationSettings: () => request(IPC_CHANNELS.collaborationSettings),
  saveCollaborationSettings: (settings) =>
    request(IPC_CHANNELS.saveCollaborationSettings, settings),
  sharePlan: (planName, hostName, participantId) =>
    request(IPC_CHANNELS.sharePlan, planName, hostName, participantId),
  stopCollaboration: () => request(IPC_CHANNELS.stopCollaboration),
  joinPlan: (joining) => request(IPC_CHANNELS.joinPlan, joining),
  openSharedPlan: (state) => request(IPC_CHANNELS.openSharedPlan, state),
  findPlans: (searching) => request(IPC_CHANNELS.findPlans, searching),
  dropPeer: (peer) => request(IPC_CHANNELS.dropPeer, peer),
  allowPeerToEdit: (peer) => request(IPC_CHANNELS.allowPeerToEdit, peer),
  forgetGuests: (participantIds) => request(IPC_CHANNELS.forgetGuests, participantIds),
  copyJoinCode: () => request(IPC_CHANNELS.copyJoinCode),
  findNextHost: (queue, planName, hostName, knownPeople) =>
    request(IPC_CHANNELS.findNextHost, queue, planName, hostName, knownPeople),
  shareThroughRelay: (address) => request(IPC_CHANNELS.shareThroughRelay, address),
  joinByLink: (link) => request(IPC_CHANNELS.joinByLink, link),
  reopenSharedPlan: (documentId) => request(IPC_CHANNELS.reopenSharedPlan, documentId),
  makeNewLinks: () => request(IPC_CHANNELS.makeNewLinks),
  forgetSharedPlan: () => request(IPC_CHANNELS.forgetSharedPlan),
  copyRelayLink: (kind) => request(IPC_CHANNELS.copyRelayLink, kind),
  openGuide: () => request(IPC_CHANNELS.openGuide),
  appVersion: () =>
    checked(IPC_CHANNELS.appVersion, request(IPC_CHANNELS.appVersion), isVersionText),
  openPrivacyPolicy: () => request(IPC_CHANNELS.openPrivacyPolicy),
  updateSettings: () =>
    checked(IPC_CHANNELS.updateSettings, request(IPC_CHANNELS.updateSettings), isUpdateSettings),
  setCheckForNewVersions: (check) => request(IPC_CHANNELS.setCheckForNewVersions, check),
  checkAtLaunch: () =>
    checked(IPC_CHANNELS.checkAtLaunch, request(IPC_CHANNELS.checkAtLaunch), isLaunchCheck),
  checkNow: () => checked(IPC_CHANNELS.checkNow, request(IPC_CHANNELS.checkNow), isReleaseCheck),
  openReleasePage: (version) => request(IPC_CHANNELS.openReleasePage, version),
  takeOutsideRequest: () =>
    checked(
      IPC_CHANNELS.takeOutsideRequest,
      request(IPC_CHANNELS.takeOutsideRequest),
      isOutsideRequestOrNone,
    ),
  openOutsideFile: () => request(IPC_CHANNELS.openOutsideFile),
  setupState: () =>
    checked(IPC_CHANNELS.setupState, request(IPC_CHANNELS.setupState), isSetupState),
  finishWelcome: (choices) =>
    checked(
      IPC_CHANNELS.finishWelcome,
      request(IPC_CHANNELS.finishWelcome, choices),
      isFileAssociation,
    ),
  setFileAssociation: (on) =>
    checked(
      IPC_CHANNELS.setFileAssociation,
      request(IPC_CHANNELS.setFileAssociation, on),
      isFileAssociation,
    ),
  onOutsideRequest: (listener) => {
    outsideListener = listener;
  },
  sendToRelay: (outgoing) => {
    ipcRenderer.send(IPC_CHANNELS.relaySend, outgoing);
  },
  sendToCollaboration: (to, message) => {
    ipcRenderer.send(IPC_CHANNELS.collaborationSend, to, message);
  },
  onCollaborationEvent: (listener) => {
    collaborationListener = listener;
  },
  onFlushRequested: (flush) => {
    pageFlush = flush;
  },
  reportStartFailure: () => {
    ipcRenderer.send(IPC_CHANNELS.pageStartFailed);
  },
};

let pageFlush: (() => Promise<boolean>) | null = null;
let collaborationListener: ((event: CollaborationEvent) => void) | null = null;
let outsideListener: (() => void) | null = null;

ipcRenderer.on(IPC_CHANNELS.collaborationEvent, (_event, value: unknown) => {
  if (!isCollaborationEvent(value)) {
    console.error(
      'The main process sent an event of the shared plan of an unexpected shape:',
      value,
    );
    return;
  }
  collaborationListener?.(value);
});

ipcRenderer.on(IPC_CHANNELS.flushRequested, answerCloseRequest);

ipcRenderer.on(IPC_CHANNELS.outsideRequestReceived, () => {
  outsideListener?.();
});

/** Answers a request to close the window: at once while the page has not started, since it holds nothing to save yet, otherwise once the page has saved and agreed, keeping the window open when the page fails unexpectedly. */
function answerCloseRequest(): void {
  if (pageFlush === null) {
    ipcRenderer.send(IPC_CHANNELS.flushDone, true);
    return;
  }
  pageFlush().then(
    (mayClose) => {
      ipcRenderer.send(IPC_CHANNELS.flushDone, mayClose);
    },
    (error: unknown) => {
      console.error('The page could not prepare to close:', error);
      ipcRenderer.send(IPC_CHANNELS.flushDone, false);
    },
  );
}

contextBridge.exposeInMainWorld(BRIDGE_NAME, bridge);

/** Sends a file request to the main process and gives back its result, an answer of any other shape being logged and counting as a failed task. */
async function request<C extends ResultChannel>(
  channel: C,
  ...values: ChannelArguments[C]
): Promise<ChannelAnswers[C] | BridgeResult<never>> {
  const result: unknown = await ipcRenderer.invoke(channel, ...values);
  if (isAnswerOf(channel, result)) {
    return result;
  }
  console.error(`The main process answered ${channel} with an unexpected shape:`, result);
  return UNEXPECTED_ANSWER;
}

/** Checks the value of an answer the page relies on, besides its outcome, an answer of any other shape being logged and counting as a failed task. */
async function checked<T>(
  channel: ResultChannel,
  request: Promise<BridgeResult<unknown>>,
  isValue: (value: unknown) => value is T,
): Promise<BridgeResult<T>> {
  const answer = await request;
  if (!answer.ok) {
    return answer;
  }
  if (isValue(answer.value)) {
    return { ok: true, value: answer.value };
  }
  console.error(`The main process answered ${channel} with an unexpected value:`, answer.value);
  return UNEXPECTED_ANSWER;
}

/** Tells whether an answer is the text of a version. */
function isVersionText(value: unknown): value is string {
  return readVersion(value) !== null;
}

/** Tells whether an answer has the shape of the settings of new versions. */
function isUpdateSettings(value: unknown): value is UpdateSettings {
  return typeof Reflect.get(Object(value), 'checkForNewVersions') === 'boolean';
}

/** Tells whether an answer is the result of a check for new versions. */
function isReleaseCheck(value: unknown): value is ReleaseCheck {
  const kind: unknown = Reflect.get(Object(value), 'kind');
  const failures: readonly unknown[] = RELEASE_CHECK_FAILURES;
  return (
    kind === 'latest' ||
    (kind === 'newer' && isVersionText(Reflect.get(Object(value), 'version'))) ||
    (kind === 'failed' && failures.includes(Reflect.get(Object(value), 'reason')))
  );
}

/** Tells whether an answer is the result of the check at launch, which may also have been skipped. */
function isLaunchCheck(value: unknown): value is LaunchCheck {
  return Reflect.get(Object(value), 'kind') === 'skipped' || isReleaseCheck(value);
}

/** Tells whether an answer is what Tasklace was started with from outside, a project file or the link of a shared plan, or nothing. */
function isOutsideRequestOrNone(value: unknown): value is OutsideRequest | null {
  if (value === null) {
    return true;
  }
  const kind: unknown = Reflect.get(Object(value), 'kind');
  const link: unknown = Reflect.get(Object(value), 'link');
  return (
    kind === 'file' ||
    (kind === 'link' &&
      typeof link === 'string' &&
      link.length <= MAX_RELAY_LINK_LENGTH &&
      link.toLowerCase().startsWith('tasklace://'))
  );
}

/** Tells whether an answer says which copy of Tasklace opens project files. */
function isFileAssociation(value: unknown): value is FileAssociation {
  const kind: unknown = Reflect.get(Object(value), 'kind');
  const path: unknown = Reflect.get(Object(value), 'path');
  return (
    kind === 'unavailable' ||
    kind === 'none' ||
    kind === 'thisCopy' ||
    (kind === 'otherCopy' && typeof path === 'string' && path.length <= MAX_FILE_PATH_LENGTH)
  );
}

/** Tells whether an answer is the setup of this copy: whether its welcome window must show, and which copy opens project files. */
function isSetupState(value: unknown): value is SetupState {
  return (
    typeof Reflect.get(Object(value), 'welcome') === 'boolean' &&
    isFileAssociation(Reflect.get(Object(value), 'association'))
  );
}

/** Tells whether an answer to a file request has the shape of a bridge result, checking only its outcome, the rest being trusted since the main process types what each channel answers. */
function isAnswerOf<C extends ResultChannel>(
  _channel: C,
  value: unknown,
): value is ChannelAnswers[C] {
  return typeof Reflect.get(Object(value), 'ok') === 'boolean';
}

/** Tells whether an answer is a regional format, each field holding one of its allowed values. */
function isRegionalFormat(value: unknown): value is RegionalFormat {
  /** Reads a field of the answer, whatever its shape. */
  const field = (name: string): unknown => Reflect.get(Object(value), name);
  return (
    LIST_SEPARATORS.includes(field('listSeparator')) &&
    DATE_ORDER_VALUES.includes(field('dateOrder')) &&
    DATE_SEPARATOR_VALUES.includes(field('dateSeparator')) &&
    typeof field('twelveHourClock') === 'boolean'
  );
}

/** Tells whether an answer has the shape of a recent project. */
function isRecentProject(value: unknown): value is RecentProject {
  const relay: unknown = Reflect.get(Object(value), 'relay');
  return (
    typeof Reflect.get(Object(value), 'name') === 'string' &&
    typeof Reflect.get(Object(value), 'folder') === 'string' &&
    (relay === null || typeof relay === 'string')
  );
}
