import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import type { TrustCheck } from './ipc-trust';

const releasers = new WeakMap<WebContents, () => void>();

/** Answers the page telling that it saved what it had to before its window closes. */
export function registerFlushHandler(assertTrusted: TrustCheck): void {
  ipcMain.on(IPC_CHANNELS.flushDone, (event) => {
    assertTrusted(event);
    releasers.get(event.sender)?.();
  });
}

/** Holds the closing of a window until its page has saved its pending changes, a page that crashed or stopped responding letting the window close. */
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
  releasers.set(contents, release);
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
