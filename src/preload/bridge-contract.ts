import type { CsvWarning } from '../core/exchange/csv/csv-rows';
import type { RegionalFormat } from '../core/exchange/csv/regional-format';
import type { FileError, StateCheckError } from '../core/file/tasklace-file';
import type { PrintDocument } from '../core/print/print-document';
import type { Result } from '../core/result';
import type { DocumentId } from '../core/shared/shared-document';
import type { ValidationIssue } from '../core/validation/validation-issues';

export const IPC_CHANNELS = {
  regionalFormat: 'system:regional-format',
  newProject: 'project:new',
  openProject: 'project:open',
  openRecentProject: 'project:open-recent',
  recentProjects: 'project:recent',
  importProject: 'project:import',
  saveProject: 'project:save',
  saveProjectAs: 'project:save-as',
  exportProject: 'project:export',
  exportPdf: 'project:export-pdf',
  saveHeldPdf: 'project:save-held-pdf',
  exportLighterPdf: 'project:export-lighter-pdf',
  discardHeldPdf: 'project:discard-held-pdf',
  adoptProject: 'project:adopt',
  pageStartFailed: 'page:start-failed',
  flushRequested: 'project:flush-requested',
  flushDone: 'project:flush-done',
} as const;

export type ExchangeKind = 'json' | 'csv';

export type FileFailureCode =
  | FileError['code']
  | StateCheckError['code']
  | 'CANCELLED'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'LOCAL_COPY_FAILED'
  | 'TOO_COMPLEX'
  | 'INVALID_ENCODING'
  | 'INVALID_IMPORT'
  | 'NO_PROJECT'
  | 'MISSING_CHARACTERS'
  | 'PRINT_FAILED'
  | 'PRINT_INCOMPLETE'
  | 'TASK_FAILED';

export const ISSUE_FAILURE_CODES = ['INVALID_PROJECT', 'INVALID_IMPORT', 'INVALID_STATE'] as const;

export type IssueFailureCode = (typeof ISSUE_FAILURE_CODES)[number];

export type FileFailure =
  | { readonly code: IssueFailureCode; readonly issues: readonly ValidationIssue[] }
  | { readonly code: Exclude<FileFailureCode, IssueFailureCode> };

export type BridgeResult<T> = Result<T, FileFailure>;

export type ImportWarning = CsvWarning;

export interface OpenedProject {
  readonly state: Uint8Array;
  readonly documentId: DocumentId;
  readonly fileName: string;
  readonly warnings: readonly ImportWarning[];
}

export interface SavedProject {
  readonly localCopySaved: boolean;
}

export interface ExportedFile {
  readonly fileName: string;
}

export type PdfExport =
  | { readonly kind: 'exported'; readonly fileName: string }
  | { readonly kind: 'heavy'; readonly bytes: number; readonly pages: number };

export interface RecentProject {
  readonly name: string;
  readonly folder: string;
}

export interface TasklaceBridge {
  readonly regionalFormat: () => Promise<RegionalFormat>;
  readonly newProject: () => Promise<DocumentId>;
  readonly openProject: () => Promise<BridgeResult<OpenedProject>>;
  readonly openRecentProject: (index: number) => Promise<BridgeResult<OpenedProject>>;
  readonly recentProjects: () => Promise<BridgeResult<readonly RecentProject[]>>;
  readonly importProject: (kind: ExchangeKind) => Promise<BridgeResult<OpenedProject>>;
  readonly adoptProject: (documentId: DocumentId) => Promise<BridgeResult<null>>;
  readonly saveProject: (state: Uint8Array) => Promise<BridgeResult<SavedProject>>;
  readonly saveProjectAs: (
    state: Uint8Array,
    suggestedName: string,
  ) => Promise<BridgeResult<SavedProject>>;
  readonly exportProject: (
    kind: ExchangeKind,
    text: string,
    suggestedName: string,
  ) => Promise<BridgeResult<ExportedFile>>;
  readonly exportPdf: (
    document: PrintDocument,
    suggestedName: string,
  ) => Promise<BridgeResult<PdfExport>>;
  readonly saveHeldPdf: () => Promise<BridgeResult<ExportedFile>>;
  readonly exportLighterPdf: () => Promise<BridgeResult<ExportedFile>>;
  readonly discardHeldPdf: () => Promise<BridgeResult<null>>;
  readonly onFlushRequested: (flush: () => Promise<boolean>) => void;
  readonly reportStartFailure: () => void;
}

export interface ChannelAnswers {
  readonly [IPC_CHANNELS.regionalFormat]: RegionalFormat;
  readonly [IPC_CHANNELS.newProject]: DocumentId;
  readonly [IPC_CHANNELS.openProject]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.openRecentProject]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.recentProjects]: BridgeResult<readonly RecentProject[]>;
  readonly [IPC_CHANNELS.importProject]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.adoptProject]: BridgeResult<null>;
  readonly [IPC_CHANNELS.saveProject]: BridgeResult<SavedProject>;
  readonly [IPC_CHANNELS.saveProjectAs]: BridgeResult<SavedProject>;
  readonly [IPC_CHANNELS.exportProject]: BridgeResult<ExportedFile>;
  readonly [IPC_CHANNELS.exportPdf]: BridgeResult<PdfExport>;
  readonly [IPC_CHANNELS.saveHeldPdf]: BridgeResult<ExportedFile>;
  readonly [IPC_CHANNELS.exportLighterPdf]: BridgeResult<ExportedFile>;
  readonly [IPC_CHANNELS.discardHeldPdf]: BridgeResult<null>;
}

export interface ChannelArguments {
  readonly [IPC_CHANNELS.regionalFormat]: readonly [];
  readonly [IPC_CHANNELS.newProject]: readonly [];
  readonly [IPC_CHANNELS.openProject]: readonly [];
  readonly [IPC_CHANNELS.openRecentProject]: readonly [index: number];
  readonly [IPC_CHANNELS.recentProjects]: readonly [];
  readonly [IPC_CHANNELS.importProject]: readonly [kind: ExchangeKind];
  readonly [IPC_CHANNELS.adoptProject]: readonly [documentId: DocumentId];
  readonly [IPC_CHANNELS.saveProject]: readonly [state: Uint8Array];
  readonly [IPC_CHANNELS.saveProjectAs]: readonly [state: Uint8Array, suggestedName: string];
  readonly [IPC_CHANNELS.exportProject]: readonly [
    kind: ExchangeKind,
    text: string,
    suggestedName: string,
  ];
  readonly [IPC_CHANNELS.exportPdf]: readonly [document: PrintDocument, suggestedName: string];
  readonly [IPC_CHANNELS.saveHeldPdf]: readonly [];
  readonly [IPC_CHANNELS.exportLighterPdf]: readonly [];
  readonly [IPC_CHANNELS.discardHeldPdf]: readonly [];
}

export type InvokeChannel = keyof ChannelAnswers & keyof ChannelArguments;
export type ResultChannel = {
  [C in InvokeChannel]: ChannelAnswers[C] extends BridgeResult<unknown> ? C : never;
}[InvokeChannel];

export const BRIDGE_NAME = 'tasklace';
