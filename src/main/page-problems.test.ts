import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../renderer/locales/en.json';

const dialogs = vi.hoisted(() => ({
  message: vi.fn<(...values: unknown[]) => Promise<{ response: number }>>(),
}));

vi.mock('electron', () => ({
  dialog: { showMessageBox: dialogs.message },
}));

const { askAfterPageFailure, askWhileUnresponsive } = await import('./page-problems');

const WINDOW = { id: 1 } as unknown as BrowserWindow;
const BODY = 'The page stopped.';

beforeEach(() => {
  dialogs.message.mockReset();
});

/** Answers the next question with a button, or as if it were dismissed when that button is the cancel one. */
function answerWith(response: number): void {
  dialogs.message.mockResolvedValueOnce({ response });
}

describe('askAfterPageFailure', () => {
  it('asks to reload or close through the window, a dismissed question reloading', async () => {
    answerWith(0);
    expect(await askAfterPageFailure(WINDOW, BODY)).toBe('reload');
    answerWith(1);
    expect(await askAfterPageFailure(WINDOW, BODY)).toBe('close');
    expect(dialogs.message.mock.calls[0]).toEqual([
      WINDOW,
      {
        type: 'error',
        title: en.pageProblems.failedTitle,
        message: en.pageProblems.failedTitle,
        detail: BODY,
        buttons: [en.pageProblems.reload, en.pageProblems.close],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      },
    ]);
  });
});

describe('askWhileUnresponsive', () => {
  it('asks to wait or close anyway through the window, a dismissed question waiting', async () => {
    answerWith(0);
    expect(await askWhileUnresponsive(WINDOW)).toBe('wait');
    answerWith(1);
    expect(await askWhileUnresponsive(WINDOW)).toBe('close');
    expect(dialogs.message.mock.calls[0]).toEqual([
      WINDOW,
      {
        type: 'warning',
        title: en.pageProblems.unresponsiveTitle,
        message: en.pageProblems.unresponsiveTitle,
        detail: en.pageProblems.unresponsiveBody,
        buttons: [en.pageProblems.wait, en.pageProblems.closeAnyway],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      },
    ]);
  });
});
