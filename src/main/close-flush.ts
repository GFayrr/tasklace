import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import type { TrustCheck } from './ipc-trust';
import { MESSAGES } from './messages';
import { askAfterPageFailure, askWhileUnresponsive } from './page-problems';
import type { WindowProjectKind } from './project-files';

interface PageWindow {
  readonly release: () => void;
  readonly keepOpen: () => void;
  readonly startFailed: () => void;
}

const answers = new WeakMap<WebContents, PageWindow>();
const ABORTED_LOAD = -3;
const CRASHED_BODIES: Readonly<Record<WindowProjectKind, string>> = {
  none: MESSAGES.pageProblems.crashedWithoutProjectBody,
  withFile: MESSAGES.pageProblems.crashedBody,
  withoutFile: MESSAGES.pageProblems.crashedWithoutFileBody,
};

/** Answers the page telling whether its window may close once its changes are saved, logging any other answer and keeping the window open so that the next close asks again, and offers to reload a page that could not start. */
export function registerFlushHandler(assertTrusted: TrustCheck): void {
  ipcMain.on(IPC_CHANNELS.pageStartFailed, (event) => {
    assertTrusted(event);
    windowOf(event.sender, IPC_CHANNELS.pageStartFailed)?.startFailed();
  });
  ipcMain.on(IPC_CHANNELS.flushDone, (event, mayClose: unknown) => {
    assertTrusted(event);
    const answer = windowOf(event.sender, IPC_CHANNELS.flushDone);
    if (typeof mayClose !== 'boolean') {
      console.error(
        'The page answered a close request with something else than yes or no:',
        mayClose,
      );
      answer?.keepOpen();
      return;
    }
    if (mayClose) {
      answer?.release();
    } else {
      answer?.keepOpen();
    }
  });
}

/** Returns how the window of a page answers its messages, logging a message from a page whose window is not followed. */
function windowOf(sender: WebContents, channel: string): PageWindow | undefined {
  const known = answers.get(sender);
  if (known === undefined) {
    console.warn(`A page whose window is not followed sent ${channel}.`);
  }
  return known;
}

/** Holds the closing of a window until its page has saved its pending changes and agreed to close; a page that crashed, could not load or lost its bridge lets its window close and, when nobody asked to close, is offered a reload that forgets its project, and a page that stops responding while asked to save lets the user wait for it or close anyway. */
export function flushBeforeClosing(
  window: BrowserWindow,
  projectKind: (contents: WebContents) => WindowProjectKind,
  forgetProject: (contents: WebContents) => void,
): void {
  const contents = window.webContents;
  let requested = false;
  let released = false;
  let pageGone = false;
  let bridgeMissing = false;
  let unresponsive = false;
  let askingToWait = false;
  /** Closes the window once, letting it close for good. */
  const closeNow = (): void => {
    if (!released) {
      released = true;
      window.close();
    }
  };
  /** Closes the window if a close was asked while its page was saving. */
  const release = (): void => {
    if (requested) {
      closeNow();
    }
  };
  /** Offers once to close a window whose page no longer answers, closing it if the user agrees. */
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
      offerReload(window, MESSAGES.pageProblems.startFailedBody, forgetProject);
    },
  });
  window.on('close', (event) => {
    if (released || pageGone || bridgeMissing) {
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
  contents.on('render-process-gone', (_event, details: unknown) => {
    console.error('The page of a window stopped:', details);
    pageGone = true;
    if (requested) {
      closeNow();
      return;
    }
    offerReload(window, CRASHED_BODIES[projectKind(contents)], forgetProject);
  });
  contents.on('did-start-loading', () => {
    bridgeMissing = false;
  });
  contents.on('did-finish-load', () => {
    pageGone = false;
  });
  contents.on(
    'did-fail-load',
    (_event, code: number, description: string, address: string, isMainFrame: boolean) => {
      console.error(
        `The page of a window could not load ${address}: ${description} (${String(code)}).`,
      );
      if (isMainFrame && code !== ABORTED_LOAD) {
        pageGone = true;
        offerReload(window, MESSAGES.pageProblems.startFailedBody, forgetProject);
      }
    },
  );
  contents.on('preload-error', (_event, path: string, error: unknown) => {
    console.error(`The bridge of a page could not load (${path}):`, error);
    bridgeMissing = true;
    offerReload(window, MESSAGES.pageProblems.startFailedBody, forgetProject);
  });
  window.on('unresponsive', () => {
    console.warn('The page of a window stopped responding.');
    unresponsive = true;
    if (requested) {
      offerToCloseAnyway();
    }
  });
  window.on('responsive', () => {
    if (unresponsive) {
      console.warn('The page of a window responds again.');
    }
    unresponsive = false;
  });
}

/** Asks whether to reload a window whose page failed, or to close it, reloading only once the failure has been handled, after forgetting the project of the window, and closing the window when the question cannot be shown. */
function offerReload(
  window: BrowserWindow,
  body: string,
  forgetProject: (contents: WebContents) => void,
): void {
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
          forgetProject(window.webContents);
          window.webContents.reload();
        }
      });
    })
    .catch((error: unknown) => {
      console.error('The question about a failed page could not be shown:', error);
      window.destroy();
    });
}
