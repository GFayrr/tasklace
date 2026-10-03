import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain as electronIpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FILE_BYTES } from '../core/limits';
import { failure, success } from '../core/result';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import type { FileTask, FileTaskResult } from './file-tasks';
import { RefusedRequest } from './ipc-trust';
import { registerProjectFileHandlers } from './project-files';
import type { FakeIpcMain } from './testing/fake-electron';

const dialogs = vi.hoisted(() => ({
  open: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
  save: vi.fn<() => Promise<{ canceled: boolean; filePath: string }>>(),
  message: vi.fn<() => Promise<{ response: number }>>(),
  window: { value: null as object | null },
}));

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
const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const LOADED = { kind: 'loaded', state: STATE, documentId: DOCUMENT_ID, warnings: [] } as const;
const SAVED = { kind: 'saved', localCopySaved: true } as const;
const tasks: FileTask[] = [];
const runTask = vi.fn<(task: FileTask) => Promise<FileTaskResult>>();
const trusted = vi.fn();
let folder: string;
let userData: string;

registerProjectFileHandlers({
  assertTrusted: trusted,
  runTask: (task) => {
    tasks.push(task);
    return runTask(task);
  },
  get userDataFolder() {
    return userData;
  },
});

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
  it('opens a chosen project file, tells its name, and remembers it once the page adopts it', async () => {
    const path = join(folder, 'Thesis.tasklace');
    const sender = {};
    await writeFile(path, 'project');
    chooseToOpen(path);
    runTask.mockResolvedValueOnce(success({ ...LOADED, warnings: [{ path: '', code: 'X' }] }));
    expect(await request(IPC_CHANNELS.openProject, sender)).toEqual({
      ok: true,
      value: {
        state: STATE,
        documentId: DOCUMENT_ID,
        name: 'Thesis',
        fileName: 'Thesis.tasklace',
        warnings: [{ path: '', code: 'X' }],
      },
    });
    expect(tasks).toEqual([{ kind: 'openProject', path }]);
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual([]);
    expect(await request(IPC_CHANNELS.adoptProject, sender, DOCUMENT_ID)).toEqual(success(null));
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual([{ name: 'Thesis', folder }]);
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
    chooseToOpen(broken);
    expect(await request(IPC_CHANNELS.openProject, {})).toEqual(failure({ code: 'TASK_FAILED' }));
    expect(tasks).toHaveLength(2);
  });

  it('opens a recent project by its position, refusing a position that is not a whole number', async () => {
    const path = join(folder, 'Plan.tasklace');
    await openedIn(path);
    runTask.mockResolvedValueOnce(success(LOADED));
    expect(await request(IPC_CHANNELS.openRecentProject, {}, 0)).toMatchObject({ ok: true });
    expect(tasks.at(-1)).toEqual({ kind: 'openProject', path });
    expect(await request(IPC_CHANNELS.openRecentProject, {}, 2)).toEqual(
      failure({ code: 'READ_FAILED' }),
    );
    await expect(request(IPC_CHANNELS.openRecentProject, {}, 'first')).rejects.toThrow(
      RefusedRequest,
    );
  });

  it('opens a project even when the recent list cannot be read or written, logging why and listing none', async () => {
    await mkdir(join(userData, 'recent-projects.json'));
    const opened = await quietly(() => openedIn(join(folder, 'Plan.tasklace')));
    expect(opened.logged).toEqual([
      ['The recent projects could not be recorded:', expect.objectContaining({ code: 'EISDIR' })],
    ]);
    const listed = await quietly(() => request(IPC_CHANNELS.recentProjects, {}));
    expect(listed.answer).toEqual([]);
    expect(listed.logged).toEqual([
      ['The recent projects could not be read:', expect.objectContaining({ code: 'EISDIR' })],
    ]);
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
      [IPC_CHANNELS.recentProjects],
      [IPC_CHANNELS.importProject, 'json'],
      [IPC_CHANNELS.saveProject, STATE],
      [IPC_CHANNELS.saveProjectAs, STATE, 'Plan'],
      [IPC_CHANNELS.exportProject, 'json', '{}', 'Plan'],
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
    expect(await request(IPC_CHANNELS.adoptProject, sender, DOCUMENT_ID)).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
    const documentId = await request(IPC_CHANNELS.newProject, sender);
    expect(await request(IPC_CHANNELS.adoptProject, sender, OTHER_ID)).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
    expect(await request(IPC_CHANNELS.saveProject, sender, STATE)).toEqual(
      failure({ code: 'NO_PROJECT' }),
    );
    expect(await request(IPC_CHANNELS.adoptProject, sender, documentId)).toEqual(success(null));
    expect(await request(IPC_CHANNELS.adoptProject, sender, documentId)).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
    await expect(request(IPC_CHANNELS.adoptProject, sender, '../escape')).rejects.toThrow(
      RefusedRequest,
    );
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual([]);
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
        savedAt: expect.any(Number) as number,
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
      value: { name: 'Launch', fileName: 'Launch.json' },
    });
    const imported = tasks.at(-1);
    const documentId = imported?.kind === 'importJson' ? imported.documentId : '';
    expect(await request(IPC_CHANNELS.adoptProject, sender, documentId)).toEqual(success(null));
    await request(IPC_CHANNELS.saveProject, sender, STATE);
    expect(tasks.at(-1)).toMatchObject({ kind: 'saveProject', path: null, documentId });
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual([]);
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
    expect(await request(IPC_CHANNELS.saveProject, {}, STATE)).toEqual(
      failure({ code: 'NO_PROJECT' }),
    );
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
    expect(await request(IPC_CHANNELS.recentProjects, {})).toEqual([
      { name: 'New', folder },
      { name: 'Old', folder },
    ]);
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
    expect(dialogs.message).toHaveBeenCalledWith(
      dialogs.window.value,
      expect.objectContaining({ message: expect.stringContaining('Taken.tasklace') as string }),
    );
    dialogs.window.value = null;
    chooseToSave(join(folder, 'Taken'));
    dialogs.message.mockResolvedValueOnce({ response: 0 });
    expect(await request(IPC_CHANNELS.saveProjectAs, sender, STATE, 'Plan')).toEqual(
      success({ localCopySaved: true }),
    );
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

  it('turns a save answered by something else than a save into a task failure', async () => {
    const sender = await openedIn(join(folder, 'Old.tasklace'));
    runTask.mockResolvedValueOnce(success(LOADED));
    expect(await request(IPC_CHANNELS.saveProject, sender, STATE)).toEqual(
      failure({ code: 'TASK_FAILED' }),
    );
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

  it('refuses an invalid request, and reports a cancelled or failed export', async () => {
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
