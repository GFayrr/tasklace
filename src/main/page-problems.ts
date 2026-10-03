import { dialog, type BrowserWindow } from 'electron';
import { MESSAGES } from './messages';

export type CrashChoice = 'reload' | 'close';
export type UnresponsiveChoice = 'wait' | 'close';

const FIRST_BUTTON = 0;
const SECOND_BUTTON = 1;

/** Asks the user whether to reload a window whose page crashed or could not start, or to close it, reloading when the question is dismissed. */
export async function askAfterPageFailure(
  window: BrowserWindow,
  body: string,
): Promise<CrashChoice> {
  const text = MESSAGES.pageProblems;
  const { response } = await dialog.showMessageBox(window, {
    type: 'error',
    title: text.failedTitle,
    message: text.failedTitle,
    detail: body,
    buttons: [text.reload, text.close],
    defaultId: FIRST_BUTTON,
    cancelId: FIRST_BUTTON,
    noLink: true,
  });
  return response === SECOND_BUTTON ? 'close' : 'reload';
}

/** Asks the user whether to keep waiting for a page that stopped responding while its window closes, or to close it anyway, waiting when the question is dismissed. */
export async function askWhileUnresponsive(window: BrowserWindow): Promise<UnresponsiveChoice> {
  const text = MESSAGES.pageProblems;
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    title: text.unresponsiveTitle,
    message: text.unresponsiveTitle,
    detail: text.unresponsiveBody,
    buttons: [text.wait, text.closeAnyway],
    defaultId: FIRST_BUTTON,
    cancelId: FIRST_BUTTON,
    noLink: true,
  });
  return response === SECOND_BUTTON ? 'close' : 'wait';
}
