import type { Endpoint } from '../core/collaboration/participants';
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
  keepOwnChanges: 'project:keep-own-changes',
  openKeptChanges: 'project:open-kept-changes',
  exportProject: 'project:export',
  exportPdf: 'project:export-pdf',
  saveHeldPdf: 'project:save-held-pdf',
  exportLighterPdf: 'project:export-lighter-pdf',
  discardHeldPdf: 'project:discard-held-pdf',
  adoptProject: 'project:adopt',
  pageStartFailed: 'page:start-failed',
  flushRequested: 'project:flush-requested',
  flushDone: 'project:flush-done',
  collaborationSettings: 'collaboration:settings',
  saveCollaborationSettings: 'collaboration:save-settings',
  sharePlan: 'collaboration:share',
  stopCollaboration: 'collaboration:stop',
  joinPlan: 'collaboration:join',
  openSharedPlan: 'collaboration:open-shared',
  findPlans: 'collaboration:find-plans',
  dropPeer: 'collaboration:drop-peer',
  copyJoinCode: 'collaboration:copy-join-code',
  findNextHost: 'collaboration:find-next-host',
  collaborationSend: 'collaboration:send',
  collaborationEvent: 'collaboration:event',
} as const;

export type ExchangeKind = 'json' | 'csv';

export type FileFailureCode =
  | FileError['code']
  | StateCheckError['code']
  | 'CANCELLED'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'LOCAL_COPY_FAILED'
  | 'TOO_LARGE_TO_SAVE'
  | 'TOO_COMPLEX'
  | 'INVALID_ENCODING'
  | 'INVALID_IMPORT'
  | 'NO_PROJECT'
  | 'MISSING_CHARACTERS'
  | 'PRINT_FAILED'
  | 'PRINT_INCOMPLETE'
  | 'NO_FREE_PORT'
  | 'LISTEN_FAILED'
  | 'ALREADY_SHARING'
  | 'INVALID_ADDRESS'
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

export interface CollaborationSettings {
  readonly name: string | null;
  readonly port: number;
  readonly firewallNoticeSeen: boolean;
}

export interface Sharing {
  readonly code: string;
  readonly port: number;
  readonly addresses: readonly string[];
  readonly tokenDigest: string;
}

export interface KnownToken {
  readonly participantId: string;
  readonly tokenDigest: string;
}

export interface JoinRequest {
  readonly address: string;
  readonly port: number;
  readonly code: string;
  readonly participantId: string;
  readonly name: string;
}

export interface NextHostCandidate {
  readonly participantId: string;
  readonly rank: number;
  readonly endpoint: Endpoint | null;
}

export interface NearbyPlan {
  readonly key: string;
  readonly planName: string;
  readonly hostName: string;
  readonly addresses: readonly string[];
  readonly port: number;
}

export const GUEST_ENDS = [
  'MALFORMED',
  'UNSUPPORTED_VERSION',
  'INVALID_SHARE',
  'WRONG_CODE',
  'CODE_REPLACED',
  'WRONG_KEY',
  'IDENTITY_TAKEN',
  'REMOVED',
  'HOST_LEFT',
  'TAMPERED',
  'TOO_LARGE',
  'INVALID_CONTENT',
  'WORN_OUT',
  'BROKEN',
  'TIMEOUT',
  'INVALID_INTRODUCTION',
  'WIRE_CLOSED',
  'CLOSED',
  'UNREACHABLE',
  'NOT_PRIVATE',
] as const;

export type GuestEndReason = (typeof GUEST_ENDS)[number];

export type CollaborationEvent =
  | {
      readonly kind: 'peerJoined';
      readonly peer: number;
      readonly participantId: string;
      readonly name: string;
      readonly endpoint: Endpoint;
      readonly tokenDigest: string;
    }
  | { readonly kind: 'peerMessage'; readonly peer: number; readonly message: Uint8Array }
  | { readonly kind: 'peerLeft'; readonly peer: number }
  | { readonly kind: 'codeChanged'; readonly code: string }
  | { readonly kind: 'nearbyPlans'; readonly plans: readonly NearbyPlan[] }
  | { readonly kind: 'connected' }
  | { readonly kind: 'hostMessage'; readonly message: Uint8Array }
  | { readonly kind: 'reconnecting' }
  | { readonly kind: 'hostLeft' }
  | { readonly kind: 'becameHost'; readonly sharing: Sharing }
  | { readonly kind: 'yielded' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'ended'; readonly reason: GuestEndReason };

export type CollaborationTarget = number | 'host';

