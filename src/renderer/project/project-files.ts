import * as Y from 'yjs';
import type { Project } from '../../core/model/project';
import { createSharedDocument } from '../../core/shared/shared-document';
import { openSharedSession, type SharedSession } from '../../core/shared/shared-session';
import type {
  BridgeResult,
  ExchangeKind,
  FileFailure,
  ImportWarning,
  OpenedProject,
  TasklaceBridge,
} from '../../preload/bridge-contract';
import { createAutosave, type Timer } from './autosave';

export type ProjectBridge = Pick<
  TasklaceBridge,
  | 'newProject'
  | 'openProject'
  | 'openRecentProject'
  | 'importProject'
  | 'saveProject'
  | 'saveProjectAs'
>;

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
}

export interface ProjectFiles {
  readonly session: () => SharedSession | null;
  readonly hasFile: () => boolean;
  readonly create: (project: Project) => Promise<SharedSession>;
  readonly open: () => Promise<BridgeResult<OpenedSession>>;
  readonly openRecent: (index: number) => Promise<BridgeResult<OpenedSession>>;
  readonly importFile: (kind: ExchangeKind) => Promise<BridgeResult<OpenedSession>>;
  readonly save: () => Promise<BridgeResult<null>>;
  readonly saveAs: () => Promise<BridgeResult<null>>;
  readonly flush: () => Promise<void>;
}

export class FileActionError extends Error {
  /** Carries the failure of a file action the user did not start, such as an automatic save. */
  constructor(readonly failure: FileFailure) {
    super(`File action failed: ${failure.code}`);
  }
}

interface Current {
  readonly session: SharedSession;
  hasFile: boolean;
}

/** Keeps the project of the page in a shared document, saving it automatically a little after each change, to its file or to its local copy only while it has none, and at once before another project replaces it, telling whether the latest changes are saved. */
export function createProjectFiles(
  bridge: ProjectBridge,
  listener: ProjectFilesListener,
  timer?: Timer,
): ProjectFiles {
  let current: Current | null = null;
  let changeCount = 0;
  const trackSave = async (
    saving: (state: Uint8Array) => Promise<BridgeResult<null>>,
  ): Promise<BridgeResult<null>> => {
    if (current === null) {
      return { ok: false, error: { code: 'NO_PROJECT' } };
    }
    const savedChanges = changeCount;
    listener.saveStatus('saving');
    const result = await saving(Y.encodeStateAsUpdate(current.session.document));
    if (result.ok) {
      listener.saveStatus(changeCount === savedChanges ? 'saved' : 'unsaved');
    } else {
      listener.saveStatus(result.error.code === 'CANCELLED' ? 'unsaved' : 'failed');
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
  const replace = async (session: SharedSession, hasFile: boolean): Promise<void> => {
    await autosave.flush().catch(listener.failed);
    current?.session.document.off('update', changed);
    current = { session, hasFile };
    session.document.on('update', changed);
    listener.saveStatus('saved');
  };
  const load = async (
    opening: Promise<BridgeResult<OpenedProject>>,
    hasFile: boolean,
  ): Promise<BridgeResult<OpenedSession>> => {
    const opened = await opening;
    if (!opened.ok) {
      return opened;
    }
    const document = new Y.Doc();
    Y.applyUpdate(document, opened.value.state);
    const session = openSharedSession(document);
    if (!session.ok) {
      return { ok: false, error: { code: 'INVALID_PROJECT', issues: session.error } };
    }
    await replace(session.value, hasFile);
    return {
      ok: true,
      value: {
        session: session.value,
        name: opened.value.name,
        fileName: opened.value.fileName,
        warnings: opened.value.warnings,
      },
    };
  };
  const saveAs = async (): Promise<BridgeResult<null>> => {
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
    create: async (project) => {
      const document = createSharedDocument(project, await bridge.newProject());
      const session = openSharedSession(document);
      if (!session.ok) {
        throw new Error('A new project must be valid.');
      }
      await replace(session.value, false);
      return session.value;
    },
    open: () => load(bridge.openProject(), true),
    openRecent: (index) => load(bridge.openRecentProject(index), true),
    importFile: (kind) => load(bridge.importProject(kind), false),
    save: () => (current?.hasFile === true ? trackSave(bridge.saveProject) : saveAs()),
    saveAs,
    flush: autosave.flush,
  };
}
