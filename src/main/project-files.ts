import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  type FileFilter,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { ownCopyName } from '../core/collaboration/own-copy';
import { MAX_CSV_FILE_BYTES, MAX_FILE_BYTES, MAX_JSON_FILE_BYTES } from '../core/limits';
import { failure, success } from '../core/result';
import { isDocumentId, requireDocumentId, type DocumentId } from '../core/shared/shared-document';
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
import type { FileTask, ResultOfTask, LoadedProject, RelayPlan } from './file-tasks';
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
import { setLocalCopyAside } from './local-copies';
import {
  noteRecentRelay,
  readRecentProjects,
  recordRecentProject,
  type RecentEntry,
} from './recent-projects';
import { writeFileSafely } from './safe-write';
import { createSerialQueue } from './serial-queue';
import { isMissingFile, isSystemError } from './stored-files';
import { regionalFormatOf } from './system-regional-format';

export interface ProjectFileServices {
  readonly assertTrusted: TrustCheck;
  readonly runTask: <T extends FileTask>(task: T) => Promise<ResultOfTask<T>>;
  readonly userDataFolder: string;
}

export type WindowProjectKind = 'none' | 'withFile' | 'withoutFile' | 'joinedPlan';

export interface ProjectFileHandlers {
  readonly offerRelayPlan: (
    sender: WebContents,
    plan: RelayPlan,
    relay: string,
  ) => Promise<OpenedProject>;
  readonly noteRelay: (sender: WebContents, relay: string | null) => Promise<void>;
}

interface WindowProject {
  readonly path: string | null;
  readonly documentId: DocumentId;
  readonly joined: boolean;
  readonly relay?: string | null;
}

type ReadKind = 'tasklace' | ExchangeKind;

export type SavedKind = ReadKind | 'pdf';

type SaveDestination =
  { readonly kind: 'current' } | { readonly kind: 'chosen'; readonly suggestedName: string };

const MAX_BYTES: Readonly<Record<ReadKind, number>> = {
  tasklace: MAX_FILE_BYTES,
  json: MAX_JSON_FILE_BYTES,
  csv: MAX_CSV_FILE_BYTES,
};
const FILTERS: Readonly<Record<SavedKind, FileFilter>> = {
  tasklace: { name: MESSAGES.dialogs.projectFiles, extensions: ['tasklace'] },
  json: { name: MESSAGES.dialogs.jsonFiles, extensions: ['json'] },
  csv: { name: MESSAGES.dialogs.csvFiles, extensions: ['csv'] },
  pdf: { name: MESSAGES.dialogs.pdfFiles, extensions: ['pdf'] },
};
const RECENT_STORE = 'recent-projects.json';
const REPLACE_BUTTON = 0;
const CANCEL_BUTTON = 1;
const FILE_PLACEHOLDER = '{file}';
const LOCAL_COPY_FOLDER = 'local-copies';
const KEPT_FOLDER = 'kept-plans';
const SHARED_FOLDER = 'shared-plans';
const KEPT_NAME_ATTEMPTS = 64;
const projects = new WeakMap<WebContents, WindowProject>();
const saveInOrder = createSerialQueue();
const offered = new WeakMap<WebContents, WindowProject>();
const keptChanges = new WeakMap<WebContents, string>();

/** Forgets the project of the window of a page about to reload, the reloaded page starting without any project. */
export function forgetWindowProject(sender: WebContents): void {
  projects.delete(sender);
  offered.delete(sender);
}

/** Gives the identifier of the plan the window of a page holds, or null when it holds none. */
export function windowDocumentOf(sender: WebContents): DocumentId | null {
  return projects.get(sender)?.documentId ?? null;
}

/** Tells what the window of a page holds: no project, a project saved to a file, a shared plan it joined, or a project kept only on this computer. */
export function windowProjectKind(sender: WebContents): WindowProjectKind {
  const project = projects.get(sender);
  if (project === undefined) {
    return 'none';
  }
  if (project.path !== null) {
    return 'withFile';
  }
  return project.joined ? 'joinedPlan' : 'withoutFile';
}

