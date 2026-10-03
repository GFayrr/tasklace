import * as Y from 'yjs';
import type { Project } from '../../core/model/project';
import { createSharedDocument, readDocumentId } from '../../core/shared/shared-document';
import { openSharedSession, type SharedSession } from '../../core/shared/shared-session';
import type {
  BridgeResult,
  ExchangeKind,
  ExportedFile,
  FileFailure,
  ImportWarning,
  OpenedProject,
  SavedProject,
  TasklaceBridge,
} from '../../preload/bridge-contract';
import { createAutosave, type Timer } from './autosave';

export type ProjectBridge = Pick<
  TasklaceBridge,
  | 'newProject'
  | 'openProject'
  | 'openRecentProject'
  | 'importProject'
  | 'adoptProject'
  | 'saveProject'
  | 'saveProjectAs'
  | 'exportProject'
>;

export type PageFailureCode = 'BUSY' | 'UNSAVED_PROJECT';

export type ActionFailure = FileFailure | { readonly code: PageFailureCode };

export type ActionResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ActionFailure };

export interface OpenedSession {
  readonly session: SharedSession;
  readonly name: string;
  readonly fileName: string;
  readonly warnings: readonly ImportWarning[];
}

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'failed';

export interface ProjectFilesListener {
  readonly failed: (error: unknown) => void;
  readonly saveStatus: (status: SaveStatus) => void;
  readonly localCopyFailed: () => void;
  readonly fileActionRunning: (running: boolean) => void;
}

export interface ProjectFiles {
  readonly session: () => SharedSession | null;
  readonly hasFile: () => boolean;
  readonly create: (project: Project) => Promise<ActionResult<SharedSession>>;
  readonly open: () => Promise<ActionResult<OpenedSession>>;
  readonly openRecent: (index: number) => Promise<ActionResult<OpenedSession>>;
  readonly importFile: (kind: ExchangeKind) => Promise<ActionResult<OpenedSession>>;
  readonly save: () => Promise<ActionResult<SavedProject>>;
  readonly saveAs: () => Promise<ActionResult<SavedProject>>;
  readonly exportFile: (
    kind: ExchangeKind,
    text: string,
    suggestedName: string,
  ) => Promise<ActionResult<ExportedFile>>;
  readonly flush: () => Promise<void>;
}

export class FileActionError extends Error {
  /** Carries the failure of a file action the user did not start, such as an automatic save. */
  constructor(readonly failure: ActionFailure) {
    super(`File action failed: ${failure.code}`);
  }
}

interface Current {
  readonly session: SharedSession;
  hasFile: boolean;
}

const NOTHING_TO_SAVE: ActionResult<never> = { ok: false, error: { code: 'NO_PROJECT' } };

