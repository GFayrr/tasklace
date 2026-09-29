import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_NAME, IPC_CHANNELS, type TasklaceBridge } from './bridge-contract';

const bridge: TasklaceBridge = {
  appVersion: async () => String(await ipcRenderer.invoke(IPC_CHANNELS.appVersion)),
  openExternal: async (url) => (await ipcRenderer.invoke(IPC_CHANNELS.openExternal, url)) === true,
};

contextBridge.exposeInMainWorld(BRIDGE_NAME, bridge);
