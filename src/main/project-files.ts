import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  type FileFilter,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { MAX_CSV_FILE_BYTES, MAX_FILE_BYTES, MAX_JSON_FILE_BYTES } from '../core/limits';
import { failure, success } from '../core/result';
import { isDocumentId, type DocumentId } from '../core/shared/shared-document';
import { MIN_PROJECT_HOUR } from '../core/time';
import {
  IPC_CHANNELS,
  type BridgeResult,
  type ChannelAnswers,
  type ExchangeKind,
  type InvokeChannel,
  type ExportedFile,
  type OpenedProject,
  type RecentProject,
  type ResultChannel,
  type SavedProject,
} from '../preload/bridge-contract';
import type { FileTask, ResultOfTask, LoadedProject } from './file-tasks';
import {
  readExchangeKind,
  readExportText,
  readProjectState,
  readRecentIndex,
  readSuggestedName,
} from './ipc-validators';
import { handleChannel, registerChannel, type ChannelHandler } from './ipc-channels';
import { RefusedRequest, refuseMessage, type TrustCheck } from './ipc-trust';
import { MESSAGES } from './messages';
import {
  fileNameForProject,
  localProjectHour,
  projectNameFromPath,
  withExtension,
} from './project-names';
import { readRecentProjects, recordRecentProject } from './recent-projects';
import { writeFileSafely } from './safe-write';
import { createSerialQueue } from './serial-queue';
import { isSystemError } from './stored-files';
import { regionalFormatOf } from './system-regional-format';

export interface ProjectFileServices {
  readonly assertTrusted: TrustCheck;
  readonly runTask: <T extends FileTask>(task: T) => Promise<ResultOfTask<T>>;
  readonly userDataFolder: string;
}

export type WindowProjectKind = 'none' | 'withFile' | 'withoutFile';

interface WindowProject {
  readonly path: string | null;
  readonly documentId: DocumentId;
}

type FileKind = 'tasklace' | ExchangeKind;

type SaveDestination =
  { readonly kind: 'current' } | { readonly kind: 'chosen'; readonly suggestedName: string };

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
const REPLACE_BUTTON = 0;
const CANCEL_BUTTON = 1;
const FILE_PLACEHOLDER = '{file}';
const LOCAL_COPY_FOLDER = 'local-copies';
const projects = new WeakMap<WebContents, WindowProject>();
const saveInOrder = createSerialQueue();
const offered = new WeakMap<WebContents, WindowProject>();

/** Tells what the window of a page holds: no project, a project saved to a file, or a project kept only on this computer. */
export function windowProjectKind(sender: WebContents): WindowProjectKind {
  const project = projects.get(sender);
  if (project === undefined) {
    return 'none';
  }
  return project.path === null ? 'withoutFile' : 'withFile';
}

/** Answers the project file requests of the bridge: new, open, recent, import, adopt, save, save as and export, the main process alone choosing paths through dialogs and knowing the file and document of each window, which changes only once the page has accepted the project offered to it. */
export function registerProjectFileHandlers(services: ProjectFileServices): void {
  const handle = <C extends InvokeChannel>(channel: C, answer: ChannelHandler<C>): void => {
    handleChannel(services.assertTrusted, channel, answer);
  };
  const handleFileAction = <C extends ResultChannel>(
    channel: C,
    answer: (event: IpcMainInvokeEvent, ...values: unknown[]) => Promise<ChannelAnswers[C]>,
  ): void => {
    registerChannel(services.assertTrusted, channel, (event, ...values) =>
      answerOrFail(channel, () => answer(event, ...values)),
    );
  };
  handle(IPC_CHANNELS.regionalFormat, () => regionalFormatOf(app.getSystemLocale()));
  handle(IPC_CHANNELS.newProject, (event) => offerProject(event.sender, null, randomUUID()));
  handle(IPC_CHANNELS.adoptProject, (event, documentId) =>
    adoptProject(services, event.sender, documentId),
  );
  handleFileAction(IPC_CHANNELS.openProject, (event) => chooseAndOpen(services, event.sender));
  handleFileAction(IPC_CHANNELS.openRecentProject, (event, index) =>
    openRecent(services, event.sender, index),
  );
  handle(IPC_CHANNELS.recentProjects, () => listRecent(services));
  handleFileAction(IPC_CHANNELS.importProject, (event, kind) =>
    importProject(services, event.sender, kind),
  );
  handleFileAction(IPC_CHANNELS.saveProject, (event, state) =>
    saveProject(services, event.sender, state, { kind: 'current' }),
  );
  handleFileAction(IPC_CHANNELS.saveProjectAs, (event, state, name) =>
    saveProject(services, event.sender, state, {
      kind: 'chosen',
      suggestedName: readSuggestedName(name) ?? refuseMessage(),
    }),
  );
  handleFileAction(IPC_CHANNELS.exportProject, (event, kind, text, name) =>
    exportProject(event.sender, kind, text, name),
  );
}

