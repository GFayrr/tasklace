import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ipcMain as electronIpcMain, type WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES, MAX_PROJECT_NAME_LENGTH } from '../core/limits';
import { failure, success } from '../core/result';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import { isResultOf, type FileTask, type FileTaskResult } from './file-tasks';
import { RefusedRequest } from './ipc-trust';
import {
  forgetWindowProject,
  registerProjectFileHandlers,
  offerSharedProject,
  windowProjectKind,
} from './project-files';
import type { FakeIpcMain } from './testing/fake-electron';
import { isDocumentId, requireDocumentId } from '../core/shared/shared-document';

const dialogs = vi.hoisted(() => ({
  open: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
  save: vi.fn<() => Promise<{ canceled: boolean; filePath: string }>>(),
  message: vi.fn<() => Promise<{ response: number }>>(),
  window: { value: null as object | null },
}));

const recording = vi.hoisted((): { failure: Error | null } => ({ failure: null }));
const examining = vi.hoisted((): { failure: Error | null } => ({ failure: null }));
const moving = vi.hoisted((): { failure: Error | null } => ({ failure: null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    stat: (...values: Parameters<typeof original.stat>) => {
      const failure = examining.failure;
      examining.failure = null;
      return failure === null ? original.stat(...values) : Promise.reject(failure);
    },
    rename: (...values: Parameters<typeof original.rename>) => {
      const failure = moving.failure;
      moving.failure = null;
      return failure === null ? original.rename(...values) : Promise.reject(failure);
    },
  };
});

vi.mock('./recent-projects', async (importOriginal) => {
  const original = await importOriginal<typeof import('./recent-projects')>();
  return {
    ...original,
    recordRecentProject: (...values: Parameters<typeof original.recordRecentProject>) =>
      recording.failure === null
        ? original.recordRecentProject(...values)
        : Promise.reject(recording.failure),
    noteRecentRelay: (...values: Parameters<typeof original.noteRecentRelay>) =>
      recording.failure === null
        ? original.noteRecentRelay(...values)
        : Promise.reject(recording.failure),
  };
});

vi.mock('electron', async () => {
  const fakes = await import('./testing/fake-electron');
  return {
    app: { getSystemLocale: () => 'fr-FR' },
    BrowserWindow: { fromWebContents: () => dialogs.window.value },
    dialog: {
      showOpenDialog: (...values: unknown[]) => dialogs.open(...(values as [])),
      showSaveDialog: (...values: unknown[]) => dialogs.save(...(values as [])),
      showMessageBox: (...values: unknown[]) => dialogs.message(...(values as [])),
    },
    ipcMain: new fakes.FakeIpcMain(),
  };
});

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const STATE = Uint8Array.from([1, 2, 3]);
const DOCUMENT_ID = requireDocumentId('11111111-1111-4111-8111-111111111111');
const OTHER_ID = requireDocumentId('22222222-2222-4222-8222-222222222222');
const LOADED = {
  kind: 'loaded',
  state: STATE,
  documentId: DOCUMENT_ID,
  warnings: [],
  localChanges: null,
} as const;
const SAVED = { kind: 'saved', localCopySaved: true } as const;
const LATER_TURNS = 64;
const tasks: FileTask[] = [];
const runTask = vi.fn<(task: FileTask) => Promise<FileTaskResult>>();
const trusted = vi.fn();
let folder: string;
let userData: string;
const outsideFiles = new Map<number, string>();

const files = registerProjectFileHandlers({
  assertTrusted: trusted,
  runTask: async (task) => {
    tasks.push(task);
    const result = await runTask(task);
    if (!isResultOf(task, result)) {
      throw new Error(`The test answered the task ${task.kind} with a result of another kind.`);
    }
    return result;
  },
  get userDataFolder() {
    return userData;
  },
  takeOutsideFile: (id) => {
    const taken = outsideFiles.get(id) ?? null;
    outsideFiles.delete(id);
    return taken;
  },
});

/** Returns where the local copies of a user data folder are kept. */
function copiesIn(folder: string): string {
  return join(folder, 'local-copies');
}

/** Invokes a file request of the bridge from a page, a refusal becoming a rejected promise as through Electron. */
function request(channel: string, sender: object, ...values: unknown[]): Promise<unknown> {
  return new Promise((resolve) => {
    resolve(ipcMain.invoke(channel, { sender }, ...values));
  });
}

/** Makes the next open dialog choose a path, or cancel when none is given. */
function chooseToOpen(path: string | null): void {
  dialogs.open.mockResolvedValueOnce(
    path === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] },
  );
}

/** Makes the next save dialog choose a path, or cancel when none is given. */
function chooseToSave(path: string | null): void {
  dialogs.save.mockResolvedValueOnce(
    path === null ? { canceled: true, filePath: '' } : { canceled: false, filePath: path },
  );
}

/** Opens a project file in a new page, which adopts it, returning the page. */
async function openedIn(path: string): Promise<object> {
  const sender = {};
  await writeFile(path, 'project');
  chooseToOpen(path);
  runTask.mockResolvedValueOnce(success(LOADED));
  expect(await request(IPC_CHANNELS.openProject, sender)).toMatchObject({ ok: true });
  expect(await request(IPC_CHANNELS.adoptProject, sender, DOCUMENT_ID)).toEqual(success(null));
  return sender;
}

/** Lets the event loop turn a number of times, so that work started meanwhile goes as far as it can. */
async function laterTurns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Runs a request while silencing, and returning, what it logs as errors. */
async function quietly(run: () => Promise<unknown>) {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return { answer: await run(), logged: logged.mock.calls };
  } finally {
    logged.mockRestore();
  }
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'tasklace-files-'));
  userData = join(folder, 'data');
  await mkdir(userData);
  tasks.length = 0;
  dialogs.window.value = null;
  runTask.mockReset();
  runTask.mockResolvedValue(success(SAVED));
  trusted.mockReset();
});

afterEach(async () => {
  dialogs.open.mockReset();
  dialogs.save.mockReset();
  dialogs.message.mockReset();
  await rm(folder, { recursive: true, force: true });
});

