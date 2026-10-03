import { ipcMain as electronIpcMain, type BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import en from '../renderer/locales/en.json';
import { flushBeforeClosing, registerFlushHandler } from './close-flush';
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

beforeEach(() => {
  window = new FakeWindow();
  flushBeforeClosing(window as unknown as BrowserWindow);
  trusted.mockReset();
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

  it('ignores an answer that is not a yes or a no, and an agreement nobody asked for', () => {
    answer(true);
    expect(window.closed).toBe(false);
    window.close();
    answer('yes');
    expect(window.closed).toBe(false);
  });

  it('closes only the window whose page agreed, and ignores an agreement that comes after a refusal', () => {
    const other = new FakeWindow();
    flushBeforeClosing(other as unknown as BrowserWindow);
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

  it('offers to reload it, letting the window close until the new page has loaded, then holding the close again', async () => {
    answerQuestionWith(FIRST_BUTTON);
    window.webContents.emit('render-process-gone');
    await settle();
    expect(questionsShown()).toEqual([en.pageProblems.crashedBody]);
    expect(window.webContents.reloads).toBe(1);
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
    flushBeforeClosing(broken as unknown as BrowserWindow);
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

  it('ignores the message of a page whose window is unknown', () => {
    ipcMain.send(IPC_CHANNELS.pageStartFailed, { sender: {} });
    expect(questions.show).not.toHaveBeenCalled();
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
