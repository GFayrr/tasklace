import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import type { TrustCheck } from './ipc-trust';
import { MESSAGES } from './messages';
import { askAfterPageFailure, askWhileUnresponsive } from './page-problems';

interface PageWindow {
  readonly release: () => void;
  readonly keepOpen: () => void;
  readonly startFailed: () => void;
}

const answers = new WeakMap<WebContents, PageWindow>();

/** Answers the page telling, once it saved what it had to, whether its window may close, an answer that is not a yes or a no being ignored, and offers to reload a page telling that it could not start. */
export function registerFlushHandler(assertTrusted: TrustCheck): void {
  ipcMain.on(IPC_CHANNELS.pageStartFailed, (event) => {
    assertTrusted(event);
    answers.get(event.sender)?.startFailed();
  });
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

/** Holds the closing of a window until its page has saved its pending changes and agreed to close; a page that crashed lets its window close until a new page has loaded, or offers to reload it when nobody asked to close, and a page that stops responding while asked to save lets the user wait for it or close anyway. */
export function flushBeforeClosing(window: BrowserWindow): void {
  const contents = window.webContents;
  let requested = false;
  let released = false;
  let pageGone = false;
  let unresponsive = false;
  let askingToWait = false;
  const closeNow = (): void => {
    if (!released) {
      released = true;
      window.close();
    }
  };
  const release = (): void => {
    if (requested) {
      closeNow();
    }
  };
  const offerToCloseAnyway = (): void => {
    if (askingToWait) {
      return;
    }
    askingToWait = true;
    askWhileUnresponsive(window)
      .then((choice) => {
        if (choice === 'close') {
          closeNow();
        }
      })
      .catch((error: unknown) => {
        console.error('The question about a page not responding could not be shown:', error);
      })
      .finally(() => {
        askingToWait = false;
      });
  };
  answers.set(contents, {
    release,
    keepOpen: () => {
      requested = false;
    },
    startFailed: () => {
      offerReload(window, MESSAGES.pageProblems.startFailedBody);
    },
  });
  window.on('close', (event) => {
    if (released || pageGone) {
      released = true;
      return;
    }
    event.preventDefault();
    if (!requested) {
      requested = true;
      contents.send(IPC_CHANNELS.flushRequested);
    }
    if (unresponsive) {
      offerToCloseAnyway();
    }
  });
  contents.on('render-process-gone', () => {
    pageGone = true;
    if (requested) {
      closeNow();
      return;
    }
    offerReload(window, MESSAGES.pageProblems.crashedBody);
  });
  contents.on('did-finish-load', () => {
    pageGone = false;
  });
  window.on('unresponsive', () => {
    unresponsive = true;
    if (requested) {
      offerToCloseAnyway();
    }
  });
  window.on('responsive', () => {
    unresponsive = false;
  });
}

/** Asks whether to reload a window whose page failed, or to close it, reloading only once the failure has been handled and closing the window when the question cannot be shown. */
function offerReload(window: BrowserWindow, body: string): void {
  askAfterPageFailure(window, body)
    .then((choice) => {
      if (window.isDestroyed()) {
        return;
      }
      if (choice === 'close') {
        window.close();
        return;
      }
      setImmediate(() => {
        if (!window.isDestroyed()) {
          window.webContents.reload();
        }
      });
    })
    .catch((error: unknown) => {
      console.error('The question about a failed page could not be shown:', error);
      window.destroy();
    });
}