describe('opening projects', () => {
  it('opens a chosen project file with the changes its local copy holds, tells its name, and remembers it once the page adopts it', async () => {
    const path = join(folder, 'Thesis.tasklace');
    const sender = {};
    await writeFile(path, 'project');
    chooseToOpen(path);
    runTask.mockResolvedValueOnce(
      success({
        ...LOADED,
        warnings: [{ path: '', code: 'UNKNOWN_COLUMN' }],
        localChanges: Uint8Array.of(4, 5),
      }),
    );
    expect(await request(IPC_CHANNELS.openProject, sender)).toEqual({
      ok: true,
      value: {
        state: STATE,
        documentId: DOCUMENT_ID,
        fileName: 'Thesis.tasklace',
        warnings: [{ path: '', code: 'UNKNOWN_COLUMN' }],
        localChanges: Uint8Array.of(4, 5),
      },
    });
    expect(tasks).toEqual([{ kind: 'openProject', path, localCopyFolder: copiesIn(userData) }]);
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual(success([]));
    expect(await request(IPC_CHANNELS.adoptProject, sender, DOCUMENT_ID)).toEqual(success(null));
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual(
      success([{ name: 'Thesis', folder, relay: null }]),
    );
    expect(trusted).toHaveBeenCalledTimes(4);
  });

  it('opens through the window of the page when it has one', async () => {
    dialogs.window.value = { id: 1 };
    chooseToOpen(null);
    expect(await request(IPC_CHANNELS.openProject, {})).toEqual(failure({ code: 'CANCELLED' }));
    expect(dialogs.open).toHaveBeenCalledWith(dialogs.window.value, expect.anything());
  });

  it('refuses a file too large or gone before reading it, and passes on a failed decoding', async () => {
    const huge = join(folder, 'huge.tasklace');
    await writeFile(huge, '');
    await truncate(huge, MAX_FILE_BYTES + 1);
    chooseToOpen(huge);
    expect(await request(IPC_CHANNELS.openProject, {})).toEqual(failure({ code: 'TOO_LARGE' }));
    chooseToOpen(join(folder, 'gone.tasklace'));
    expect(await request(IPC_CHANNELS.openProject, {})).toEqual(failure({ code: 'READ_FAILED' }));
    const broken = join(folder, 'broken.tasklace');
    await writeFile(broken, 'x');
    chooseToOpen(broken);
    runTask.mockResolvedValueOnce(failure({ code: 'CORRUPTED' }));
    expect(await request(IPC_CHANNELS.openProject, {})).toEqual(failure({ code: 'CORRUPTED' }));
    expect(tasks).toHaveLength(1);
  });

  it('opens a recent project by its position, refusing a position that is not a whole number', async () => {
    const path = join(folder, 'Plan.tasklace');
    await openedIn(path);
    runTask.mockResolvedValueOnce(success(LOADED));
    expect(await request(IPC_CHANNELS.openRecentProject, {}, 0)).toMatchObject({ ok: true });
    expect(tasks.at(-1)).toEqual({
      kind: 'openProject',
      path,
      localCopyFolder: copiesIn(userData),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await request(IPC_CHANNELS.openRecentProject, {}, 2)).toEqual(
        failure({ code: 'READ_FAILED' }),
      );
      expect(logged.mock.calls).toEqual([
        ['The page asked for recent project 2, but only 1 are known.'],
      ]);
    } finally {
      logged.mockRestore();
    }
    await expect(request(IPC_CHANNELS.openRecentProject, {}, 'first')).rejects.toThrow(
      RefusedRequest,
    );
  });

  it('opens the project file Tasklace was started with from outside once, like a file chosen to open', async () => {
    const path = join(folder, 'Outside.tasklace');
    await writeFile(path, 'project');
    outsideFiles.set(7, path);
    runTask.mockResolvedValueOnce(success(LOADED));
    expect(await request(IPC_CHANNELS.openOutsideFile, {}, 7)).toMatchObject({ ok: true });
    expect(tasks).toEqual([{ kind: 'openProject', path, localCopyFolder: copiesIn(userData) }]);
    expect(await quietly(() => request(IPC_CHANNELS.openOutsideFile, {}, 7))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['The page asked to open the file from outside 7, which is not waiting.']],
    });
    await expect(request(IPC_CHANNELS.openOutsideFile, {}, '7')).rejects.toThrow(RefusedRequest);
    await expect(request(IPC_CHANNELS.openOutsideFile, {}, 1.5)).rejects.toThrow(RefusedRequest);
    expect(tasks).toHaveLength(1);
  });

  it('reports a project whose size cannot be read as a failed read, logging why, without decoding it', async () => {
    const path = join(folder, 'Locked.tasklace');
    await writeFile(path, 'project');
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    examining.failure = denied;
    chooseToOpen(path);
    expect(await quietly(() => request(IPC_CHANNELS.openProject, {}))).toEqual({
      answer: failure({ code: 'READ_FAILED' }),
      logged: [['The size of the file could not be read:', denied]],
    });
    expect(runTask).not.toHaveBeenCalled();
  });

  it('opens a project even when the recent list cannot be read or written, logging why and reporting the unreadable list', async () => {
    await mkdir(join(userData, 'recent-projects.json'));
    const opened = await quietly(() => openedIn(join(folder, 'Plan.tasklace')));
    expect(opened.logged).toEqual([
      ['The recent projects could not be recorded:', expect.objectContaining({ code: 'EISDIR' })],
    ]);
    const listed = await quietly(() => request(IPC_CHANNELS.recentProjects, {}));
    expect(listed.answer).toEqual(failure({ code: 'READ_FAILED' }));
    expect(listed.logged).toEqual([
      ['The recent projects could not be read:', expect.objectContaining({ code: 'EISDIR' })],
    ]);
    const reopened = await quietly(() => request(IPC_CHANNELS.openRecentProject, {}, 0));
    expect(reopened.answer).toEqual(failure({ code: 'READ_FAILED' }));
    expect(reopened.logged).toEqual([
      ['The recent projects could not be read:', expect.objectContaining({ code: 'EISDIR' })],
    ]);
  });

  it('keeps an adoption and a save that happened when recording the recent project fails unexpectedly, logging why', async () => {
    const broken = new TypeError('recent list broken');
    recording.failure = broken;
    try {
      let sender: object = {};
      const opened = await quietly(async () => {
        sender = await openedIn(join(folder, 'Plan.tasklace'));
      });
      expect(opened.logged).toEqual([['The recent projects could not be recorded:', broken]]);
      chooseToSave(join(folder, 'Copy.tasklace'));
      const saved = await quietly(() => request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'Copy'));
      expect(saved).toEqual({
        answer: success({ localCopySaved: true }),
        logged: [['The recent projects could not be recorded:', broken]],
      });
      await request(IPC_CHANNELS.saveProject, sender, STATE);
      expect(tasks.at(-1)).toMatchObject({ path: join(folder, 'Copy.tasklace') });
    } finally {
      recording.failure = null;
    }
  });

  it('turns an unexpected failure into a task failure, logging it, but lets a refusal through', async () => {
    const path = join(folder, 'Plan.tasklace');
    await writeFile(path, 'project');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      chooseToOpen(path);
      runTask.mockRejectedValueOnce(new Error('worker gone'));
      expect(await request(IPC_CHANNELS.openProject, {})).toEqual(failure({ code: 'TASK_FAILED' }));
      expect(logged).toHaveBeenCalledWith(
        `The request ${IPC_CHANNELS.openProject} failed:`,
        new Error('worker gone'),
      );
      logged.mockClear();
      chooseToOpen(path);
      runTask.mockRejectedValueOnce('broken');
      await expect(request(IPC_CHANNELS.openProject, {})).rejects.toBe('broken');
      await expect(request(IPC_CHANNELS.openRecentProject, {}, -1)).rejects.toThrow(RefusedRequest);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it.each([
    ['saveProject', (sender: object) => request(IPC_CHANNELS.saveProject, sender, STATE)],
    [
      'saveProjectAs',
      (sender: object) => {
        chooseToSave(join(folder, 'Other.tasklace'));
        return request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'Plan');
      },
    ],
    [
      'importProject',
      (sender: object) => {
        chooseToOpen(join(folder, 'Old.tasklace'));
        return request(IPC_CHANNELS.importProject, sender, 'json');
      },
    ],
    ['openRecentProject', (sender: object) => request(IPC_CHANNELS.openRecentProject, sender, 0)],
  ] as const)('turns an unexpected failure of %s into a task failure', async (_name, send) => {
    const sender = await openedIn(join(folder, 'Old.tasklace'));
    runTask.mockRejectedValueOnce(new Error('worker gone'));
    const failed = await quietly(() => send(sender));
    expect(failed.answer).toEqual(failure({ code: 'TASK_FAILED' }));
    expect(failed.logged).toHaveLength(1);
  });

  it('turns an unexpected failure of an export into a task failure', async () => {
    dialogs.save.mockRejectedValueOnce(new Error('dialog gone'));
    const failed = await quietly(() =>
      request(IPC_CHANNELS.exportProject, {}, 'json', '{}', 'Plan'),
    );
    expect(failed.answer).toEqual(failure({ code: 'TASK_FAILED' }));
  });

  it('checks that every request comes from the application before answering it', async () => {
    trusted.mockImplementation(() => {
      throw new RefusedRequest('not the application');
    });
    const requests: [string, ...unknown[]][] = [
      [IPC_CHANNELS.regionalFormat],
      [IPC_CHANNELS.newProject],
      [IPC_CHANNELS.adoptProject, DOCUMENT_ID],
      [IPC_CHANNELS.openProject],
      [IPC_CHANNELS.openRecentProject, 0],
      [IPC_CHANNELS.openOutsideFile, 1],
      [IPC_CHANNELS.recentProjects],
      [IPC_CHANNELS.importProject, 'json'],
      [IPC_CHANNELS.saveProject, STATE],
      [IPC_CHANNELS.saveProjectAs, STATE, 'Plan'],
      [IPC_CHANNELS.exportProject, 'json', '{}', 'Plan'],
      [IPC_CHANNELS.keepOwnChanges, STATE, 'Plan'],
      [IPC_CHANNELS.openKeptChanges],
      [IPC_CHANNELS.setLocalCopyAside, DOCUMENT_ID],
    ];
    for (const [channel, ...values] of requests) {
      await expect(request(channel, {}, ...values)).rejects.toThrow(RefusedRequest);
    }
    expect(trusted).toHaveBeenCalledTimes(requests.length);
    const handled = Object.values(IPC_CHANNELS).filter((channel) => ipcMain.handlers.has(channel));
    expect(handled.sort()).toEqual(requests.map(([channel]) => channel).sort());
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(dialogs.save).not.toHaveBeenCalled();
    expect(tasks).toEqual([]);
  });

  it('answers nothing to a page that is not the application', async () => {
    trusted.mockImplementation(() => {
      throw new RefusedRequest('not the application');
    });
    await expect(request(IPC_CHANNELS.openProject, {})).rejects.toThrow(RefusedRequest);
    expect(dialogs.open).not.toHaveBeenCalled();
  });
});