export interface TasklaceBridge {
  readonly regionalFormat: () => Promise<RegionalFormat>;
  readonly newProject: () => Promise<string>;
  readonly openProject: () => Promise<BridgeResult<OpenedProject>>;
  readonly openRecentProject: (index: number) => Promise<BridgeResult<OpenedProject>>;
  readonly recentProjects: () => Promise<BridgeResult<readonly RecentProject[]>>;
  readonly importProject: (kind: ExchangeKind) => Promise<BridgeResult<OpenedProject>>;
  readonly adoptProject: (documentId: DocumentId) => Promise<BridgeResult<null>>;
  readonly saveProject: (state: Uint8Array) => Promise<BridgeResult<SavedProject>>;
  readonly keepOwnChanges: (state: Uint8Array, planName: string) => Promise<BridgeResult<null>>;
  readonly openKeptChanges: () => Promise<BridgeResult<OpenedProject>>;
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
  readonly collaborationSettings: () => Promise<BridgeResult<CollaborationSettings>>;
  readonly saveCollaborationSettings: (
    settings: CollaborationSettings,
  ) => Promise<BridgeResult<null>>;
  readonly sharePlan: (
    planName: string,
    hostName: string,
    participantId: string,
  ) => Promise<BridgeResult<Sharing>>;
  readonly stopCollaboration: () => Promise<BridgeResult<null>>;
  readonly joinPlan: (request: JoinRequest) => Promise<BridgeResult<null>>;
  readonly openSharedPlan: (state: Uint8Array) => Promise<BridgeResult<OpenedProject>>;
  readonly findPlans: (searching: boolean) => Promise<BridgeResult<null>>;
  readonly dropPeer: (peer: number) => Promise<BridgeResult<null>>;
  readonly copyJoinCode: () => Promise<BridgeResult<null>>;
  readonly findNextHost: (
    queue: readonly NextHostCandidate[],
    planName: string,
    hostName: string,
    knownTokens: readonly KnownToken[],
  ) => Promise<BridgeResult<null>>;
  readonly sendToCollaboration: (to: CollaborationTarget, message: Uint8Array) => void;
  readonly onCollaborationEvent: (listener: (event: CollaborationEvent) => void) => void;
  readonly onFlushRequested: (flush: () => Promise<boolean>) => void;
  readonly reportStartFailure: () => void;
}

export interface ChannelAnswers {
  readonly [IPC_CHANNELS.regionalFormat]: RegionalFormat;
  readonly [IPC_CHANNELS.newProject]: string;
  readonly [IPC_CHANNELS.openProject]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.openRecentProject]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.recentProjects]: BridgeResult<readonly RecentProject[]>;
  readonly [IPC_CHANNELS.importProject]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.adoptProject]: BridgeResult<null>;
  readonly [IPC_CHANNELS.saveProject]: BridgeResult<SavedProject>;
  readonly [IPC_CHANNELS.saveProjectAs]: BridgeResult<SavedProject>;
  readonly [IPC_CHANNELS.keepOwnChanges]: BridgeResult<null>;
  readonly [IPC_CHANNELS.openKeptChanges]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.exportProject]: BridgeResult<ExportedFile>;
  readonly [IPC_CHANNELS.exportPdf]: BridgeResult<PdfExport>;
  readonly [IPC_CHANNELS.saveHeldPdf]: BridgeResult<ExportedFile>;
  readonly [IPC_CHANNELS.exportLighterPdf]: BridgeResult<ExportedFile>;
  readonly [IPC_CHANNELS.discardHeldPdf]: BridgeResult<null>;
  readonly [IPC_CHANNELS.collaborationSettings]: BridgeResult<CollaborationSettings>;
  readonly [IPC_CHANNELS.saveCollaborationSettings]: BridgeResult<null>;
  readonly [IPC_CHANNELS.sharePlan]: BridgeResult<Sharing>;
  readonly [IPC_CHANNELS.stopCollaboration]: BridgeResult<null>;
  readonly [IPC_CHANNELS.joinPlan]: BridgeResult<null>;
  readonly [IPC_CHANNELS.openSharedPlan]: BridgeResult<OpenedProject>;
  readonly [IPC_CHANNELS.findPlans]: BridgeResult<null>;
  readonly [IPC_CHANNELS.dropPeer]: BridgeResult<null>;
  readonly [IPC_CHANNELS.copyJoinCode]: BridgeResult<null>;
  readonly [IPC_CHANNELS.findNextHost]: BridgeResult<null>;
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
  readonly [IPC_CHANNELS.keepOwnChanges]: readonly [state: Uint8Array, planName: string];
  readonly [IPC_CHANNELS.openKeptChanges]: readonly [];
  readonly [IPC_CHANNELS.exportProject]: readonly [
    kind: ExchangeKind,
    text: string,
    suggestedName: string,
  ];
  readonly [IPC_CHANNELS.exportPdf]: readonly [document: PrintDocument, suggestedName: string];
  readonly [IPC_CHANNELS.saveHeldPdf]: readonly [];
  readonly [IPC_CHANNELS.exportLighterPdf]: readonly [];
  readonly [IPC_CHANNELS.discardHeldPdf]: readonly [];
  readonly [IPC_CHANNELS.collaborationSettings]: readonly [];
  readonly [IPC_CHANNELS.saveCollaborationSettings]: readonly [settings: CollaborationSettings];
  readonly [IPC_CHANNELS.sharePlan]: readonly [
    planName: string,
    hostName: string,
    participantId: string,
  ];
  readonly [IPC_CHANNELS.stopCollaboration]: readonly [];
  readonly [IPC_CHANNELS.joinPlan]: readonly [request: JoinRequest];
  readonly [IPC_CHANNELS.openSharedPlan]: readonly [state: Uint8Array];
  readonly [IPC_CHANNELS.findPlans]: readonly [searching: boolean];
  readonly [IPC_CHANNELS.dropPeer]: readonly [peer: number];
  readonly [IPC_CHANNELS.copyJoinCode]: readonly [];
  readonly [IPC_CHANNELS.findNextHost]: readonly [
    queue: readonly NextHostCandidate[],
    planName: string,
    hostName: string,
    knownTokens: readonly KnownToken[],
  ];
}

export type InvokeChannel = keyof ChannelAnswers & keyof ChannelArguments;
export type ResultChannel = {
  [C in InvokeChannel]: ChannelAnswers[C] extends BridgeResult<unknown> ? C : never;
}[InvokeChannel];

export const BRIDGE_NAME = 'tasklace';
