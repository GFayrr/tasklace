import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import { isAllowedExternalUrl } from './external-links';
import { openInBrowser } from './security';

/** Answers the requests of the preload bridge, each only from a page of the application and each with its message checked. */
export function registerIpcHandlers(isTrustedAddress: (address: string) => boolean): void {
  const assertTrusted = (event: IpcMainInvokeEvent): void => {
    const address = event.senderFrame?.url ?? '';
    if (!isTrustedAddress(address)) {
      throw new Error('Request refused: it does not come from a page of the application.');
    }
  };
  ipcMain.handle(IPC_CHANNELS.appVersion, (event) => {
    assertTrusted(event);
    return app.getVersion();
  });
  ipcMain.handle(IPC_CHANNELS.openExternal, async (event, url: unknown) => {
    assertTrusted(event);
    return isAllowedExternalUrl(url) ? openInBrowser(url) : false;
  });
}
