import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type FileFilter,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { MAX_CSV_FILE_BYTES, MAX_FILE_BYTES, MAX_JSON_FILE_BYTES } from '../core/limits';
import { failure, success } from '../core/result';
import type { DocumentId } from '../core/shared/shared-document';
import { MIN_PROJECT_HOUR } from '../core/time';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type ExchangeKind,
  type OpenedProject,
  type RecentProject,
} from '../preload/bridge-contract';
import type { FileTask, FileTaskResult, LoadedProject } from './file-tasks';
import {
  readExchangeKind,
  readExportText,
  readProjectState,
  readRecentIndex,
} from './ipc-validators';
import { refuseMessage, type TrustCheck } from './ipc-trust';
import { MESSAGES } from './messages';
import { localProjectHour, projectNameFromPath } from './project-names';
import { readRecentProjects, recordRecentProject } from './recent-projects';
import { writeFileSafely } from './safe-write';
import { regionalFormatOf } from './system-regional-format';

export interface ProjectFileServices {
  readonly assertTrusted: TrustCheck;
  readonly runTask: (task: FileTask) => Promise<FileTaskResult>;
  readonly userDataFolder: string;
}

interface WindowProject {
  readonly path: string | null;
  readonly documentId: DocumentId;
}

type FileKind = 'tasklace' | ExchangeKind;

const MAX_BYTES: Readonly<Record<FileKind, number>> = {
  tasklace: MAX_FILE_BYTES,
  json: MAX_JSON_FILE_BYTES,
  csv: MAX_CSV_FILE_BYTES,
};
const FILTERS: Readonly<Record<FileKind, FileFilter>> = {
  tasklace: { name: MESSAGES.dialogs.projectFiles, extensions: ['tasklace'] },
  json: { name: MESSAGES.dialogs.jsonFiles, extensions: ['json'] },
  csv: { name: MESSAGES.dialogs.csvFiles, extensions: ['csv'] },
};
const RECENT_STORE = 'recent-projects.json';
const LOCAL_COPY_FOLDER = 'local-copies';
const projects = new WeakMap<WebContents, WindowProject>();

/** Answers the project file requests of the bridge: new, open, recent, import, save, save as and export, the main process alone choosing paths through dialogs and knowing the file and document of each window. */
export function registerProjectFileHandlers(services: ProjectFileServices): void {
  const handle = (
    channel: string,
    answer: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, ...values: unknown[]) => {
      services.assertTrusted(event);
      return answer(event, ...values);
    });
  };
  handle(IPC_CHANNELS.regionalFormat, () => regionalFormatOf(app.getSystemLocale()));
  handle(IPC_CHANNELS.newProject, (event) => startProject(event.sender, null, randomUUID()));
  handle(IPC_CHANNELS.openProject, (event) => chooseAndOpen(services, event.sender));
  handle(IPC_CHANNELS.openRecentProject, (event, index) =>
    openRecent(services, event.sender, index),
  );
  handle(IPC_CHANNELS.recentProjects, () => listRecent(services));
  handle(IPC_CHANNELS.importProject, (event, kind) => importProject(services, event.sender, kind));
  handle(IPC_CHANNELS.saveProject, (event, state) =>
    saveProject(services, event.sender, state, false),
  );
  handle(IPC_CHANNELS.saveProjectAs, (event, state) =>
    saveProject(services, event.sender, state, true),
  );
  handle(IPC_CHANNELS.exportProject, (event, kind, text) =>
    exportProject(event.sender, kind, text),
  );
}

/** Remembers the file and document a window now works on, returning the document identifier. */
function startProject(
  sender: WebContents,
  path: string | null,
  documentId: DocumentId,
): DocumentId {
  projects.set(sender, { path, documentId });
  return documentId;
}

/** Lets the user choose a project file, then opens it. */
async function chooseAndOpen(
  services: ProjectFileServices,
  sender: WebContents,
): Promise<BridgeResult<OpenedProject>> {
  const path = await chooseFileToOpen(sender, 'tasklace');
  return path === null ? failure({ code: 'CANCELLED' }) : openPath(services, sender, path);
}

/** Opens one of the recent projects by its position in the list. */
async function openRecent(
  services: ProjectFileServices,
  sender: WebContents,
  value: unknown,
): Promise<BridgeResult<OpenedProject>> {
  const index = readRecentIndex(value) ?? refuseMessage();
  const path = (await readRecentProjects(recentStore(services)))[index];
  return path === undefined ? failure({ code: 'READ_FAILED' }) : openPath(services, sender, path);
}

/** Lists the recent projects by name and folder. */
async function listRecent(services: ProjectFileServices): Promise<RecentProject[]> {
  const paths = await readRecentProjects(recentStore(services));
  return paths.map((path) => ({
    name: projectNameFromPath(path, MESSAGES.projects.untitled),
    folder: dirname(path),
  }));
}

/** Checks the size of a project file, decodes it in the worker and makes it the project of the window. */
async function openPath(
  services: ProjectFileServices,
  sender: WebContents,
  path: string,
): Promise<BridgeResult<OpenedProject>> {
  const tooLarge = await checkSize(path, 'tasklace');
  if (tooLarge !== null) {
    return tooLarge;
  }
  const loaded = await loadedProject(services.runTask({ kind: 'openProject', path }));
  if (!loaded.ok) {
    return loaded;
  }
  startProject(sender, path, loaded.value.documentId);
  await recordRecentProject(recentStore(services), path);
  return success(openedProject(loaded.value, path));
}

