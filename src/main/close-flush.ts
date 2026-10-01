import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import type { TrustCheck } from './ipc-trust';

interface CloseAnswer {
  readonly release: () => void;
  readonly keepOpen: () => void;
}

const answers = new WeakMap<WebContents, CloseAnswer>();

/** Answers the page telling, once it saved what it had to, whether its window may close, an answer that is not a yes or a no being ignored. */
export function registerFlushHandler(assertTrusted: TrustCheck): void {
  ipcMain.on(IPC_CHANNELS.flushDone, (event, mayClose: unknown) => {
    assertTrusted(event);
    if (typeof mayClose !== 'boolean') {
      return;
    }
    const answer = answers.get(event.sender);
    if (mayClose) {
      answer?.release();
    } else {
      answer?.keepOpen();
    }
  });
}

/** Holds the closing of a window until its page has saved its pending changes and agreed to close, a page that crashed or stopped responding letting the window close. */
export function flushBeforeClosing(window: BrowserWindow): void {
  const contents = window.webContents;
  let requested = false;
  let released = false;
  const release = (): void => {
    if (!released && requested) {
      released = true;
      window.close();
    }
  };
  answers.set(contents, {
    release,
    keepOpen: () => {
      requested = false;
    },
  });
  window.on('close', (event) => {
    if (released) {
      return;
    }
    event.preventDefault();
    if (!requested) {
      requested = true;
      contents.send(IPC_CHANNELS.flushRequested);
    }
  });
  contents.on('render-process-gone', release);
  window.on('unresponsive', release);
}
