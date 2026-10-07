import { ipcMain as electronIpcMain, type BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import en from '../renderer/locales/en.json';
import { flushBeforeClosing, registerFlushHandler } from './close-flush';
import type { WindowProjectKind } from './project-files';
import { FakeIpcMain, FakeWindow } from './testing/fake-electron';

const questions = vi.hoisted(() => ({
  show: vi.fn<(window: unknown, options: { detail: string }) => Promise<{ response: number }>>(),
}));

vi.mock('electron', async () => {
  const fakes = await import('./testing/fake-electron');
  return {
    ipcMain: new fakes.FakeIpcMain(),
    dialog: { showMessageBox: questions.show },
  };
});

const ipcMain = electronIpcMain as unknown as FakeIpcMain;
const trusted = vi.fn();
const forget = vi.fn();
const FIRST_BUTTON = 0;
const SECOND_BUTTON = 1;
const MICROTASK_STEPS = 10;
registerFlushHandler(trusted);

let window: FakeWindow;

/** Answers the close request of the window from its page. */
function answer(mayClose: unknown): void {
  ipcMain.send(IPC_CHANNELS.flushDone, { sender: window.webContents }, mayClose);
}

/** Makes the next question shown to the user be answered with a button. */
function answerQuestionWith(button: number): void {
  questions.show.mockResolvedValueOnce({ response: button });
}

/** Lets the questions shown, their answers and the reloads they start settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Returns the details of the questions shown to the user, in order. */
function questionsShown(): string[] {
  return questions.show.mock.calls.map(([, options]) => options.detail);
}

const projectKind: { current: WindowProjectKind } = { current: 'withFile' };

beforeEach(() => {
  projectKind.current = 'withFile';
  window = new FakeWindow();
  flushBeforeClosing(window as unknown as BrowserWindow, () => projectKind.current, forget);
  trusted.mockReset();
  forget.mockReset();
  questions.show.mockReset();
});

describe('flushBeforeClosing', () => {
  it('holds the window open and asks its page to save, only once until the page answers', () => {
    window.close();
    window.close();
    expect(window.closed).toBe(false);
    expect(window.webContents.sent).toEqual([IPC_CHANNELS.flushRequested]);
  });

  it('closes the window once its page agrees, checking that the answer comes from the application', () => {
    window.close();
    answer(true);
    expect(window.closed).toBe(true);
    expect(trusted).toHaveBeenCalledTimes(1);
  });

  it('keeps the window open when its page refuses, and asks again on the next close', () => {
    window.close();
    answer(false);
    expect(window.closed).toBe(false);
    window.close();
    expect(window.webContents.sent).toEqual([
      IPC_CHANNELS.flushRequested,
      IPC_CHANNELS.flushRequested,
    ]);
  });

  it('ignores an agreement nobody asked for, and keeps the window open after an answer that is not a yes or a no, asking again on the next close', () => {
    answer(true);
    expect(window.closed).toBe(false);
    window.close();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      answer('yes');
      expect(logged).toHaveBeenCalledWith(
        'The page answered a close request with something else than yes or no:',
        'yes',
      );
    } finally {
      logged.mockRestore();
    }
    expect(window.closed).toBe(false);
    window.close();
    expect(window.webContents.sent).toEqual([
      IPC_CHANNELS.flushRequested,
      IPC_CHANNELS.flushRequested,
    ]);
    answer(true);
    expect(window.closed).toBe(true);
  });

  it('closes only the window whose page agreed, and ignores an agreement that comes after a refusal', () => {
    const other = new FakeWindow();
    flushBeforeClosing(other as unknown as BrowserWindow, () => 'withFile', forget);
    window.close();
    other.close();
    ipcMain.send(IPC_CHANNELS.flushDone, { sender: other.webContents }, true);
    expect(other.closed).toBe(true);
    expect(window.closed).toBe(false);
    answer(false);
    answer(true);
    expect(window.closed).toBe(false);
  });

  it('refuses an answer that does not come from the application', () => {
    trusted.mockImplementation(() => {
      throw new Error('Request refused');
    });
    window.close();
    expect(() => {
      answer(true);
    }).toThrow('Request refused');
    expect(window.closed).toBe(false);
  });
});

