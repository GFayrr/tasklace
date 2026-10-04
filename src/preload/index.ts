import { contextBridge, ipcRenderer } from 'electron';
import { CSV_SEPARATORS } from '../core/exchange/csv/csv-text';
import type { RegionalFormat } from '../core/exchange/csv/regional-format';
import {
  BRIDGE_NAME,
  IPC_CHANNELS,
  type BridgeResult,
  type ChannelAnswers,
  type ResultChannel,
  type RecentProject,
  type TasklaceBridge,
} from './bridge-contract';

const LIST_SEPARATORS: readonly unknown[] = CSV_SEPARATORS;
const DATE_ORDERS: readonly unknown[] = ['dayMonthYear', 'monthDayYear', 'yearMonthDay'];
const DATE_SEPARATORS: readonly unknown[] = ['/', '.', '-'];
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
    const answer: BridgeResult<unknown> = await request(IPC_CHANNELS.recentProjects);
    if (!answer.ok) {
      return answer;
    }
    const projects: readonly unknown[] = Array.isArray(answer.value) ? answer.value : [];
    const recent = projects.filter(isRecentProject);
    if (!Array.isArray(answer.value) || recent.length !== projects.length) {
      console.error('The main process sent recent projects of an unexpected shape:', answer.value);
    }
    return { ok: true, value: recent };
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

/** Sends a file request to the main process and gives back its result, an answer of any other shape being logged and counting as a failed task. */
async function request<C extends ResultChannel>(
  channel: C,
  ...values: unknown[]
): Promise<ChannelAnswers[C] | BridgeResult<never>> {
  const result: unknown = await ipcRenderer.invoke(channel, ...values);
  if (isAnswerOf(channel, result)) {
    return result;
  }
  console.error(`The main process answered ${channel} with an unexpected shape:`, result);
  return UNEXPECTED_ANSWER;
}

/** Tells whether an answer to a file request has the shape of a bridge result, the main process typing what each channel answers. */
function isAnswerOf<C extends ResultChannel>(
  _channel: C,
  value: unknown,
): value is ChannelAnswers[C] {
  return typeof Reflect.get(Object(value), 'ok') === 'boolean';
}

/** Tells whether an answer is a regional format, each field holding one of its allowed values. */
function isRegionalFormat(value: unknown): value is RegionalFormat {
  const field = (name: string): unknown => Reflect.get(Object(value), name);
  return (
    LIST_SEPARATORS.includes(field('listSeparator')) &&
    DATE_ORDERS.includes(field('dateOrder')) &&
    DATE_SEPARATORS.includes(field('dateSeparator')) &&
    typeof field('twelveHourClock') === 'boolean'
  );
}

/** Tells whether an answer has the shape of a recent project. */
function isRecentProject(value: unknown): value is RecentProject {
  return (
    typeof Reflect.get(Object(value), 'name') === 'string' &&
    typeof Reflect.get(Object(value), 'folder') === 'string'
  );
}