describe('adopting projects', () => {
  it('keeps the project of a window until its page adopts the one it was offered', async () => {
    const sender = await openedIn(join(folder, 'Old.tasklace'));
    const next = join(folder, 'Next.tasklace');
    await writeFile(next, 'project');
    chooseToOpen(next);
    runTask.mockResolvedValueOnce(success({ ...LOADED, documentId: OTHER_ID }));
    expect(await request(IPC_CHANNELS.openProject, sender)).toMatchObject({ ok: true });
    await request(IPC_CHANNELS.saveProject, sender, STATE);
    expect(tasks.at(-1)).toMatchObject({
      path: join(folder, 'Old.tasklace'),
      documentId: DOCUMENT_ID,
    });
    expect(await request(IPC_CHANNELS.adoptProject, sender, OTHER_ID)).toEqual(success(null));
    await request(IPC_CHANNELS.saveProject, sender, STATE);
    expect(tasks.at(-1)).toMatchObject({ path: next, documentId: OTHER_ID });
  });

  it('refuses to adopt a document that was not offered, or twice, and refuses an identifier that is not one', async () => {
    const sender = {};
    const notOffered = {
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['The page adopted a project that was not offered to it.']],
    };
    expect(await quietly(() => request(IPC_CHANNELS.adoptProject, sender, DOCUMENT_ID))).toEqual(
      notOffered,
    );
    const documentId = await request(IPC_CHANNELS.newProject, sender);
    expect(await quietly(() => request(IPC_CHANNELS.adoptProject, sender, OTHER_ID))).toEqual(
      notOffered,
    );
    expect(await quietly(() => request(IPC_CHANNELS.saveProject, sender, STATE))).toEqual({
      answer: failure({ code: 'NO_PROJECT' }),
      logged: [['A page asked to save a project its window does not hold.']],
    });
    expect(await request(IPC_CHANNELS.adoptProject, sender, documentId)).toEqual(success(null));
    expect(await quietly(() => request(IPC_CHANNELS.adoptProject, sender, documentId))).toEqual(
      notOffered,
    );
    await expect(request(IPC_CHANNELS.adoptProject, sender, '../escape')).rejects.toThrow(
      RefusedRequest,
    );
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual(success([]));
  });
});

