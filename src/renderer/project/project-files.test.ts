import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { createSharedDocument, readDocumentId } from '../../core/shared/shared-document';
import type { SharedSession } from '../../core/shared/shared-session';
import { project, TEST_DOCUMENT_ID, workTask } from '../../core/testing/project-builder';
import type { BridgeResult, OpenedProject, SavedProject } from '../../preload/bridge-contract';
import type { Timer } from './autosave';
import {
  createProjectFiles,
  FileActionError,
  type ProjectBridge,
  type ProjectFiles,
  type ProjectFilesListener,
  type SaveStatus,
} from './project-files';

const OTHER_ID = '00000000-0000-4000-8000-000000000002';
const SAMPLE = project([workTask('a')]);
const SAVED: BridgeResult<SavedProject> = { ok: true, value: { localCopySaved: true } };
const QUIET: ProjectFilesListener = {
  failed: () => undefined,
  saveStatus: () => undefined,
  localCopyFailed: () => undefined,
  fileActionRunning: () => undefined,
};

/** Returns a listener doing nothing but what a test gives it. */
function listening(overrides: Partial<ProjectFilesListener>): ProjectFilesListener {
  return { ...QUIET, ...overrides };
}

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
function fakeBridge(
  openResult: BridgeResult<OpenedProject>,
  saveResult = SAVED,
  opening: Promise<BridgeResult<OpenedProject>> | null = null,
) {
  const saves: { readonly as: boolean; readonly documentId: string | null }[] = [];
  const suggestedNames: string[] = [];
  const events: string[] = [];
  const adopted: string[] = [];
  const adoption = { result: { ok: true, value: null } as BridgeResult<null> };
  const record = (as: boolean) => (state: Uint8Array, name?: string) => {
    const document = new Y.Doc();
    Y.applyUpdate(document, state);
    saves.push({ as, documentId: readDocumentId(document) });
    events.push('save');
    if (name !== undefined) {
      suggestedNames.push(name);
    }
    return Promise.resolve(saveResult);
  };
  const bridge: ProjectBridge = {
    newProject: () => Promise.resolve(TEST_DOCUMENT_ID),
    openProject: () => {
      events.push('open');
      return opening ?? Promise.resolve(openResult);
    },
    openRecentProject: () => Promise.resolve(openResult),
    importProject: () => Promise.resolve(openResult),
    adoptProject: (documentId) => {
      adopted.push(documentId);
      events.push('adopt');
      return Promise.resolve(adoption.result);
    },
    saveProject: record(false),
    saveProjectAs: record(true),
    exportProject: (_kind, _text, name) =>
      Promise.resolve({ ok: true, value: { fileName: `${name}.csv` } }),
  };
  return { bridge, saves, suggestedNames, events, adopted, adoption };
}

/** Returns an opened project answer for a document. */
function openedOf(documentId: string): BridgeResult<OpenedProject> {
  const state = Y.encodeStateAsUpdate(createSharedDocument(SAMPLE, documentId));
  return {
    ok: true,
    value: { state, documentId, fileName: 'Plan.tasklace', warnings: [] },
  };
}