/** Lets the user choose a JSON or CSV file, imports it in the worker into a new, not yet saved document, and makes it the project of the window. */
async function importProject(
  services: ProjectFileServices,
  sender: WebContents,
  value: unknown,
): Promise<BridgeResult<OpenedProject>> {
  const kind = readExchangeKind(value) ?? refuseMessage();
  const path = await chooseFileToOpen(sender, kind);
  if (path === null) {
    return failure({ code: 'CANCELLED' });
  }
  const tooLarge = await checkSize(path, kind);
  if (tooLarge !== null) {
    return tooLarge;
  }
  const documentId = randomUUID();
  const options = {
    format: regionalFormatOf(app.getSystemLocale()),
    projectName: projectNameFromPath(path, MESSAGES.projects.untitled),
    fallbackStart: localProjectHour(new Date(), MIN_PROJECT_HOUR),
  };
  const task: FileTask =
    kind === 'json'
      ? { kind: 'importJson', path, documentId }
      : { kind: 'importCsv', path, documentId, options };
  const loaded = await loadedProject(services.runTask(task));
  if (!loaded.ok) {
    return loaded;
  }
  startProject(sender, null, documentId);
  return success(openedProject(loaded.value, path));
}

/** Saves the project of a window: to its file, asking where first only when asked to save as, a project without file keeping only its local copy so that saving automatically never opens a dialog. */
async function saveProject(
  services: ProjectFileServices,
  sender: WebContents,
  value: unknown,
  choosePath: boolean,
): Promise<BridgeResult<null>> {
  const state = readProjectState(value) ?? refuseMessage();
  const project = projects.get(sender);
  if (project === undefined) {
    return failure({ code: 'NO_PROJECT' });
  }
  const path = choosePath ? await chooseFileToSave(sender, 'tasklace') : project.path;
  if (choosePath && path === null) {
    return failure({ code: 'CANCELLED' });
  }
  const localCopyFolder = join(services.userDataFolder, LOCAL_COPY_FOLDER);
  await mkdir(localCopyFolder, { recursive: true });
  const { documentId } = project;
  const task = {
    kind: 'saveProject',
    path,
    state,
    documentId,
    localCopyFolder,
    savedAt: Date.now(),
  } as const;
  const saved = await services.runTask(task);
  if (!saved.ok) {
    return saved;
  }
  if (path !== null && path !== project.path) {
    startProject(sender, path, documentId);
    await recordRecentProject(recentStore(services), path);
  }
  return success(null);
}

/** Lets the user choose where to export the project of a window, then writes the export safely. */
async function exportProject(
  sender: WebContents,
  kindValue: unknown,
  textValue: unknown,
): Promise<BridgeResult<null>> {
  const kind = readExchangeKind(kindValue) ?? refuseMessage();
  const text = readExportText(textValue, kind) ?? refuseMessage();
  const path = await chooseFileToSave(sender, kind);
  if (path === null) {
    return failure({ code: 'CANCELLED' });
  }
  try {
    await writeFileSafely(path, text);
    return success(null);
  } catch (error) {
    if (error instanceof Error) {
      return failure({ code: 'WRITE_FAILED' });
    }
    throw error;
  }
}

/** Refuses a file larger than the limit of its kind, checked in bytes before anything reads it, or gives null when it may be read. */
async function checkSize(path: string, kind: FileKind): Promise<BridgeResult<never> | null> {
  try {
    const { size } = await stat(path);
    return size > MAX_BYTES[kind] ? failure({ code: 'TOO_LARGE' }) : null;
  } catch (error) {
    if (error instanceof Error) {
      return failure({ code: 'READ_FAILED' });
    }
    throw error;
  }
}

/** Waits for a loading task and requires it to have loaded a project. */
async function loadedProject(task: Promise<FileTaskResult>): Promise<BridgeResult<LoadedProject>> {
  const result = await task;
  if (!result.ok) {
    return result;
  }
  return result.value === null ? failure({ code: 'TASK_FAILED' }) : success(result.value);
}

/** Describes a loaded project to the page. */
function openedProject(loaded: LoadedProject, path: string): OpenedProject {
  return {
    state: loaded.state,
    name: projectNameFromPath(path, MESSAGES.projects.untitled),
    warnings: loaded.warnings,
  };
}

/** Shows the open dialog for a kind of file, giving the chosen path or null. */
async function chooseFileToOpen(sender: WebContents, kind: FileKind): Promise<string | null> {
  const options = { properties: ['openFile' as const], filters: [FILTERS[kind]] };
  const window = BrowserWindow.fromWebContents(sender);
  const chosen =
    window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
  return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
}

/** Shows the save dialog for a kind of file, giving the chosen path or null. */
async function chooseFileToSave(sender: WebContents, kind: FileKind): Promise<string | null> {
  const current = projects.get(sender)?.path ?? null;
  const options = {
    filters: [FILTERS[kind]],
    ...(current === null ? {} : { defaultPath: basename(current) }),
  };
  const window = BrowserWindow.fromWebContents(sender);
  const chosen =
    window === null
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(window, options);
  return chosen.canceled || chosen.filePath === '' ? null : chosen.filePath;
}

/** Returns where the recent projects are stored. */
function recentStore(services: ProjectFileServices): string {
  return join(services.userDataFolder, RECENT_STORE);
}
