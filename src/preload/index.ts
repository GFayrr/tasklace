import { contextBridge, ipcRenderer } from 'electron';
import type { RegionalFormat } from '../core/exchange/csv/regional-format';
import {
  BRIDGE_NAME,
  IPC_CHANNELS,
  type BridgeResult,
  type IpcChannel,
  type RecentProject,
  type TasklaceBridge,
} from './bridge-contract';

const UNEXPECTED_ANSWER: BridgeResult<never> = { ok: false, error: { code: 'TASK_FAILED' } };

const bridge: TasklaceBridge = {
  appVersion: async () => String(await ipcRenderer.invoke(IPC_CHANNELS.appVersion)),
  openExternal: async (url) => (await ipcRenderer.invoke(IPC_CHANNELS.openExternal, url)) === true,
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
    const answer: unknown = await ipcRenderer.invoke(IPC_CHANNELS.recentProjects);
    const projects: readonly unknown[] = Array.isArray(answer) ? answer : [];
    return projects.filter(isRecentProject);
  },
  importProject: (kind) => request(IPC_CHANNELS.importProject, kind),
  adoptProject: (documentId) => request(IPC_CHANNELS.adoptProject, documentId),
  saveProject: (state) => request(IPC_CHANNELS.saveProject, state),
  saveProjectAs: (state, suggestedName) =>
    request(IPC_CHANNELS.saveProjectAs, state, suggestedName),
  exportProject: (kind, text, suggestedName) =>
    request(IPC_CHANNELS.exportProject, kind, text, suggestedName),
  onFlushRequested: (flush) => {
    pageFlush = flush;
  },
  reportStartFailure: () => {
    ipcRenderer.send(IPC_CHANNELS.pageStartFailed);
  },
};

let pageFlush: (() => Promise<boolean>) | null = null;

ipcRenderer.on(IPC_CHANNELS.flushRequested, answerCloseRequest);

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

/** Sends a file request to the main process and gives back its result, an answer of any other shape counting as a failed task. */
async function request<T>(channel: IpcChannel, ...values: unknown[]): Promise<BridgeResult<T>> {
  const result: unknown = await ipcRenderer.invoke(channel, ...values);
  return isBridgeResult<T>(result) ? result : UNEXPECTED_ANSWER;
}

/** Tells whether an answer has the shape of a bridge result. */
function isBridgeResult<T>(value: unknown): value is BridgeResult<T> {
  return typeof Reflect.get(Object(value), 'ok') === 'boolean';
}

/** Tells whether an answer has the shape of a regional format. */
function isRegionalFormat(value: unknown): value is RegionalFormat {
  const fields = ['listSeparator', 'dateOrder', 'dateSeparator', 'twelveHourClock'];
  return typeof value === 'object' && value !== null && fields.every((field) => field in value);
}

/** Tells whether an answer has the shape of a recent project. */
function isRecentProject(value: unknown): value is RecentProject {
  return (
    typeof Reflect.get(Object(value), 'name') === 'string' &&
    typeof Reflect.get(Object(value), 'folder') === 'string'
  );
}