/** Answers the project file requests of the bridge, the main process alone choosing paths and knowing the project of each window, which changes only once its page adopts it, and returns how to offer and note plans shared through a relay. */
export function registerProjectFileHandlers(services: ProjectFileServices): ProjectFileHandlers {
  /** Registers the answer of a channel, which checks first that the page asking is trusted. */
  const handle = <C extends InvokeChannel>(channel: C, answer: ChannelHandler<C>): void => {
    handleChannel(services.assertTrusted, channel, answer);
  };
  /** Registers the answer of a file action channel, an unexpected failure becoming a task failure. */
  const handleFileAction = <C extends ResultChannel>(
    channel: C,
    answer: (event: IpcMainInvokeEvent, ...values: unknown[]) => Promise<ChannelAnswers[C]>,
  ): void => {
    registerChannel(services.assertTrusted, channel, (event, ...values) =>
      answerOrFail(channel, () => answer(event, ...values)),
    );
  };
  handle(IPC_CHANNELS.regionalFormat, () => regionalFormatOf(app.getSystemLocale()));
  handle(IPC_CHANNELS.newProject, (event) =>
    offerProject(event.sender, null, requireDocumentId(randomUUID())),
  );
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
  handleFileAction(IPC_CHANNELS.keepOwnChanges, (event, state, planName) =>
    keepOwnChanges(services, event.sender, state, planName),
  );
  handleFileAction(IPC_CHANNELS.openKeptChanges, (event) =>
    openKeptChanges(services, event.sender),
  );
  handleFileAction(IPC_CHANNELS.setLocalCopyAside, (event, documentId) =>
    setCopyAside(services, event.sender, documentId),
  );
  return {
    offerRelayPlan: (sender, plan, relay) => offerRelayPlan(services, sender, plan, relay),
    noteRelay: (sender, relay) => noteRelay(services, sender, relay),
  };
}

/** Answers a file request of the bridge, turning an Error other than a refusal into a logged task failure the page can report, and throwing again a value that is not an Error. */
export async function answerOrFail(
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

/** Offers a window the file and document it is about to work on, or the shared plan it joined, which become its project once its page adopts them, returning the document identifier. */
function offerProject(
  sender: WebContents,
  path: string | null,
  documentId: DocumentId,
  joined = false,
): DocumentId {
  offered.set(sender, { path, documentId, joined });
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
    await rememberRecentProject(services, project.path, project.relay);
  }
  return success(null);
}

/** Sets aside the local copy of the file offered to a window or opened in it, whose changes the user chose not to add, so that the next save does not replace them, noting in the log where they went. */
async function setCopyAside(
  services: ProjectFileServices,
  sender: WebContents,
  value: unknown,
): Promise<BridgeResult<null>> {
  const documentId = isDocumentId(value) ? value : refuseMessage();
  const project = [offered.get(sender), projects.get(sender)].find(
    (candidate) => candidate?.documentId === documentId,
  );
  const path = project?.path ?? null;
  if (path === null) {
    console.error('The page set aside the local copy of a file its window was not given.');
    return failure({ code: 'TASK_FAILED' });
  }
  try {
    const aside = await setLocalCopyAside(
      join(services.userDataFolder, LOCAL_COPY_FOLDER),
      documentId,
      new Date(),
    );
    console.warn(
      `The changes kept on this computer for ${path} were not added to it and were set aside as ${aside ?? 'nothing, the copy being gone'}.`,
    );
    return success(null);
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error(`The local copy of ${path} could not be set aside:`, error);
    return failure({ code: 'WRITE_FAILED' });
  }
}

/** Offers a window the shared plan it joined, whose state the worker checked, as a project without file, giving what the page opens. */
export function offerSharedProject(sender: WebContents, loaded: LoadedProject): OpenedProject {
  offerProject(sender, null, loaded.documentId, true);
  return {
    state: loaded.state,
    documentId: loaded.documentId,
    fileName: '',
    warnings: [],
    localChanges: null,
  };
}

/** Offers a window the plan it joined through a relay as a file of its own on this computer, so that it reopens from the recent projects with its relay, or as a project without file when that file cannot be written, which is logged. */
async function offerRelayPlan(
  services: ProjectFileServices,
  sender: WebContents,
  plan: RelayPlan,
  relay: string,
): Promise<OpenedProject> {
  const { state, documentId } = plan;
  const path = await saveInOrder(() => keepRelayPlan(services, plan));
  offered.set(sender, { path, documentId, joined: path === null, relay });
  return {
    state,
    documentId,
    fileName: path === null ? '' : basename(path),
    warnings: [],
    localChanges: null,
  };
}