describe('new and imported projects', () => {
  it('gives a new project a fresh identifier and keeps it in its local copy only', async () => {
    const sender = {};
    const documentId = await request(IPC_CHANNELS.newProject, sender);
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await request(IPC_CHANNELS.adoptProject, sender, documentId)).toEqual(success(null));
    expect(await request(IPC_CHANNELS.saveProject, sender, STATE)).toEqual(
      success({ localCopySaved: true }),
    );
    expect(tasks).toEqual([
      {
        kind: 'saveProject',
        path: null,
        state: STATE,
        documentId,
        localCopyFolder: join(userData, 'local-copies'),
        savedAt: expect.any(Date) as Date,
      },
    ]);
  });

  it('imports a JSON or CSV file into a new document named after the file, kept without file once adopted', async () => {
    const json = join(folder, 'Launch.json');
    const csv = join(folder, 'Budget.csv');
    const sender = {};
    await writeFile(json, '{}');
    await writeFile(csv, 'Name\n');
    runTask.mockResolvedValueOnce(success(LOADED));
    chooseToOpen(json);
    expect(await request(IPC_CHANNELS.importProject, sender, 'json')).toMatchObject({
      ok: true,
      value: { fileName: 'Launch.json' },
    });
    const imported = tasks.at(-1);
    const documentId = imported?.kind === 'importJson' ? imported.documentId : '';
    expect(await request(IPC_CHANNELS.adoptProject, sender, documentId)).toEqual(success(null));
    await request(IPC_CHANNELS.saveProject, sender, STATE);
    expect(tasks.at(-1)).toMatchObject({ kind: 'saveProject', path: null, documentId });
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual(success([]));
    runTask.mockResolvedValue(success(LOADED));
    chooseToOpen(csv);
    await request(IPC_CHANNELS.importProject, {}, 'csv');
    expect([tasks[0], tasks.at(-1)]).toMatchObject([
      {
        kind: 'importJson',
        path: json,
        naming: { untitled: 'Untitled project', fromFile: 'Launch' },
      },
      {
        kind: 'importCsv',
        path: csv,
        options: { projectName: 'Budget', format: { listSeparator: ';' } },
      },
    ]);
  });

  it('refuses an unknown kind, and stops when the user cancels, the file is too large or fails', async () => {
    await expect(request(IPC_CHANNELS.importProject, {}, 'xml')).rejects.toThrow(RefusedRequest);
    chooseToOpen(null);
    expect(await request(IPC_CHANNELS.importProject, {}, 'csv')).toEqual(
      failure({ code: 'CANCELLED' }),
    );
    chooseToOpen(join(folder, 'gone.csv'));
    expect(await request(IPC_CHANNELS.importProject, {}, 'csv')).toEqual(
      failure({ code: 'READ_FAILED' }),
    );
    const csv = join(folder, 'bad.csv');
    await writeFile(csv, 'x');
    chooseToOpen(csv);
    runTask.mockResolvedValueOnce(failure({ code: 'INVALID_IMPORT', issues: [] }));
    expect(await request(IPC_CHANNELS.importProject, {}, 'csv')).toEqual(
      failure({ code: 'INVALID_IMPORT', issues: [] }),
    );
  });
});

