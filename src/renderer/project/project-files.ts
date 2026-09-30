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
  readonly warnings: readonly ImportWarning[];
}

export interface ProjectFiles {
  readonly session: () => SharedSession | null;
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

/** Keeps the project of the page in a shared document, saving it automatically a little after each change, to its file or to its local copy only while it has none, and at once before another project replaces it. */
export function createProjectFiles(
  bridge: ProjectBridge,
  reportFailure: (error: unknown) => void,
  timer?: Timer,
): ProjectFiles {
  let current: Current | null = null;
  const saveCurrent = async (): Promise<void> => {
    if (current === null) {
      return;
    }
    const result = await bridge.saveProject(Y.encodeStateAsUpdate(current.session.document));
    if (!result.ok) {
      throw new FileActionError(result.error);
    }
  };
  const autosave = createAutosave(saveCurrent, reportFailure, timer);
  const replace = async (session: SharedSession, hasFile: boolean): Promise<void> => {
    await autosave.flush().catch(reportFailure);
    current?.session.document.off('update', autosave.changed);
    current = { session, hasFile };
    session.document.on('update', autosave.changed);
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
      value: { session: session.value, name: opened.value.name, warnings: opened.value.warnings },
    };
  };
  const saveAs = async (): Promise<BridgeResult<null>> => {
    if (current === null) {
      return { ok: false, error: { code: 'NO_PROJECT' } };
    }
    const result = await bridge.saveProjectAs(Y.encodeStateAsUpdate(current.session.document));
    current.hasFile ||= result.ok;
    return result;
  };
  return {
    session: () => current?.session ?? null,
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
    save: async () => {
      if (current?.hasFile !== true) {
        return saveAs();
      }
      return bridge.saveProject(Y.encodeStateAsUpdate(current.session.document));
    },
    saveAs,
    flush: autosave.flush,
  };
}