/** Writes a plan joined through a relay to a file of its own in the folder of shared plans, under the name of its plan, giving its path or null when it could not be written. */
async function keepRelayPlan(
  services: ProjectFileServices,
  plan: RelayPlan,
): Promise<string | null> {
  const folder = join(services.userDataFolder, SHARED_FOLDER);
  if (!(await createdFolder(folder, 'shared plans'))) {
    return null;
  }
  const path = await freePathIn(
    folder,
    fileNameForProject(plan.name, 'tasklace', MESSAGES.projects.untitled),
  );
  const written = await services.runTask({
    kind: 'saveProject',
    path,
    state: plan.state,
    documentId: plan.documentId,
    localCopyFolder: join(services.userDataFolder, LOCAL_COPY_FOLDER),
    savedAt: new Date(),
  });
  if (!written.ok) {
    console.error(
      `The plan joined through a relay could not be kept as ${path}: ${written.error.code}.`,
    );
    return null;
  }
  return path;
}

/** Notes the relay the plan of a window is shared through, or that it is shared through none, in the recent projects when the plan has a file, a list that cannot be written being only logged. */
async function noteRelay(
  services: ProjectFileServices,
  sender: WebContents,
  relay: string | null,
): Promise<void> {
  const project = projects.get(sender);
  if (project === undefined) {
    return;
  }
  projects.set(sender, { ...project, relay });
  if (project.path === null) {
    return;
  }
  try {
    await noteRecentRelay(recentStore(services), project.path, relay);
  } catch (error) {
    console.error('The relay of a recent project could not be noted:', error);
  }
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
  const read = await readRecentEntries(services);
  if (!read.ok) {
    return read;
  }
  const entries = read.value;
  const path = entries[index]?.path;
  if (path === undefined) {
    console.error(
      `The page asked for recent project ${String(index)}, but only ${String(entries.length)} are known.`,
    );
    return failure({ code: 'READ_FAILED' });
  }
  return openPath(services, sender, path);
}

/** Lists the recent projects by name, folder and the relay their plan is shared through, a list that cannot be read being logged and reported, so that the page keeps the list it shows and tells the user. */
async function listRecent(
  services: ProjectFileServices,
): Promise<BridgeResult<readonly RecentProject[]>> {
  const read = await readRecentEntries(services);
  return read.ok
    ? success(
        read.value.map(({ path, relay }) => ({
          name: projectNameFromPath(path, MESSAGES.projects.untitled),
          folder: isOnThisComputer(services, path)
            ? MESSAGES.projects.keptOnThisComputer
            : dirname(path),
          relay,
        })),
      )
    : read;
}

/** Tells whether a project file lives in a folder Tasklace keeps on this computer, for changes kept apart or plans joined through a relay. */
function isOnThisComputer(services: ProjectFileServices, path: string): boolean {
  return [KEPT_FOLDER, SHARED_FOLDER].some(
    (folder) => dirname(path) === join(services.userDataFolder, folder),
  );
}

/** Reads the recent projects, a failure of the system being logged and reported as a failed read. */
async function readRecentEntries(
  services: ProjectFileServices,
): Promise<BridgeResult<readonly RecentEntry[]>> {
  try {
    return success(await readRecentProjects(recentStore(services)));
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
  const loaded = await services.runTask({
    kind: 'openProject',
    path,
    localCopyFolder: join(services.userDataFolder, LOCAL_COPY_FOLDER),
  });
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
  const documentId = requireDocumentId(randomUUID());
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

/** Saves the project of a window: to its file, or where the user chooses when saving as, the name of the project being suggested, a project without file keeping only its local copy so that saving automatically never opens a dialog, and a file chosen by saving as becoming, once written, the file of the window and a recent project, even when its local copy failed. */
async function saveProject(
  services: ProjectFileServices,
  sender: WebContents,
  value: unknown,
  destination: SaveDestination,
): Promise<BridgeResult<SavedProject>> {
  const state = readProjectState(value) ?? refuseMessage();
  const project = projects.get(sender);
  if (project === undefined) {
    console.error('A page asked to save a project its window does not hold.');
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
      savedAt: new Date(),
    }),
  );
  if (!saved.ok) {
    return saved;
  }
  if (path !== null && path !== project.path) {
    projects.set(sender, { path, documentId, joined: false });
    await rememberRecentProject(services, path);
  }
  return success({ localCopySaved: saved.value.localCopySaved });
}