describe('saving projects', () => {
  it('refuses to save for a page without project, or a state that is not bytes', async () => {
    expect(await quietly(() => request(IPC_CHANNELS.saveProject, {}, STATE))).toEqual({
      answer: failure({ code: 'NO_PROJECT' }),
      logged: [['A page asked to save a project its window does not hold.']],
    });
    await expect(request(IPC_CHANNELS.saveProject, {}, 'state')).rejects.toThrow(RefusedRequest);
    await expect(request(IPC_CHANNELS.saveProjectAs, {}, STATE, 42)).rejects.toThrow(
      RefusedRequest,
    );
  });

  it('saves as a chosen file with its extension, suggesting the project name next to the current file', async () => {
    const sender = await openedIn(join(folder, 'Old.tasklace'));
    chooseToSave(join(folder, 'New'));
    expect(await request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'New plan')).toEqual(
      success({ localCopySaved: true }),
    );
    expect(dialogs.save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: join(folder, 'New plan.tasklace') }),
    );
    expect(tasks.at(-1)).toMatchObject({ kind: 'saveProject', path: join(folder, 'New.tasklace') });
    await request(IPC_CHANNELS.saveProject, sender, STATE);
    expect(tasks.at(-1)).toMatchObject({ path: join(folder, 'New.tasklace') });
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual(
      success([
        { name: 'New', folder, relay: null },
        { name: 'Old', folder, relay: null },
      ]),
    );
  });

  it('asks before replacing a file the added extension leads to, through the window when there is one', async () => {
    const sender = await openedIn(join(folder, 'Old.tasklace'));
    await writeFile(join(folder, 'Taken.tasklace'), 'other');
    dialogs.window.value = { id: 2 };
    chooseToSave(join(folder, 'Taken'));
    dialogs.message.mockResolvedValueOnce({ response: 1 });
    expect(await request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'Plan')).toEqual(
      failure({ code: 'CANCELLED' }),
    );
    expect(dialogs.message.mock.calls).toEqual([
      [
        dialogs.window.value,
        {
          type: 'question',
          buttons: ['Replace', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: 'Taken.tasklace already exists. Do you want to replace it?',
        },
      ],
    ]);
    dialogs.window.value = null;
    chooseToSave(join(folder, 'Taken'));
    dialogs.message.mockResolvedValueOnce({ response: 0 });
    expect(await request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'Plan')).toEqual(
      success({ localCopySaved: true }),
    );
    expect(dialogs.message.mock.calls.at(-1)).toEqual([
      {
        type: 'question',
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Taken.tasklace already exists. Do you want to replace it?',
      },
    ]);
  });

  it('keeps the new file of a save whose local copy failed, telling that the copy is missing', async () => {
    const sender = await openedIn(join(folder, 'Old.tasklace'));
    chooseToSave(join(folder, 'Kept.tasklace'));
    runTask.mockResolvedValueOnce(success({ kind: 'saved', localCopySaved: false }));
    expect(await request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'Plan')).toEqual(
      success({ localCopySaved: false }),
    );
    await request(IPC_CHANNELS.saveProject, sender, STATE);
    expect(tasks.at(-1)).toMatchObject({ path: join(folder, 'Kept.tasklace') });
  });

  it('sends the saves of every window one after the other, so that two never update the local copy index at once', async () => {
    const first = await openedIn(join(folder, 'First.tasklace'));
    const second = await openedIn(join(folder, 'Second.tasklace'));
    let finish: (result: FileTaskResult) => void = () => undefined;
    runTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const savingFirst = request(IPC_CHANNELS.saveProject, first, STATE);
    const savingSecond = request(IPC_CHANNELS.saveProject, second, STATE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    /** Lists the paths of the save tasks run so far. */
    const saves = () => tasks.flatMap((task) => (task.kind === 'saveProject' ? [task.path] : []));
    expect(saves()).toHaveLength(1);
    finish(success(SAVED));
    expect(await savingFirst).toEqual(success({ localCopySaved: true }));
    expect(await savingSecond).toEqual(success({ localCopySaved: true }));
    expect(saves()).toEqual([join(folder, 'First.tasklace'), join(folder, 'Second.tasklace')]);
  });

  it('keeps the old file when the new one could not be written, or when the user cancels', async () => {
    const sender = await openedIn(join(folder, 'Old.tasklace'));
    chooseToSave(join(folder, 'Lost.tasklace'));
    runTask.mockResolvedValueOnce(failure({ code: 'WRITE_FAILED' }));
    await request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'Plan');
    chooseToSave(null);
    expect(await request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'Plan')).toEqual(
      failure({ code: 'CANCELLED' }),
    );
    dialogs.save.mockResolvedValueOnce({ canceled: false, filePath: '' });
    expect(await request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'Plan')).toEqual(
      failure({ code: 'CANCELLED' }),
    );
    await request(IPC_CHANNELS.saveProject, sender, STATE);
    expect(tasks.at(-1)).toMatchObject({ path: join(folder, 'Old.tasklace') });
  });
});

describe('exporting projects', () => {
  it('writes an export where the user chooses and tells the name of the file', async () => {
    chooseToSave(join(folder, 'plan'));
    expect(await request(IPC_CHANNELS.exportProject, {}, 'json', '{}', 'Plan')).toEqual(
      success({ fileName: 'plan.json' }),
    );
    expect(await readFile(join(folder, 'plan.json'), 'utf8')).toBe('{}');
  });

  it('counts a file that cannot be examined as absent, warning, and writes the export', async () => {
    chooseToSave(join(folder, 'plan'));
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    examining.failure = denied;
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await request(IPC_CHANNELS.exportProject, {}, 'json', '{}', 'Plan')).toEqual(
        success({ fileName: 'plan.json' }),
      );
      expect(warned.mock.calls).toEqual([
        ['A file could not be examined, so it counts as absent:', denied],
      ]);
    } finally {
      warned.mockRestore();
    }
    expect(await readFile(join(folder, 'plan.json'), 'utf8')).toBe('{}');
  });

  it('refuses an invalid request, and reports a canceled or failed export', async () => {
    await expect(request(IPC_CHANNELS.exportProject, {}, 'xml', '{}', 'Plan')).rejects.toThrow(
      RefusedRequest,
    );
    await expect(request(IPC_CHANNELS.exportProject, {}, 'json', 42, 'Plan')).rejects.toThrow(
      RefusedRequest,
    );
    await expect(request(IPC_CHANNELS.exportProject, {}, 'json', '{}', null)).rejects.toThrow(
      RefusedRequest,
    );
    chooseToSave(null);
    expect(await request(IPC_CHANNELS.exportProject, {}, 'csv', 'a', 'Plan')).toEqual(
      failure({ code: 'CANCELLED' }),
    );
    chooseToSave(join(folder, 'missing', 'plan.csv'));
    const failed = await quietly(() => request(IPC_CHANNELS.exportProject, {}, 'csv', 'a', 'Plan'));
    expect(failed.answer).toEqual(failure({ code: 'WRITE_FAILED' }));
    expect(failed.logged).toEqual([
      ['The export could not be written:', expect.objectContaining({ code: 'ENOENT' })],
    ]);
  });
});

describe('regional format', () => {
  it('gives the regional format of the system for CSV exchange', async () => {
    expect(await request(IPC_CHANNELS.regionalFormat, {})).toMatchObject({
      listSeparator: ';',
      dateOrder: 'dayMonthYear',
    });
  });
});