describe('a page that crashes', () => {
  it('closes its window at once while it was asked to save, without asking anything', () => {
    window.close();
    window.webContents.emit('render-process-gone');
    expect(window.closed).toBe(true);
    expect(questions.show).not.toHaveBeenCalled();
  });

  it.each([
    ['withFile', en.pageProblems.crashedBody],
    ['withoutFile', en.pageProblems.crashedWithoutFileBody],
    ['none', en.pageProblems.crashedWithoutProjectBody],
  ] as const)('tells what a crash loses for a window holding %s', async (kind, body) => {
    projectKind.current = kind;
    answerQuestionWith(FIRST_BUTTON);
    window.webContents.emit('render-process-gone');
    await settle();
    expect(questionsShown()).toEqual([body]);
  });

  it('offers to reload it, letting the window close until the new page has loaded, then holding the close again', async () => {
    answerQuestionWith(FIRST_BUTTON);
    window.webContents.emit('render-process-gone');
    await settle();
    expect(questionsShown()).toEqual([en.pageProblems.crashedBody]);
    expect(window.webContents.reloads).toBe(1);
    expect(forget.mock.calls).toEqual([[window.webContents]]);
    window.webContents.emit('did-finish-load');
    window.close();
    expect(window.closed).toBe(false);
    expect(window.webContents.sent).toEqual([IPC_CHANNELS.flushRequested]);
  });

  it('lets the window close when the reloaded page never loads', async () => {
    answerQuestionWith(FIRST_BUTTON);
    window.webContents.emit('render-process-gone');
    await settle();
    expect(window.webContents.reloads).toBe(1);
    window.close();
    expect(window.closed).toBe(true);
    expect(window.webContents.sent).toEqual([]);
  });

  it('does not reload a window destroyed before the reload starts', async () => {
    answerQuestionWith(FIRST_BUTTON);
    window.webContents.emit('render-process-gone');
    for (let step = 0; step < MICROTASK_STEPS; step += 1) {
      await Promise.resolve();
    }
    expect(window.webContents.reloads).toBe(0);
    window.destroy();
    await settle();
    expect(window.webContents.reloads).toBe(0);
    expect(forget).not.toHaveBeenCalled();
  });

  it('offers to close its window instead, which then closes without asking the page', async () => {
    answerQuestionWith(SECOND_BUTTON);
    window.webContents.emit('render-process-gone');
    await settle();
    expect(window.closed).toBe(true);
    expect(window.webContents.reloads).toBe(0);
    expect(window.webContents.sent).toEqual([]);
  });

  it('lets its window close while the question is still shown', () => {
    questions.show.mockReturnValueOnce(new Promise(() => undefined));
    window.webContents.emit('render-process-gone');
    window.close();
    expect(window.closed).toBe(true);
  });

  it('does nothing more once the window is gone, and destroys the window when the question cannot be shown', async () => {
    answerQuestionWith(FIRST_BUTTON);
    window.webContents.emit('render-process-gone');
    window.destroy();
    await settle();
    expect(window.webContents.reloads).toBe(0);
    const broken = new FakeWindow();
    flushBeforeClosing(broken as unknown as BrowserWindow, () => 'withFile', forget);
    questions.show.mockRejectedValueOnce(new Error('no dialog'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      broken.webContents.emit('render-process-gone');
      await settle();
      expect(logged).toHaveBeenCalledWith(
        'The question about a failed page could not be shown:',
        new Error('no dialog'),
      );
    } finally {
      logged.mockRestore();
    }
    expect(broken.destroyed).toBe(true);
  });
});

describe('a page that could not start', () => {
  it('offers to reload it or to close its window, checking that the message comes from the application', async () => {
    answerQuestionWith(FIRST_BUTTON);
    ipcMain.send(IPC_CHANNELS.pageStartFailed, { sender: window.webContents });
    await settle();
    expect(questionsShown()).toEqual([en.pageProblems.startFailedBody]);
    expect(window.webContents.reloads).toBe(1);
    expect(trusted).toHaveBeenCalledTimes(1);
    answerQuestionWith(SECOND_BUTTON);
    ipcMain.send(IPC_CHANNELS.pageStartFailed, { sender: window.webContents });
    await settle();
    expect(window.webContents.sent).toEqual([IPC_CHANNELS.flushRequested]);
    answer(true);
    expect(window.closed).toBe(true);
  });

  it('ignores the messages of a page whose window is unknown, logging them', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      ipcMain.send(IPC_CHANNELS.pageStartFailed, { sender: {} });
      ipcMain.send(IPC_CHANNELS.flushDone, { sender: {} }, true);
      expect(warned.mock.calls).toEqual([
        [`A page whose window is not followed sent ${IPC_CHANNELS.pageStartFailed}.`],
        [`A page whose window is not followed sent ${IPC_CHANNELS.flushDone}.`],
      ]);
    } finally {
      warned.mockRestore();
    }
    expect(questions.show).not.toHaveBeenCalled();
  });
});