/** Keeps, as a project file of its own in a folder of this computer and first among the recent projects, the shared plan of a window in which this person could not share their changes, so that the page can show the shared plan again without losing them. */
async function keepOwnChanges(
  services: ProjectFileServices,
  sender: WebContents,
  value: unknown,
  name: unknown,
): Promise<BridgeResult<SavedProject>> {
  const state = readProjectState(value) ?? refuseMessage();
  const planName = readSuggestedName(name) ?? refuseMessage();
  if (projects.get(sender) === undefined) {
    console.error('A page asked to keep its changes without holding a project.');
    return failure({ code: 'NO_PROJECT' });
  }
  const folder = join(services.userDataFolder, KEPT_FOLDER);
  if (!(await createdFolder(folder, 'kept changes'))) {
    return failure({ code: 'WRITE_FAILED' });
  }
  const fileName = fileNameForProject(
    ownCopyName(planName, MESSAGES.collaboration.ownCopyName),
    'tasklace',
    MESSAGES.projects.untitled,
  );
  const kept = await saveInOrder(async () => {
    const path = await freePathIn(folder, fileName);
    const written = await services.runTask({
      kind: 'keepSharedCopy',
      state,
      documentId: requireDocumentId(randomUUID()),
      nameTemplate: MESSAGES.collaboration.ownCopyName,
      path,
      localCopyFolder: join(services.userDataFolder, LOCAL_COPY_FOLDER),
      savedAt: new Date(),
    });
    return written.ok ? success({ path, localCopySaved: written.value.localCopySaved }) : written;
  });
  if (!kept.ok) {
    return kept;
  }
  keptChanges.set(sender, kept.value.path);
  await rememberRecentProject(services, kept.value.path);
  return success({ localCopySaved: kept.value.localCopySaved });
}

/** Opens the plan a window last kept the changes of its person in. */
async function openKeptChanges(
  services: ProjectFileServices,
  sender: WebContents,
): Promise<BridgeResult<OpenedProject>> {
  const path = keptChanges.get(sender);
  if (path === undefined) {
    console.error('A page asked to open the changes it kept, but its window kept none.');
    return failure({ code: 'TASK_FAILED' });
  }
  return openPath(services, sender, path);
}

/** Creates a folder when it is missing, telling whether it now exists, an error of the system being logged with what the folder holds. */
async function createdFolder(folder: string, holding: string): Promise<boolean> {
  try {
    await mkdir(folder, { recursive: true });
    return true;
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    console.error(`The folder of the ${holding} could not be created:`, error);
    return false;
  }
}

/** Finds a path in a folder for a file name that no file uses yet, trying the name itself, then “name 2”, “name 3” and so on up to a limit, then a random identifier. */
async function freePathIn(folder: string, fileName: string): Promise<string> {
  const extension = extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length);
  for (let number = 1; number <= KEPT_NAME_ATTEMPTS; number += 1) {
    const path = join(folder, number === 1 ? fileName : `${stem} ${String(number)}${extension}`);
    if (!(await fileExists(path))) {
      return path;
    }
  }
  return join(folder, `${randomUUID()}${extension}`);
}

/** Adds a project to the recent list, with the relay its plan is shared through when it is known, a list that cannot be read or written being only logged since the project itself is fine. */
async function rememberRecentProject(
  services: ProjectFileServices,
  path: string,
  relay?: string | null,
): Promise<void> {
  try {
    await recordRecentProject(recentStore(services), path, relay);
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
async function checkSize(path: string, kind: ReadKind): Promise<BridgeResult<never> | null> {
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
    localChanges: loaded.localChanges,
  };
}

/** Shows the open dialog for a kind of file, giving the chosen path or null. */
async function chooseFileToOpen(sender: WebContents, kind: ReadKind): Promise<string | null> {
  const options = { properties: ['openFile' as const], filters: [FILTERS[kind]] };
  const window = BrowserWindow.fromWebContents(sender);
  const chosen =
    window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
  return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
}

/** Shows the save dialog for a kind of file with the name of the project suggested, giving the chosen path with its extension, or null when the user cancels or declines to replace a file the added extension leads to. */
export async function chooseFileToSave(
  sender: WebContents,
  kind: SavedKind,
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
    if (isMissingFile(error)) {
      return false;
    }
    if (isSystemError(error)) {
      console.warn('A file could not be examined, so it counts as absent:', error);
      return false;
    }
    throw error;
  }
}

/** Returns where the recent projects are stored. */
function recentStore(services: ProjectFileServices): string {
  return join(services.userDataFolder, RECENT_STORE);
}
