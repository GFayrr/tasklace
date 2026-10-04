import { app } from 'electron';
import { IPC_CHANNELS } from '../preload/bridge-contract';
import { isAllowedExternalUrl } from './external-links';
import { handleChannel } from './ipc-channels';
import type { TrustCheck } from './ipc-trust';
import { openInBrowser } from './security';

/** Answers the general requests of the preload bridge, each only from a page of the application and each with its message checked. */
export function registerIpcHandlers(assertTrusted: TrustCheck): void {
  handleChannel(assertTrusted, IPC_CHANNELS.appVersion, () => app.getVersion());
  handleChannel(assertTrusted, IPC_CHANNELS.openExternal, (_event, url) =>
    isAllowedExternalUrl(url) ? openInBrowser(url) : false,
  );
}