/** Creates the sample project with a file service, failing the test when it is refused. */
async function createdOn(files: ProjectFiles): Promise<SharedSession> {
  const created = await files.create(SAMPLE);
  if (!created.ok) {
    throw new Error(JSON.stringify(created.error));
  }
  return created.value;
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
    const session = await createdOn(files);
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
    const first = await createdOn(files);
    first.apply({ type: 'updateProject', fields: { name: 'Unsaved' } });
    const opened = await files.open();
    expect(saves).toEqual([{ as: false, documentId: TEST_DOCUMENT_ID }]);
    expect(opened.ok && opened.value.session.documentId).toBe(OTHER_ID);
    expect(opened.ok && opened.value.fileName).toBe('Plan.tasklace');
    first.apply({ type: 'updateProject', fields: { name: 'Stale' } });
    await files.flush();
    expect(saves).toHaveLength(1);
  });

  it('asks where to save a project without file, suggesting its name, then saves it to its file', async () => {
    const { bridge, saves, suggestedNames } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    await createdOn(files);
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
      listening({ failed: (error) => failures.push(error) }),
      timer,
    );
    const session = await createdOn(files);
    session.apply({ type: 'updateProject', fields: { name: 'Renamed' } });
    timer.fire();
    await settle();
    expect(failures).toEqual([new FileActionError({ code: 'WRITE_FAILED' })]);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await files.open()).toEqual({ ok: false, error: { code: 'UNSAVED_PROJECT' } });
      expect(logged).toHaveBeenCalledWith(
        'The open project could not be saved before another replaced it:',
        new FileActionError({ code: 'WRITE_FAILED' }),
      );
    } finally {
      logged.mockRestore();
    }
    expect(failures).toHaveLength(1);
    expect(files.session()).toBe(session);
  });

  it('passes a failed opening through when nothing is left to save', async () => {
    const failed: BridgeResult<never> = { ok: false, error: { code: 'READ_FAILED' } };
    const { bridge } = fakeBridge(failed);
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    const session = await createdOn(files);
    expect(await files.open()).toEqual(failed);
    expect(files.session()).toBe(session);
  });

  it('saves the open project before asking the main process for another one', async () => {
    const { bridge, events } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    const first = await createdOn(files);
    first.apply({ type: 'updateProject', fields: { name: 'Unsaved' } });
    await files.open();
    expect(events).toEqual(['adopt', 'save', 'open', 'adopt']);
  });

  it('refuses a second file action while one is running, and accepts one again once it ends', async () => {
    let finish: (result: BridgeResult<OpenedProject>) => void = () => undefined;
    const slow = new Promise<BridgeResult<OpenedProject>>((resolve) => {
      finish = resolve;
    });
    const { bridge, events } = fakeBridge(openedOf(OTHER_ID), SAVED, slow);
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    await createdOn(files);
    const first = files.open();
    await settle();
    const busy = { ok: false, error: { code: 'BUSY' } };
    const before = [...events];
    expect(await files.save()).toEqual(busy);
    expect(await files.saveAs()).toEqual(busy);
    expect(await files.open()).toEqual(busy);
    expect(await files.openRecent(0)).toEqual(busy);
    expect(await files.importFile('csv')).toEqual(busy);
    expect(await files.create(SAMPLE)).toEqual(busy);
    expect(await files.exportFile('csv', 'a', 'Plan')).toEqual(busy);
    expect(events).toEqual(before);
    finish(openedOf(OTHER_ID));
    expect((await first).ok).toBe(true);
    expect(await files.exportFile('csv', 'a', 'Plan')).toEqual({
      ok: true,
      value: { fileName: 'Plan.csv' },
    });
  });

  it('tells when each file action starts and ends, even when it fails, and nothing for a refused one', async () => {
    const running: boolean[] = [];
    let finish: (result: BridgeResult<OpenedProject>) => void = () => undefined;
    const slow = new Promise<BridgeResult<OpenedProject>>((resolve) => {
      finish = resolve;
    });
    const { bridge } = fakeBridge(openedOf(OTHER_ID), SAVED, slow);
    const files = createProjectFiles(
      { ...bridge, saveProjectAs: () => Promise.reject(new Error('broken bridge')) },
      listening({ fileActionRunning: (value) => running.push(value) }),
      manualTimer(),
    );
    await createdOn(files);
    expect(running).toEqual([true, false]);
    const opening = files.open();
    await settle();
    expect(running).toEqual([true, false, true]);
    expect(await files.save()).toEqual({ ok: false, error: { code: 'BUSY' } });
    expect(running).toEqual([true, false, true]);
    finish(openedOf(OTHER_ID));
    await opening;
    expect(running).toEqual([true, false, true, false]);
    await expect(files.saveAs()).rejects.toThrow('broken bridge');
    expect(running).toEqual([true, false, true, false, true, false]);
  });

  it('has nothing to save before a project is open', async () => {
    const { bridge, saves } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    const nothing = { ok: false, error: { code: 'NO_PROJECT' } };
    expect(await files.save()).toEqual(nothing);
    expect(await files.saveAs()).toEqual(nothing);
    expect(files.hasFile()).toBe(false);
    expect(saves).toEqual([]);
  });

  it('keeps the open project when it cannot be saved before a new one is created', async () => {
    const timer = manualTimer();
    const failures: unknown[] = [];
    const { bridge } = fakeBridge(openedOf(OTHER_ID), {
      ok: false,
      error: { code: 'WRITE_FAILED' },
    });
    const files = createProjectFiles(
      bridge,
      listening({ failed: (error) => failures.push(error) }),
      timer,
    );
    const first = await createdOn(files);
    first.apply({ type: 'updateProject', fields: { name: 'Unsaved' } });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await files.create(SAMPLE)).toEqual({
        ok: false,
        error: { code: 'UNSAVED_PROJECT' },
      });
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    expect(files.session()).toBe(first);
    expect(failures).toEqual([]);
  });

  it('refuses to create a project under an identifier the main process got wrong', async () => {
    const { bridge } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(
      { ...bridge, newProject: () => Promise.resolve('not an identifier') },
      QUIET,
      manualTimer(),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await files.create(SAMPLE)).toEqual({ ok: false, error: { code: 'TASK_FAILED' } });
      expect(logged.mock.calls).toEqual([
        ['The main process gave a new project an invalid identifier:', 'not an identifier'],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(files.session()).toBeNull();
  });

  it('refuses an opened state holding another document than the one announced, logging it', async () => {
    const opened = openedOf(OTHER_ID);
    const { bridge } = fakeBridge(
      opened.ok ? { ok: true, value: { ...opened.value, documentId: TEST_DOCUMENT_ID } } : opened,
    );
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await files.open()).toEqual({ ok: false, error: { code: 'INVALID_CONTENT' } });
      expect(logged.mock.calls).toEqual([
        ['The opened project does not hold the document the main process announced.'],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(files.session()).toBeNull();
  });

  it('opens a recent project through the main process, and saves it under a new name on demand', async () => {
    const { bridge, saves } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    const opened = await files.openRecent(2);
    expect(opened.ok && opened.value.session.documentId).toBe(OTHER_ID);
    expect(files.hasFile()).toBe(true);
    expect(await files.saveAs()).toEqual(SAVED);
    expect(saves).toEqual([{ as: true, documentId: OTHER_ID }]);
  });

  it('keeps changes marked unsaved when they come during a save or when the user cancels', async () => {
    const statuses: SaveStatus[] = [];
    let finish: (result: BridgeResult<SavedProject>) => void = () => undefined;
    const { bridge } = fakeBridge(openedOf(OTHER_ID));
    const slow = {
      ...bridge,
      saveProjectAs: () =>
        new Promise<BridgeResult<SavedProject>>((resolve) => {
          finish = resolve;
        }),
    };
    const files = createProjectFiles(
      slow,
      listening({ saveStatus: (status) => statuses.push(status) }),
      manualTimer(),
    );
    const session = await createdOn(files);
    const saving = files.save();
    session.apply({ type: 'updateProject', fields: { name: 'During' } });
    await settle();
    finish(SAVED);
    await saving;
    expect(statuses.at(-1)).toBe('unsaved');
    const cancelling = files.saveAs();
    await settle();
    finish({ ok: false, error: { code: 'CANCELLED' } });
    expect(await cancelling).toEqual({ ok: false, error: { code: 'CANCELLED' } });
    expect(statuses.at(-1)).toBe('unsaved');
    expect(files.hasFile()).toBe(true);
  });

  it('never leaves the save status on saving when the bridge throws', async () => {
    const statuses: SaveStatus[] = [];
    const { bridge } = fakeBridge(openedOf(OTHER_ID));
    const broken = () => Promise.reject(new Error('broken bridge'));
    const throwing = { ...bridge, saveProject: broken, saveProjectAs: broken };
    const files = createProjectFiles(
      throwing,
      listening({ saveStatus: (status) => statuses.push(status) }),
      manualTimer(),
    );
    await createdOn(files);
    await expect(files.save()).rejects.toThrow('broken bridge');
    expect(statuses.at(-1)).toBe('failed');
    expect(await files.exportFile('csv', 'a', 'Plan')).toEqual({
      ok: true,
      value: { fileName: 'Plan.csv' },
    });
  });

  it('accepts a file action again after an opening that could not be decoded', async () => {
    const unreadable = {
      ok: true,
      value: {
        state: Uint8Array.of(255),
        documentId: OTHER_ID,
        fileName: 'Plan.tasklace',
        warnings: [],
      },
    } as const;
    const { bridge } = fakeBridge(unreadable);
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await files.open()).toEqual({ ok: false, error: { code: 'INVALID_CONTENT' } });
    } finally {
      logged.mockRestore();
    }
    expect((await files.create(SAMPLE)).ok).toBe(true);
  });

  it('opens nothing while an automatic save already sent fails, keeping the open project', async () => {
    const timer = manualTimer();
    let fail: (result: BridgeResult<SavedProject>) => void = () => undefined;
    const { bridge, events } = fakeBridge(openedOf(OTHER_ID));
    const pending = {
      ...bridge,
      saveProject: () => {
        events.push('save');
        return new Promise<BridgeResult<SavedProject>>((resolve) => {
          fail = resolve;
        });
      },
    };
    const failures: unknown[] = [];
    const files = createProjectFiles(
      pending,
      listening({ failed: (error) => failures.push(error) }),
      timer,
    );
    const session = await createdOn(files);
    session.apply({ type: 'updateProject', fields: { name: 'Changed' } });
    timer.fire();
    await settle();
    const opening = files.open();
    await settle();
    fail({ ok: false, error: { code: 'WRITE_FAILED' } });
    expect(await opening).toEqual({ ok: false, error: { code: 'UNSAVED_PROJECT' } });
    expect(events).toEqual(['adopt', 'save']);
    expect(files.session()).toBe(session);
    expect(failures).toEqual([new FileActionError({ code: 'WRITE_FAILED' })]);
  });

  it('refuses a state that does not hold a valid shared project', async () => {
    const document = createSharedDocument(SAMPLE, TEST_DOCUMENT_ID);
    document.getMap('project').delete('documentId');
    const state = Y.encodeStateAsUpdate(document);
    const { bridge } = fakeBridge({
      ok: true,
      value: {
        state,
        documentId: TEST_DOCUMENT_ID,
        fileName: 'Plan.tasklace',
        warnings: [],
      },
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
    const listener = listening({ saveStatus: (status) => statuses.push(status) });
    const { bridge } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, listener, timer);
    const session = await createdOn(files);
    expect(files.hasFile()).toBe(false);
    session.apply({ type: 'updateProject', fields: { name: 'Renamed' } });
    timer.fire();
    await settle();
    expect(statuses).toEqual(['saved', 'unsaved', 'saving', 'saved']);
    const failing = fakeBridge(openedOf(OTHER_ID), { ok: false, error: { code: 'WRITE_FAILED' } });
    const failedStatuses: SaveStatus[] = [];
    const other = createProjectFiles(
      failing.bridge,
      listening({ saveStatus: (status) => failedStatuses.push(status) }),
      manualTimer(),
    );
    await createdOn(other);
    expect(await other.save()).toEqual({ ok: false, error: { code: 'WRITE_FAILED' } });
    expect(failedStatuses.at(-1)).toBe('failed');
  });

  it('takes an opened or new project only once the main process adopts its document, keeping the open one otherwise', async () => {
    const { bridge, adopted, adoption, events } = fakeBridge(openedOf(OTHER_ID));
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    const first = await createdOn(files);
    expect(adopted).toEqual([TEST_DOCUMENT_ID]);
    adoption.result = { ok: false, error: { code: 'TASK_FAILED' } };
    expect(await files.open()).toEqual(adoption.result);
    expect(adopted).toEqual([TEST_DOCUMENT_ID, OTHER_ID]);
    expect(events).toEqual(['adopt', 'open', 'adopt']);
    expect(files.session()).toBe(first);
    expect(await files.create(SAMPLE)).toEqual(adoption.result);
    expect(files.session()).toBe(first);
    expect(files.hasFile()).toBe(false);
  });

  it('refuses an opened state that cannot be decoded, logging why, without asking to adopt it', async () => {
    const { bridge, adopted } = fakeBridge({
      ok: true,
      value: {
        state: Uint8Array.from([255, 255, 255]),
        documentId: TEST_DOCUMENT_ID,
        fileName: 'Plan.tasklace',
        warnings: [],
      },
    });
    const files = createProjectFiles(bridge, QUIET, manualTimer());
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await files.open()).toEqual({ ok: false, error: { code: 'INVALID_CONTENT' } });
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
    expect(adopted).toEqual([]);
    expect(files.session()).toBeNull();
  });

  it('tells when a save wrote the file but not its local copy', async () => {
    const copies: number[] = [];
    const { bridge } = fakeBridge(openedOf(OTHER_ID), {
      ok: true,
      value: { localCopySaved: false },
    });
    const files = createProjectFiles(
      bridge,
      listening({ localCopyFailed: () => copies.push(1) }),
      manualTimer(),
    );
    await files.openRecent(0);
    expect(await files.save()).toEqual({ ok: true, value: { localCopySaved: false } });
    expect(copies).toEqual([1]);
  });

  it('sends a manual save only once the automatic save running before it is answered, with the latest state', async () => {
    const timer = manualTimer();
    const answers: ((result: BridgeResult<SavedProject>) => void)[] = [];
    const sentNames: string[] = [];
    const { bridge } = fakeBridge(openedOf(OTHER_ID));
    const slow = {
      ...bridge,
      saveProject: (state: Uint8Array) => {
        const document = new Y.Doc();
        Y.applyUpdate(document, state);
        sentNames.push(String(document.getMap('project').get('name')));
        return new Promise<BridgeResult<SavedProject>>((resolve) => {
          answers.push(resolve);
        });
      },
    };
    const files = createProjectFiles(slow, QUIET, timer);
    const opened = await files.openRecent(0);
    const session = opened.ok ? opened.value.session : null;
    session?.apply({ type: 'updateProject', fields: { name: 'First' } });
    timer.fire();
    await settle();
    const manual = files.save();
    session?.apply({ type: 'updateProject', fields: { name: 'Second' } });
    await settle();
    expect(sentNames).toEqual(['First']);
    answers[0]?.(SAVED);
    await settle();
    expect(sentNames).toEqual(['First', 'Second']);
    answers[1]?.(SAVED);
    expect(await manual).toEqual(SAVED);
  });
});