describe('the kind of project a window holds', () => {
  it('is none before any adoption, with a file once a file is adopted, and without file for a new project', async () => {
    const empty = {};
    expect(windowProjectKind(empty as WebContents)).toBe('none');
    const opened = await openedIn(join(folder, 'Plan.tasklace'));
    expect(windowProjectKind(opened as WebContents)).toBe('withFile');
    const fresh = {};
    const documentId = await request(IPC_CHANNELS.newProject, fresh);
    expect(windowProjectKind(fresh as WebContents)).toBe('none');
    await request(IPC_CHANNELS.adoptProject, fresh, documentId);
    expect(windowProjectKind(fresh as WebContents)).toBe('withoutFile');
  });

  it('is a joined plan once the page adopts the shared plan it joined', async () => {
    const joined = {};
    const documentId = requireDocumentId('7d3c1f9e-2b4a-4c6d-8e0f-1a2b3c4d5e6f');
    offerSharedProject(joined as WebContents, {
      kind: 'loaded',
      state: Uint8Array.of(1),
      documentId,
      warnings: [],
      localChanges: null,
    });
    expect(windowProjectKind(joined as WebContents)).toBe('none');
    await request(IPC_CHANNELS.adoptProject, joined, documentId);
    expect(windowProjectKind(joined as WebContents)).toBe('joinedPlan');
  });

  it('is none again once the page reloads, and the project it was offered can no longer be adopted', async () => {
    const opened = await openedIn(join(folder, 'Plan.tasklace'));
    forgetWindowProject(opened as WebContents);
    expect(windowProjectKind(opened as WebContents)).toBe('none');
    const fresh = {};
    const documentId = await request(IPC_CHANNELS.newProject, fresh);
    forgetWindowProject(fresh as WebContents);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await request(IPC_CHANNELS.adoptProject, fresh, documentId)).toEqual({
        ok: false,
        error: { code: 'TASK_FAILED' },
      });
      expect(logged.mock.calls).toEqual([
        ['The page adopted a project that was not offered to it.'],
      ]);
    } finally {
      logged.mockRestore();
    }
    expect(windowProjectKind(fresh as WebContents)).toBe('none');
  });
});

describe('keeping the changes a person could not share', () => {
  const KEPT = 'kept-plans';

  /** Returns the last task sent to keep changes, failing the test when there is none. */
  const keptTask = (): Extract<FileTask, { kind: 'keepSharedCopy' }> => {
    const task = tasks.at(-1);
    if (task?.kind !== 'keepSharedCopy') {
      throw new Error('No changes were kept.');
    }
    return task;
  };

  it('refuses a page without project, a state that is not bytes and a plan name that is too long', async () => {
    expect(await quietly(() => request(IPC_CHANNELS.keepOwnChanges, {}, STATE, 'Thesis'))).toEqual({
      answer: failure({ code: 'NO_PROJECT' }),
      logged: [['A page asked to keep its changes without holding a project.']],
    });
    await expect(request(IPC_CHANNELS.keepOwnChanges, {}, 'state', 'Thesis')).rejects.toThrow(
      RefusedRequest,
    );
    await expect(
      request(IPC_CHANNELS.keepOwnChanges, {}, STATE, 'a'.repeat(MAX_PROJECT_NAME_LENGTH + 1)),
    ).rejects.toThrow(RefusedRequest);
  });

  it('keeps the plan under a new identifier in a folder of this computer, first among the recent projects, and opens it again', async () => {
    const sender = await openedIn(join(folder, 'Thesis.tasklace'));
    const keptAt = new Date(Date.UTC(2026, 9, 22, 11, 5, 30));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(keptAt);
    const kept = await request(IPC_CHANNELS.keepOwnChanges, sender, STATE, 'Thesis').finally(() => {
      vi.useRealTimers();
    });
    expect(kept).toEqual(success({ localCopySaved: true }));
    const task = keptTask();
    const path = join(userData, KEPT, 'Thesis (my changes).tasklace');
    expect([
      task.state,
      isDocumentId(task.documentId) && task.documentId !== DOCUMENT_ID,
      task.nameTemplate,
      task.path,
      task.localCopyFolder,
      task.savedAt,
    ]).toEqual([STATE, true, '{plan} (my changes)', path, join(userData, 'local-copies'), keptAt]);
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual(
      success([
        { name: 'Thesis (my changes)', folder: 'Kept on this computer', relay: null },
        { name: 'Thesis', folder, relay: null },
      ]),
    );
    await writeFile(path, 'project');
    runTask.mockResolvedValueOnce(success(LOADED));
    expect(await request(IPC_CHANNELS.openKeptChanges, sender)).toEqual(
      success({
        state: STATE,
        documentId: DOCUMENT_ID,
        fileName: 'Thesis (my changes).tasklace',
        warnings: [],
        localChanges: null,
      }),
    );
    expect(tasks.at(-1)).toEqual({
      kind: 'openProject',
      path,
      localCopyFolder: copiesIn(userData),
    });
  });

  it('gives two windows keeping their changes at once two files, each choosing its name once the other is written', async () => {
    const first = await openedIn(join(folder, 'Thesis.tasklace'));
    const second = await openedIn(join(folder, 'Thesis copy.tasklace'));
    runTask.mockImplementation(async (task) => {
      if (task.kind === 'keepSharedCopy') {
        await laterTurns(LATER_TURNS);
        await writeFile(task.path, 'kept');
      }
      return success(SAVED);
    });
    await Promise.all([
      request(IPC_CHANNELS.keepOwnChanges, first, STATE, 'Thesis'),
      request(IPC_CHANNELS.keepOwnChanges, second, STATE, 'Thesis'),
    ]);
    const kept = join(userData, KEPT);
    expect(tasks.flatMap((task) => (task.kind === 'keepSharedCopy' ? [task.path] : []))).toEqual([
      join(kept, 'Thesis (my changes).tasklace'),
      join(kept, 'Thesis (my changes) 2.tasklace'),
    ]);
  });

  it('numbers the name of a file already kept, then names it after an identifier once every number is taken', async () => {
    const sender = await openedIn(join(folder, 'Thesis.tasklace'));
    const kept = join(userData, KEPT);
    await mkdir(kept);
    await writeFile(join(kept, 'Thesis (my changes).tasklace'), 'taken');
    await request(IPC_CHANNELS.keepOwnChanges, sender, STATE, 'Thesis');
    expect(keptTask().path).toBe(join(kept, 'Thesis (my changes) 2.tasklace'));
    for (let number = 2; number <= 64; number += 1) {
      await writeFile(join(kept, `Thesis (my changes) ${String(number)}.tasklace`), 'taken');
    }
    await request(IPC_CHANNELS.keepOwnChanges, sender, STATE, 'Thesis');
    const named = keptTask().path;
    expect([named.startsWith(kept), isDocumentId(basename(named, '.tasklace'))]).toEqual([
      true,
      true,
    ]);
  });

  it('gives back a failure of the task, keeping nothing to open nor to list', async () => {
    const sender = await openedIn(join(folder, 'Thesis.tasklace'));
    runTask.mockResolvedValueOnce(failure({ code: 'WRITE_FAILED' }));
    expect(await request(IPC_CHANNELS.keepOwnChanges, sender, STATE, 'Thesis')).toEqual(
      failure({ code: 'WRITE_FAILED' }),
    );
    expect(await quietly(() => request(IPC_CHANNELS.openKeptChanges, sender))).toEqual({
      answer: failure({ code: 'TASK_FAILED' }),
      logged: [['A page asked to open the changes it kept, but its window kept none.']],
    });
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual(
      success([{ name: 'Thesis', folder, relay: null }]),
    );
  });

  it('reports a folder that cannot be created as a failed write, logging why', async () => {
    const sender = await openedIn(join(folder, 'Thesis.tasklace'));
    await writeFile(join(userData, KEPT), 'a file where the folder should be');
    const { answer, logged } = await quietly(() =>
      request(IPC_CHANNELS.keepOwnChanges, sender, STATE, 'Thesis'),
    );
    expect([answer, logged.map((call): unknown => call[0]), tasks.at(-1)?.kind]).toEqual([
      failure({ code: 'WRITE_FAILED' }),
      ['The folder of the kept changes could not be created:'],
      'openProject',
    ]);
  });
});