describe('a page that fails', () => {
  /** Runs a step while recording what it logs, without showing it. */
  async function logsOf(step: () => Promise<void> | void): Promise<unknown[][]> {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await step();
      return [...errors.mock.calls, ...warnings.mock.calls];
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  }

  it('logs why a page crashed', async () => {
    answerQuestionWith(FIRST_BUTTON);
    const details = { reason: 'crashed', exitCode: 133 };
    const logged = await logsOf(async () => {
      window.webContents.emit('render-process-gone', {}, details);
      await settle();
    });
    expect(logged).toEqual([['The page of a window stopped:', details]]);
  });

  it('logs a page that could not load and offers to reload it, unless the load was only aborted or concerned a frame', async () => {
    const logged = await logsOf(async () => {
      answerQuestionWith(FIRST_BUTTON);
      window.webContents.emit(
        'did-fail-load',
        {},
        -6,
        'ERR_FILE_NOT_FOUND',
        'app://tasklace/',
        true,
      );
      await settle();
      window.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'app://tasklace/', true);
      window.webContents.emit(
        'did-fail-load',
        {},
        -6,
        'ERR_FILE_NOT_FOUND',
        'app://tasklace/x',
        false,
      );
      await settle();
    });
    expect(logged).toEqual([
      ['The page of a window could not load app://tasklace/: ERR_FILE_NOT_FOUND (-6).'],
      ['The page of a window could not load app://tasklace/: ERR_ABORTED (-3).'],
      ['The page of a window could not load app://tasklace/x: ERR_FILE_NOT_FOUND (-6).'],
    ]);
    expect(questionsShown()).toEqual([en.pageProblems.startFailedBody]);
    expect([window.webContents.reloads, forget.mock.calls]).toEqual([1, [[window.webContents]]]);
    window.close();
    expect([window.closed, window.webContents.sent]).toEqual([true, []]);
  });

  it('holds the close again once a reload starts after the bridge could not load', async () => {
    await logsOf(async () => {
      answerQuestionWith(FIRST_BUTTON);
      window.webContents.emit('preload-error', {}, '/app/preload.cjs', new Error('bridge failed'));
      await settle();
    });
    expect(window.webContents.reloads).toBe(1);
    window.webContents.emit('did-start-loading');
    window.close();
    expect([window.closed, window.webContents.sent]).toEqual([
      false,
      [IPC_CHANNELS.flushRequested],
    ]);
  });

  it('logs a bridge that could not load and offers to reload the page, letting its window close', async () => {
    const error = new Error('bridge failed');
    const logged = await logsOf(async () => {
      answerQuestionWith(SECOND_BUTTON);
      window.webContents.emit('preload-error', {}, '/app/preload.cjs', error);
      await settle();
    });
    expect(logged).toEqual([['The bridge of a page could not load (/app/preload.cjs):', error]]);
    expect(questionsShown()).toEqual([en.pageProblems.startFailedBody]);
    expect([window.closed, window.webContents.sent]).toEqual([true, []]);
  });

  it('logs a page that stops responding, then responds again', async () => {
    const logged = await logsOf(() => {
      window.emit('responsive');
      window.emit('unresponsive');
      window.emit('responsive');
    });
    expect(logged).toEqual([
      ['The page of a window stopped responding.'],
      ['The page of a window responds again.'],
    ]);
  });
});

describe('a page that stops responding', () => {
  it('asks whether to wait while it was asked to save, closing anyway when the user chooses so', async () => {
    window.close();
    answerQuestionWith(SECOND_BUTTON);
    window.emit('unresponsive');
    await settle();
    expect(questionsShown()).toEqual([en.pageProblems.unresponsiveBody]);
    expect(window.closed).toBe(true);
  });

  it('keeps waiting when the user chooses so, asking again on the next close while it still does not respond', async () => {
    window.close();
    answerQuestionWith(FIRST_BUTTON);
    window.emit('unresponsive');
    await settle();
    expect(window.closed).toBe(false);
    answerQuestionWith(SECOND_BUTTON);
    window.close();
    await settle();
    expect(questions.show).toHaveBeenCalledTimes(2);
    expect(window.closed).toBe(true);
  });

  it('asks as soon as the window is closed when it stopped responding before, and only once at a time', async () => {
    window.emit('unresponsive');
    expect(questions.show).not.toHaveBeenCalled();
    questions.show.mockReturnValueOnce(new Promise(() => undefined));
    window.close();
    window.close();
    window.emit('unresponsive');
    await settle();
    expect(questions.show).toHaveBeenCalledTimes(1);
    expect(window.closed).toBe(false);
  });

  it('asks nothing once the page responds again, and logs a question that cannot be shown', async () => {
    window.emit('unresponsive');
    window.emit('responsive');
    window.close();
    expect(questions.show).not.toHaveBeenCalled();
    questions.show.mockRejectedValueOnce(new Error('no dialog'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      window.emit('unresponsive');
      await settle();
      expect(logged).toHaveBeenCalledWith(
        'The question about a page not responding could not be shown:',
        new Error('no dialog'),
      );
    } finally {
      logged.mockRestore();
    }
    expect(window.closed).toBe(false);
  });
});