/** Keeps the project of the page in a shared document, saving it automatically a little after each change, to its file or to its local copy only while it has none, sending one save at a time, running one file action at a time, saving the open project before another replaces it and taking a new project only once the main process has adopted it, telling whether the latest changes are saved. */
export function createProjectFiles(
  bridge: ProjectBridge,
  listener: ProjectFilesListener,
  timer?: Timer,
): ProjectFiles {
  let current: Current | null = null;
  let changeCount = 0;
  let busy = false;
  let lastSave: Promise<unknown> = Promise.resolve();
  const sendSave = (
    saving: (state: Uint8Array) => Promise<BridgeResult<SavedProject>>,
  ): Promise<ActionResult<SavedProject>> => {
    const sent = lastSave.then((): Promise<ActionResult<SavedProject>> => {
      const state = current === null ? null : Y.encodeStateAsUpdate(current.session.document);
      return state === null ? Promise.resolve(NOTHING_TO_SAVE) : saving(state);
    });
    lastSave = sent.catch(() => undefined);
    return sent;
  };
  const trackSave = async (
    saving: (state: Uint8Array) => Promise<BridgeResult<SavedProject>>,
  ): Promise<ActionResult<SavedProject>> => {
    if (current === null) {
      return NOTHING_TO_SAVE;
    }
    const savedChanges = changeCount;
    listener.saveStatus('saving');
    let result: ActionResult<SavedProject> = { ok: false, error: { code: 'TASK_FAILED' } };
    try {
      result = await sendSave(saving);
    } finally {
      listener.saveStatus(saveStatusAfter(result, changeCount === savedChanges));
    }
    if (result.ok && !result.value.localCopySaved) {
      listener.localCopyFailed();
    }
    return result;
  };
  const saveCurrent = async (): Promise<void> => {
    const result = await trackSave(bridge.saveProject);
    if (!result.ok && result.error.code !== 'NO_PROJECT') {
      throw new FileActionError(result.error);
    }
  };
  const autosave = createAutosave(saveCurrent, listener.failed, timer);
  const changed = (): void => {
    changeCount += 1;
    listener.saveStatus('unsaved');
    autosave.changed();
  };
  const exclusive = async <T>(action: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> => {
    if (busy) {
      return { ok: false, error: { code: 'BUSY' } };
    }
    busy = true;
    listener.fileActionRunning(true);
    try {
      return await action();
    } finally {
      busy = false;
      listener.fileActionRunning(false);
    }
  };
  const saveBeforeSwitching = async (): Promise<ActionResult<null>> => {
    try {
      await autosave.flush();
      return { ok: true, value: null };
    } catch (error) {
      listener.failed(error);
      return { ok: false, error: { code: 'UNSAVED_PROJECT' } };
    }
  };
  const adopt = async (document: Y.Doc, hasFile: boolean): Promise<ActionResult<SharedSession>> => {
    const documentId = readDocumentId(document);
    const session = openSharedSession(document);
    if (documentId === null || !session.ok) {
      const issues = session.ok ? [] : session.error;
      return { ok: false, error: { code: 'INVALID_PROJECT', issues } };
    }
    const adopted = await bridge.adoptProject(documentId);
    if (!adopted.ok) {
      return adopted;
    }
    current?.session.document.off('update', changed);
    current = { session: session.value, hasFile };
    session.value.document.on('update', changed);
    listener.saveStatus('saved');
    return session;
  };
  const load = async (
    opening: () => Promise<BridgeResult<OpenedProject>>,
    hasFile: boolean,
  ): Promise<ActionResult<OpenedSession>> => {
    const saved = await saveBeforeSwitching();
    if (!saved.ok) {
      return saved;
    }
    const opened = await opening();
    if (!opened.ok) {
      return opened;
    }
    const document = decodedDocument(opened.value.state);
    if (document === null) {
      return { ok: false, error: { code: 'INVALID_CONTENT' } };
    }
    const session = await adopt(document, hasFile);
    if (!session.ok) {
      return session;
    }
    const { name, fileName, warnings } = opened.value;
    return { ok: true, value: { session: session.value, name, fileName, warnings } };
  };
  const create = async (project: Project): Promise<ActionResult<SharedSession>> => {
    const saved = await saveBeforeSwitching();
    if (!saved.ok) {
      return saved;
    }
    return adopt(createSharedDocument(project, await bridge.newProject()), false);
  };
  const saveAs = async (): Promise<ActionResult<SavedProject>> => {
    const name = current?.session.project().name ?? '';
    const result = await trackSave((state) => bridge.saveProjectAs(state, name));
    if (current !== null) {
      current.hasFile ||= result.ok;
    }
    return result;
  };
  return {
    session: () => current?.session ?? null,
    hasFile: () => current?.hasFile === true,
    create: (project) => exclusive(() => create(project)),
    open: () => exclusive(() => load(bridge.openProject, true)),
    openRecent: (index) => exclusive(() => load(() => bridge.openRecentProject(index), true)),
    importFile: (kind) => exclusive(() => load(() => bridge.importProject(kind), false)),
    save: () =>
      exclusive(() => (current?.hasFile === true ? trackSave(bridge.saveProject) : saveAs())),
    saveAs: () => exclusive(saveAs),
    exportFile: (kind, text, suggestedName) =>
      exclusive(() => bridge.exportProject(kind, text, suggestedName)),
    flush: autosave.flush,
  };
}

/** Decodes the Yjs state of an opened project into a new document, or returns null when the state cannot be applied. */
function decodedDocument(state: Uint8Array): Y.Doc | null {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, state);
    return document;
  } catch (error) {
    console.error('The opened project could not be decoded:', error);
    return null;
  }
}

/** Returns the save status after a save: saved, or still unsaved when changes came during it or the user cancelled, or failed. */
function saveStatusAfter(result: ActionResult<SavedProject>, noChangeSince: boolean): SaveStatus {
  if (result.ok) {
    return noChangeSince ? 'saved' : 'unsaved';
  }
  return result.error.code === 'CANCELLED' ? 'unsaved' : 'failed';
}