describe('setting aside the local copy of an opened file', () => {
  const NOW = new Date(Date.UTC(2026, 9, 22, 9, 30, 15, 250));
  const ASIDE_NAME = `${DOCUMENT_ID}.set-aside-2026-10-22T09-30-15-250Z.tasklace`;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Offers a file to a new page as the open dialog would, without adopting it, returning the page and the path. */
  async function offeredFile(): Promise<{ readonly sender: object; readonly path: string }> {
    const sender = {};
    const path = join(folder, 'Thesis.tasklace');
    await writeFile(path, 'project');
    chooseToOpen(path);
    runTask.mockResolvedValueOnce(success(LOADED));
    await request(IPC_CHANNELS.openProject, sender);
    return { sender, path };
  }

  /** Writes a local copy of the sample document. */
  async function writeCopy(): Promise<void> {
    await mkdir(copiesIn(userData), { recursive: true });
    await writeFile(join(copiesIn(userData), `${DOCUMENT_ID}.tasklace`), 'copy');
  }

  it('moves the copy of a file offered or adopted under a name holding the time, noting it in the log', async () => {
    const { sender, path } = await offeredFile();
    await writeCopy();
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const offered = await request(IPC_CHANNELS.setLocalCopyAside, sender, DOCUMENT_ID);
    await request(IPC_CHANNELS.adoptProject, sender, DOCUMENT_ID);
    const adopted = await request(IPC_CHANNELS.setLocalCopyAside, sender, DOCUMENT_ID);
    expect([
      offered,
      adopted,
      await readdir(copiesIn(userData)),
      await readFile(join(copiesIn(userData), ASIDE_NAME), 'utf8'),
      warnings.mock.calls,
    ]).toEqual([
      success(null),
      success(null),
      [ASIDE_NAME],
      'copy',
      [
        [
          `The changes kept on this computer for ${path} were not added to it and were set aside as ${join(copiesIn(userData), ASIDE_NAME)}.`,
        ],
        [
          `The changes kept on this computer for ${path} were not added to it and were set aside as nothing, the copy being gone.`,
        ],
      ],
    ]);
  });

  it('refuses a document its window was not given, a project without file, and an identifier that is none', async () => {
    const { sender } = await offeredFile();
    const unsaved = {};
    const newId = await request(IPC_CHANNELS.newProject, unsaved);
    const other = await quietly(() => request(IPC_CHANNELS.setLocalCopyAside, sender, OTHER_ID));
    const withoutFile = await quietly(() =>
      request(IPC_CHANNELS.setLocalCopyAside, unsaved, newId),
    );
    expect([other, withoutFile]).toEqual([
      {
        answer: failure({ code: 'TASK_FAILED' }),
        logged: [['The page set aside the local copy of a file its window was not given.']],
      },
      {
        answer: failure({ code: 'TASK_FAILED' }),
        logged: [['The page set aside the local copy of a file its window was not given.']],
      },
    ]);
    await expect(request(IPC_CHANNELS.setLocalCopyAside, sender, 'nope')).rejects.toThrow(
      RefusedRequest,
    );
  });

  it('reports a copy the system cannot move as a failed write, logging why', async () => {
    const { sender, path } = await offeredFile();
    await writeCopy();
    const denied = Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    moving.failure = denied;
    const { answer, logged } = await quietly(() =>
      request(IPC_CHANNELS.setLocalCopyAside, sender, DOCUMENT_ID),
    );
    expect([answer, logged, await readdir(copiesIn(userData))]).toEqual([
      failure({ code: 'WRITE_FAILED' }),
      [[`The local copy of ${path} could not be set aside:`, denied]],
      [`${DOCUMENT_ID}.tasklace`],
    ]);
  });
});

