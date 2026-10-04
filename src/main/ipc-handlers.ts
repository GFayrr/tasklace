import { app, ipcMain } from 'electron';
import { IPC_CHANNELS, type ChannelAnswers } from '../preload/bridge-contract';
import { isAllowedExternalUrl } from './external-links';
import type { TrustCheck } from './ipc-trust';
import { openInBrowser } from './security';

/** Answers the general requests of the preload bridge, each only from a page of the application and each with its message checked. */
export function registerIpcHandlers(assertTrusted: TrustCheck): void {
  ipcMain.handle(
    IPC_CHANNELS.appVersion,
    (event): ChannelAnswers[typeof IPC_CHANNELS.appVersion] => {
      assertTrusted(event);
      return app.getVersion();
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.openExternal,
    async (event, url: unknown): Promise<ChannelAnswers[typeof IPC_CHANNELS.openExternal]> => {
      assertTrusted(event);
      return isAllowedExternalUrl(url) ? openInBrowser(url) : false;
    },
  );
}
