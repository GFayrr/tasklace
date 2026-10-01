import type { RegionalFormat } from '../core/exchange/csv/regional-format';
import type { FileError } from '../core/file/tasklace-file';
import type { ValidationIssue } from '../core/validation/validation-issues';

export const IPC_CHANNELS = {
  appVersion: 'app:version',
  openExternal: 'shell:open-external',
  regionalFormat: 'system:regional-format',
  newProject: 'project:new',
  openProject: 'project:open',
  openRecentProject: 'project:open-recent',
  recentProjects: 'project:recent',
  importProject: 'project:import',
  saveProject: 'project:save',
  saveProjectAs: 'project:save-as',
  exportProject: 'project:export',
  flushRequested: 'project:flush-requested',
  flushDone: 'project:flush-done',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type ExchangeKind = 'json' | 'csv';

export type FileFailureCode =
  | FileError['code']
  | 'CANCELLED'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'TOO_COMPLEX'
  | 'INVALID_ENCODING'
  | 'INVALID_IMPORT'
  | 'NO_PROJECT'
  | 'TASK_FAILED';

export interface FileFailure {
  readonly code: FileFailureCode;
  readonly issues?: readonly ValidationIssue[];
}

export type BridgeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: FileFailure };

export interface ImportWarning {
  readonly path: string;
  readonly code: string;
}

export interface OpenedProject {
  readonly state: Uint8Array;
  readonly name: string;
  readonly warnings: readonly ImportWarning[];
}

export interface RecentProject {
  readonly name: string;
  readonly folder: string;
}

export interface TasklaceBridge {
  readonly appVersion: () => Promise<string>;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly regionalFormat: () => Promise<RegionalFormat>;
  readonly newProject: () => Promise<string>;
  readonly openProject: () => Promise<BridgeResult<OpenedProject>>;
  readonly openRecentProject: (index: number) => Promise<BridgeResult<OpenedProject>>;
  readonly recentProjects: () => Promise<readonly RecentProject[]>;
  readonly importProject: (kind: ExchangeKind) => Promise<BridgeResult<OpenedProject>>;
  readonly saveProject: (state: Uint8Array) => Promise<BridgeResult<null>>;
  readonly saveProjectAs: (state: Uint8Array) => Promise<BridgeResult<null>>;
  readonly exportProject: (kind: ExchangeKind, text: string) => Promise<BridgeResult<null>>;
  readonly onFlushRequested: (flush: () => Promise<boolean>) => void;
}

export const BRIDGE_NAME = 'tasklace';