describe('plans shared through a relay', () => {
  const SHARED = 'shared-plans';
  const RELAY = 'relay.example';
  const PLAN = {
    kind: 'relayPlan',
    state: STATE,
    documentId: DOCUMENT_ID,
    name: 'Thesis',
  } as const;

  it('offers a joined plan as a file of its own named after the plan, listed first with its relay once adopted', async () => {
    const sender = {};
    const opened = await files.offerRelayPlan(sender as WebContents, PLAN, RELAY);
    const path = join(userData, SHARED, 'Thesis.tasklace');
    const task = tasks.at(-1);
    expect([
      opened,
      task?.kind === 'saveProject' && [
        task.path,
        task.state,
        task.documentId,
        task.localCopyFolder,
        task.savedAt instanceof Date,
      ],
    ]).toEqual([
      {
        state: STATE,
        documentId: DOCUMENT_ID,
        fileName: 'Thesis.tasklace',
        warnings: [],
        localChanges: null,
      },
      [path, STATE, DOCUMENT_ID, copiesIn(userData), true],
    ]);
    expect(await request(IPC_CHANNELS.adoptProject, sender, DOCUMENT_ID)).toEqual(success(null));
    expect([
      windowProjectKind(sender as WebContents),
      await request(IPC_CHANNELS.recentProjects, {}),
    ]).toEqual([
      'withFile',
      success([{ name: 'Thesis', folder: 'Kept on this computer', relay: RELAY }]),
    ]);
  });

  it('names a second joined plan of the same name apart from the first', async () => {
    await mkdir(join(userData, SHARED));
    await writeFile(join(userData, SHARED, 'Thesis.tasklace'), 'project');
    const opened = await files.offerRelayPlan({} as WebContents, PLAN, RELAY);
    expect([opened.fileName, tasks.at(-1)]).toMatchObject([
      'Thesis 2.tasklace',
      { kind: 'saveProject', path: join(userData, SHARED, 'Thesis 2.tasklace') },
    ]);
  });

  it('writes a plan joined again into the file this computer keeps for it, and a plan last saved elsewhere into a file of its own', async () => {
    const kept = join(userData, SHARED, 'Old name.tasklace');
    /** Notes where the plan was last saved, as the local copy index does. */
    const lastSavedIn = async (path: string): Promise<void> => {
      await mkdir(copiesIn(userData), { recursive: true });
      await writeFile(
        join(copiesIn(userData), 'index.json'),
        JSON.stringify({
          version: 1,
          copies: { [DOCUMENT_ID]: { path, savedAt: '2026-10-29T10:00:00.000Z' } },
        }),
      );
    };
    await lastSavedIn(kept);
    const again = await files.offerRelayPlan({} as WebContents, PLAN, RELAY);
    const intoKept = tasks.at(-1);
    await lastSavedIn(join(folder, 'Thesis.tasklace'));
    const elsewhere = await files.offerRelayPlan({} as WebContents, PLAN, RELAY);
    expect([again.fileName, intoKept, elsewhere.fileName, tasks.at(-1)]).toMatchObject([
      'Old name.tasklace',
      { kind: 'saveProject', path: kept },
      'Thesis.tasklace',
      { kind: 'saveProject', path: join(userData, SHARED, 'Thesis.tasklace') },
    ]);
  });

  it('offers a joined plan without a file when its file cannot be written, logging why', async () => {
    const sender = {};
    runTask.mockResolvedValueOnce(failure({ code: 'WRITE_FAILED' }));
    const { answer, logged } = await quietly(() =>
      files.offerRelayPlan(sender as WebContents, PLAN, RELAY),
    );
    expect(await request(IPC_CHANNELS.adoptProject, sender, DOCUMENT_ID)).toEqual(success(null));
    expect([
      answer,
      logged,
      windowProjectKind(sender as WebContents),
      await request(IPC_CHANNELS.recentProjects, {}),
    ]).toEqual([
      { state: STATE, documentId: DOCUMENT_ID, fileName: '', warnings: [], localChanges: null },
      [
        [
          `The plan joined through a relay could not be kept as ${join(userData, SHARED, 'Thesis.tasklace')}: WRITE_FAILED.`,
        ],
      ],
      'joinedPlan',
      success([]),
    ]);
  });

  it('offers a joined plan without a file when the folder of shared plans cannot be created, logging why', async () => {
    await writeFile(join(userData, SHARED), 'a file where the folder should be');
    const { answer, logged } = await quietly(() =>
      files.offerRelayPlan({} as WebContents, PLAN, RELAY),
    );
    expect([answer, logged.map((call): unknown => call[0]), tasks]).toEqual([
      { state: STATE, documentId: DOCUMENT_ID, fileName: '', warnings: [], localChanges: null },
      ['The folder of the shared plans could not be created:'],
      [],
    ]);
  });

  it('notes the relay of the plan of a window among the recent projects, keeps it when the file comes first again, and clears it', async () => {
    const path = join(folder, 'Thesis.tasklace');
    const sender = await openedIn(path);
    await files.noteRelay(sender as WebContents, RELAY);
    const noted = await request(IPC_CHANNELS.recentProjects, {});
    const again = await openedIn(path);
    const reopened = await request(IPC_CHANNELS.recentProjects, {});
    await files.noteRelay(again as WebContents, null);
    expect([noted, reopened, await request(IPC_CHANNELS.recentProjects, {})]).toEqual([
      success([{ name: 'Thesis', folder, relay: RELAY }]),
      success([{ name: 'Thesis', folder, relay: RELAY }]),
      success([{ name: 'Thesis', folder, relay: null }]),
    ]);
  });

  it('notes nothing for a window without a project or without a file, and logs a list that cannot be written', async () => {
    const sender = await openedIn(join(folder, 'Thesis.tasklace'));
    await files.noteRelay({} as WebContents, RELAY);
    const unsaved = {};
    const created = await request(IPC_CHANNELS.newProject, unsaved);
    await request(IPC_CHANNELS.adoptProject, unsaved, created);
    const taskCount = tasks.length;
    const refusal = new Error('disk full');
    recording.failure = refusal;
    const { logged } = await quietly(async () => {
      await files.noteRelay(unsaved as WebContents, RELAY);
      await files.noteRelay(sender as WebContents, RELAY);
    }).finally(() => {
      recording.failure = null;
    });
    expect([
      logged,
      tasks.length - taskCount,
      await request(IPC_CHANNELS.recentProjects, {}),
    ]).toEqual([
      [['The relay of a recent project could not be noted:', refusal]],
      0,
      success([{ name: 'Thesis', folder, relay: null }]),
    ]);
  });
});
