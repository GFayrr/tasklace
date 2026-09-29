export const IPC_CHANNELS = {
  appVersion: 'app:version',
  openExternal: 'shell:open-external',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export interface TasklaceBridge {
  readonly appVersion: () => Promise<string>;
  readonly openExternal: (url: string) => Promise<boolean>;
}

export const BRIDGE_NAME = 'tasklace';