/** Answers a file request of the bridge (open, open recent, import, save, save as, export), turning an Error other than a refused message into a file failure the page can tell the user about and logging it, a thrown value that is not an Error being thrown again. */
async function answerOrFail(
  channel: string,
  answer: () => Promise<BridgeResult<unknown>>,
): Promise<BridgeResult<unknown>> {
  try {
    return await answer();
  } catch (error) {
    if (error instanceof RefusedRequest || !(error instanceof Error)) {
      throw error;
    }
    console.error(`The request ${channel} failed:`, error);
    return failure({ code: 'TASK_FAILED' });
  }
}

/** Offers a window the file and document it is about to work on, which become its project once its page adopts them, returning the document identifier. */
function offerProject(
  sender: WebContents,
  path: string | null,
  documentId: DocumentId,
): DocumentId {
  offered.set(sender, { path, documentId });
  return documentId;
}

/** Makes the project offered to a window its project once the page tells it accepted that document, adding its file to the recent projects, and refuses any other document. */
async function adoptProject(
  services: ProjectFileServices,
  sender: WebContents,
  value: unknown,
): Promise<BridgeResult<null>> {
  const documentId = isDocumentId(value) ? value : refuseMessage();
  const project = offered.get(sender);
  if (project?.documentId !== documentId) {
    console.error('The page adopted a project that was not offered to it.');
    return failure({ code: 'TASK_FAILED' });
  }
  offered.delete(sender);
  projects.set(sender, project);
  if (project.path !== null) {
    await rememberRecentProject(services, project.path);
  }
  return success(null);
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

/** Lists the recent projects by name and folder, a list that cannot be read being logged and reported, so that the page keeps the list it shows and tells the user. */
async function listRecent(
  services: ProjectFileServices,
): Promise<BridgeResult<readonly RecentProject[]>> {
  try {
    const paths = await readRecentProjects(recentStore(services));
    return success(
      paths.map((path) => ({
        name: projectNameFromPath(path, MESSAGES.projects.untitled),
        folder: dirname(path),
      })),
    );
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The recent projects could not be read:', error);
    return failure({ code: 'READ_FAILED' });
  }
}

/** Checks the size of a project file, decodes it in the worker and offers it to the window. */
async function openPath(
  services: ProjectFileServices,
  sender: WebContents,
  path: string,
): Promise<BridgeResult<OpenedProject>> {
  const tooLarge = await checkSize(path, 'tasklace');
  if (tooLarge !== null) {
    return tooLarge;
  }
  const loaded = await services.runTask({ kind: 'openProject', path });
  if (!loaded.ok) {
    return loaded;
  }
  offerProject(sender, path, loaded.value.documentId);
  return success(openedProject(loaded.value, path));
}

/** Lets the user choose a JSON or CSV file, imports it in the worker into a new, not yet saved document, and offers it to the window. */
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
  const naming = { untitled: MESSAGES.projects.untitled, fromFile: options.projectName };
  const task: Extract<FileTask, { kind: 'importJson' | 'importCsv' }> =
    kind === 'json'
      ? { kind: 'importJson', path, documentId, naming }
      : { kind: 'importCsv', path, documentId, options };
  const loaded = await services.runTask(task);
  if (!loaded.ok) {
    return loaded;
  }
  offerProject(sender, null, documentId);
  return success(openedProject(loaded.value, path));
}

/** Saves the project of a window: to its file, or where the user chooses when saving as, the name of the project being suggested, a project without file keeping only its local copy so that saving automatically never opens a dialog; once a file chosen by saving as is written, it becomes the file of the window and a recent project, even when its local copy failed. */
async function saveProject(
  services: ProjectFileServices,
  sender: WebContents,
  value: unknown,
  destination: SaveDestination,
): Promise<BridgeResult<SavedProject>> {
  const state = readProjectState(value) ?? refuseMessage();
  const project = projects.get(sender);
  if (project === undefined) {
    return failure({ code: 'NO_PROJECT' });
  }
  const path =
    destination.kind === 'chosen'
      ? await chooseFileToSave(sender, 'tasklace', destination.suggestedName)
      : project.path;
  if (destination.kind === 'chosen' && path === null) {
    return failure({ code: 'CANCELLED' });
  }
  const { documentId } = project;
  const saved = await saveInOrder(() =>
    services.runTask({
      kind: 'saveProject',
      path,
      state,
      documentId,
      localCopyFolder: join(services.userDataFolder, LOCAL_COPY_FOLDER),
      savedAt: Date.now(),
    }),
  );
  if (!saved.ok) {
    return saved;
  }
  if (path !== null && path !== project.path) {
    projects.set(sender, { path, documentId });
    await rememberRecentProject(services, path);
  }
  return success({ localCopySaved: saved.value.localCopySaved });
}

