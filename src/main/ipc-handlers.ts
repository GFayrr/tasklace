import { app, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import { isAllowedExternalUrl } from './external-links';
import type { TrustCheck } from './ipc-trust';
import { openInBrowser } from './security';

/** Answers the general requests of the preload bridge, each only from a page of the application and each with its message checked. */
export function registerIpcHandlers(assertTrusted: TrustCheck): void {
  ipcMain.handle(IPC_CHANNELS.appVersion, (event) => {
    assertTrusted(event);
    return app.getVersion();
  });
  ipcMain.handle(IPC_CHANNELS.openExternal, async (event, url: unknown) => {
    assertTrusted(event);
    return isAllowedExternalUrl(url) ? openInBrowser(url) : false;
  });
}
