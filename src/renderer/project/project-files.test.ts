import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createSharedDocument, readDocumentId } from '../../core/shared/shared-document';
import { project, TEST_DOCUMENT_ID, workTask } from '../../core/testing/project-builder';
import type { BridgeResult, OpenedProject } from '../../preload/bridge-contract';
import type { Timer } from './autosave';
import {
  createProjectFiles,
  FileActionError,
  type ProjectBridge,
  type ProjectFilesListener,
  type SaveStatus,
} from './project-files';

const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const SAMPLE = project([workTask('a')]);
const SAVED: BridgeResult<null> = { ok: true, value: null };
const QUIET: ProjectFilesListener = { failed: () => undefined, saveStatus: () => undefined };

/** A timer driven by hand. */
function manualTimer(): Timer & { readonly fire: () => void } {
  let callback: (() => void) | null = null;
  return {
    set: (next) => {
      callback = next;
      return next;
    },
    clear: () => {
      callback = null;
    },
    fire: () => {
      const current = callback;
      callback = null;
      current?.();
    },
  };
}

/** A bridge answering from fixed results and recording the saves it receives with the names they suggest. */
function fakeBridge(openResult: BridgeResult<OpenedProject>, saveResult = SAVED) {
  const saves: { readonly as: boolean; readonly documentId: string | null }[] = [];
  const suggestedNames: string[] = [];
  const record = (as: boolean) => (state: Uint8Array, name?: string) => {
    const document = new Y.Doc();
    Y.applyUpdate(document, state);
    saves.push({ as, documentId: readDocumentId(document) });
    if (name !== undefined) {
      suggestedNames.push(name);
    }
    return Promise.resolve(saveResult);
  };
  const bridge: ProjectBridge = {
    newProject: () => Promise.resolve(TEST_DOCUMENT_ID),
    openProject: () => Promise.resolve(openResult),
    openRecentProject: () => Promise.resolve(openResult),
    importProject: () => Promise.resolve(openResult),
    saveProject: record(false),
    saveProjectAs: record(true),
  };
  return { bridge, saves, suggestedNames };
}

/** Returns an opened project answer for a document. */
function openedOf(documentId: string): BridgeResult<OpenedProject> {
  const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, documentId));
  return { ok: true, value: { state, name: 'Plan', fileName: 'Plan.tasklace', warnings: [] } };
}

/** Waits for pending promise callbacks to run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createProjectFiles', () => {
  it('creates a project under the identifier the main process gives, and saves it a little after a change', async () => {
    const timer = manualTimer();
    const { bridge, saves } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, QUIET, timer);
    const session = await files.create(SAMPLE);
    expect(session.documentId).toBe(TEST_DOCUMENT_ID);
    session.apply({ type: 'updateProject', fields: { name: 'Renamed' } });
    expect(saves).toEqual([]);
    timer.fire();
    await settle();
    expect(saves).toEqual([{ as: false, documentId: TEST_DOCUMENT_ID }]);
  });

  it('saves the current project before opening another, then follows only the new one', async () => {
    const timer = manualTimer();
    const { bridge, saves } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, QUIET, timer);
    const first = await files.create(SAMPLE);
    first.apply({ type: 'updateProject', fields: { name: 'Unsaved' } });
    const opened = await files.open();
    expect(saves).toEqual([{ as: false, documentId: TEST_DOCUMENT_ID }]);
    expect(opened.ok && opened.value.session.documentId).toBe(OTHER_ID);
    expect(opened.ok && opened.value.name).toBe('Plan');
    first.apply({ type: 'updateProject', fields: { name: 'Stale' } });
    await files.flush();
    expect(saves).toHaveLength(1);
  });

  it('asks where to save a project without file, suggesting its name, then saves it to its file', async () => {
    const { bridge, saves, suggestedNames } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    await files.create(SAMPLE);
    await files.save();
    await files.save();
    expect(saves.map((save) => save.as)).toEqual([true, false]);
    await files.importFile('csv');
    await files.save();
    expect(saves.map((save) => save.as)).toEqual([true, false, true]);
    expect(suggestedNames).toEqual([SAMPLE.name, SAMPLE.name]);
  });

  it('reports a failed automatic save, and passes a failed opening through', async () => {
    const timer = manualTimer();
    const failures: unknown[] = [];
    const failed: BridgeResult<never> = { ok: false, error: { code: 'WRITE_FAILED' } };
    const { bridge } = fakeBridge(failed, failed);
    const files = createProjectFiles(
      bridge,
      { failed: (error) => failures.push(error), saveStatus: () => undefined },
      timer,
    );
    const session = await files.create(SAMPLE);
    session.apply({ type: 'updateProject', fields: { name: 'Renamed' } });
    timer.fire();
    await settle();
    expect(failures).toEqual([new FileActionError({ code: 'WRITE_FAILED' })]);
    expect(await files.open()).toEqual(failed);
  });

  it('refuses a state that does not hold a valid shared project', async () => {
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    document.getMap('project').delete('documentId');
    const state = Y.encodeStateAsUpdate(document);
    const { bridge } = fakeBridge({
      ok: true,
      value: { state, name: 'Plan', fileName: 'Plan.tasklace', warnings: [] },
    });
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    expect(await files.open()).toEqual({
      ok: false,
      error: { code: 'INVALID_PROJECT', issues: [{ path: 'documentId', code: 'MISSING_FIELD' }] },
    });
    expect(files.session()).toBeNull();
  });

  it('tells whether the latest changes are saved, a failed save keeping them marked', async () => {
    const timer = manualTimer();
    const statuses: SaveStatus[] = [];
    const listener = {
      failed: () => undefined,
      saveStatus: (status: SaveStatus) => statuses.push(status),
    };
    const { bridge } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, listener, timer);
    const session = await files.create(SAMPLE);
    expect(files.hasFile()).toBe(false);
    session.apply({ type: 'updateProject', fields: { name: 'Renamed' } });
    timer.fire();
    await settle();
    expect(statuses).toEqual(['saved', 'unsaved', 'saving', 'saved']);
    const failing = fakeBridge(openedOf(OTHER_ID), { ok: false, error: { code: 'WRITE_FAILED' } });
    const failedStatuses: SaveStatus[] = [];
    const other = createProjectFiles(
      failing.bridge,
      { failed: () => undefined, saveStatus: (status) => failedStatuses.push(status) },
      manualTimer(),
    );
    await other.create(SAMPLE);
    expect(await other.save()).toEqual({ ok: false, error: { code: 'WRITE_FAILED' } });
    expect(failedStatuses.at(-1)).toBe('failed');
  });
});