/** Adds a project to the recent list, a list that cannot be read or written being only logged since the project itself is fine. */
async function rememberRecentProject(services: ProjectFileServices, path: string): Promise<void> {
  try {
    await recordRecentProject(recentStore(services), path);
  } catch (error) {
    console.error('The recent projects could not be recorded:', error);
  }
}

/** Lets the user choose where to export the project of a window, the name of the project being suggested, then writes the export safely and tells the name of the file written. */
async function exportProject(
  sender: WebContents,
  kindValue: unknown,
  textValue: unknown,
  nameValue: unknown,
): Promise<BridgeResult<ExportedFile>> {
  const kind = readExchangeKind(kindValue) ?? refuseMessage();
  const text = readExportText(textValue, kind) ?? refuseMessage();
  const name = readSuggestedName(nameValue) ?? refuseMessage();
  const path = await chooseFileToSave(sender, kind, name);
  if (path === null) {
    return failure({ code: 'CANCELLED' });
  }
  try {
    await writeFileSafely(path, text);
    return success({ fileName: basename(path) });
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The export could not be written:', error);
    return failure({ code: 'WRITE_FAILED' });
  }
}

/** Refuses a file larger than the limit of its kind, checked in bytes before anything reads it, or gives null when it may be read. */
async function checkSize(path: string, kind: FileKind): Promise<BridgeResult<never> | null> {
  try {
    const { size } = await stat(path);
    return size > MAX_BYTES[kind] ? failure({ code: 'TOO_LARGE' }) : null;
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error('The size of the file could not be read:', error);
    return failure({ code: 'READ_FAILED' });
  }
}

/** Describes a loaded project to the page. */
function openedProject(loaded: LoadedProject, path: string): OpenedProject {
  return {
    state: loaded.state,
    documentId: loaded.documentId,
    fileName: basename(path),
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

/** Shows the save dialog for a kind of file with the name of the project suggested, giving the chosen path with its extension, or null when the user cancels or declines to replace a file the added extension leads to. */
async function chooseFileToSave(
  sender: WebContents,
  kind: FileKind,
  suggestedName: string,
): Promise<string | null> {
  const current = projects.get(sender)?.path ?? null;
  const fileName = fileNameForProject(suggestedName, kind, MESSAGES.projects.untitled);
  const options = {
    filters: [FILTERS[kind]],
    defaultPath: current === null ? fileName : join(dirname(current), fileName),
    properties: ['showOverwriteConfirmation' as const],
  };
  const window = BrowserWindow.fromWebContents(sender);
  const chosen =
    window === null
      ? await dialog.showSaveDialog(options)
      : await dialog.showSaveDialog(window, options);
  if (chosen.canceled || chosen.filePath === '') {
    return null;
  }
  const path = withExtension(chosen.filePath, kind);
  const mayWrite = path === chosen.filePath || (await mayReplace(window, path));
  return mayWrite ? path : null;
}

/** Tells whether a file the added extension leads to may be written, asking the user first when it already exists, since the save dialog could not warn about it. */
async function mayReplace(window: BrowserWindow | null, path: string): Promise<boolean> {
  if (!(await fileExists(path))) {
    return true;
  }
  const options = {
    type: 'question' as const,
    buttons: [MESSAGES.dialogs.replace, MESSAGES.dialogs.cancel],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    message: MESSAGES.dialogs.replaceExisting.replace(FILE_PLACEHOLDER, basename(path)),
  };
  const answer =
    window === null
      ? await dialog.showMessageBox(options)
      : await dialog.showMessageBox(window, options);
  return answer.response === REPLACE_BUTTON;
}

/** Tells whether a file can be found, a file that cannot be examined counting as missing so that the writing that follows reports the problem. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isSystemError(error)) {
      return false;
    }
    throw error;
  }
}

/** Returns where the recent projects are stored. */
function recentStore(services: ProjectFileServices): string {
  return join(services.userDataFolder, RECENT_STORE);
}
